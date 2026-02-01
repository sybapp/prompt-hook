type ChatCompletionMessage = {
  role: "developer" | "system" | "user" | "assistant" | "tool";
  content?: unknown;
};

type ChatCompletionsRequestBody = {
  model?: string;
  messages?: ChatCompletionMessage[];
  stream?: boolean;
  [key: string]: unknown;
};

type Env = {
  DB: D1Database;
  UPSTREAM_BASE_URL?: string;
};

type ChatCompletionChoice = {
  index?: number;
  message?: { content?: unknown } | null;
  delta?: { content?: unknown } | null;
};

type ChatCompletionResponseBody = {
  choices?: ChatCompletionChoice[];
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function corsHeaders(): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type, openai-organization, openai-project, openai-beta");
  headers.set("access-control-max-age", "86400");
  return headers;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      if (type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }

  const maybeText = (content as { text?: unknown }).text;
  if (typeof maybeText === "string") return maybeText;
  return "";
}

function extractPrompts(messages: ChatCompletionMessage[] | undefined): { systemPrompt: string; userPrompt: string } {
  const systemParts: string[] = [];
  const userParts: string[] = [];

  for (const message of messages ?? []) {
    const text = extractText(message.content);
    if (!text) continue;

    if (message.role === "system" || message.role === "developer") systemParts.push(text);
    if (message.role === "user") userParts.push(text);
  }

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    userPrompt: userParts.join("\n\n").trim()
  };
}

function pickForwardHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  const auth = incoming.get("authorization");
  if (auth) headers.set("authorization", auth);
  headers.set("content-type", "application/json");

  for (const name of ["openai-organization", "openai-project", "openai-beta"]) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function mergeHeaders(base: Headers, extra: Headers): Headers {
  const merged = new Headers(base);
  extra.forEach((value, key) => merged.set(key, value));
  return merged;
}

function mergeChoiceTexts(choiceTexts: Map<number, string>): string {
  const indices = [...choiceTexts.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  for (const index of indices) {
    const value = choiceTexts.get(index);
    if (!value) continue;
    if (indices.length === 1) parts.push(value);
    else parts.push(`--- choice ${index} ---\n${value}`);
  }
  return parts.join("\n\n").trim();
}

function extractAssistantTextFromResponse(body: ChatCompletionResponseBody): string {
  const choiceTexts = new Map<number, string>();
  for (const choice of body.choices ?? []) {
    const index = typeof choice.index === "number" ? choice.index : 0;
    const content = choice.message?.content ?? null;
    const text = extractText(content);
    if (!text) continue;
    choiceTexts.set(index, (choiceTexts.get(index) ?? "") + text);
  }
  return mergeChoiceTexts(choiceTexts);
}

async function extractAssistantTextFromStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  const choiceTexts = new Map<number, string>();

  const findDelimiter = (text: string): { index: number; length: number } | null => {
    const lf = text.indexOf("\n\n");
    const crlf = text.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return null;
    if (lf === -1) return { index: crlf, length: 4 };
    if (crlf === -1) return { index: lf, length: 2 };
    return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
  };

  const flushEvent = (eventText: string) => {
    const lines = eventText.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .filter((line) => line.length > 0);
    if (dataLines.length === 0) return;

    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }

    let parsed: ChatCompletionResponseBody | null = null;
    try {
      parsed = JSON.parse(data) as ChatCompletionResponseBody;
    } catch {
      return;
    }

    for (const choice of parsed.choices ?? []) {
      const index = typeof choice.index === "number" ? choice.index : 0;
      const text = extractText(choice.delta?.content ?? null);
      if (!text) continue;
      choiceTexts.set(index, (choiceTexts.get(index) ?? "") + text);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const delim = findDelimiter(buffer);
        if (!delim) break;
        const event = buffer.slice(0, delim.index);
        buffer = buffer.slice(delim.index + delim.length);
        flushEvent(event);
        if (sawDone) {
          await reader.cancel();
          break;
        }
      }

      if (sawDone) break;
    }
  } finally {
    decoder.decode();
  }

  return mergeChoiceTexts(choiceTexts);
}

async function insertPromptLog(env: Env, id: string, body: ChatCompletionsRequestBody, req: Request): Promise<void> {
  const { systemPrompt, userPrompt } = extractPrompts(body.messages);
  const createdAt = new Date().toISOString();
  const model = typeof body.model === "string" ? body.model : null;
  const clientIp = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for");
  const userAgent = req.headers.get("user-agent");

  await env.DB.prepare(
    "INSERT INTO prompt_logs (id, created_at, model, system_prompt, user_prompt, client_ip, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
  )
    .bind(id, createdAt, model, systemPrompt, userPrompt, clientIp, userAgent)
    .run();
}

async function updateAssistantOutput(env: Env, id: string, assistantOutput: string): Promise<void> {
  await env.DB.prepare("UPDATE prompt_logs SET assistant_output = ?2 WHERE id = ?1").bind(id, assistantOutput).run();
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    }

    const auth = req.headers.get("authorization");
    if (!auth) {
      return jsonResponse({ error: { message: "Missing Authorization header" } }, { status: 401, headers: corsHeaders() });
    }

    let body: ChatCompletionsRequestBody;
    try {
      body = (await req.json()) as ChatCompletionsRequestBody;
    } catch {
      return jsonResponse({ error: { message: "Invalid JSON body" } }, { status: 400, headers: corsHeaders() });
    }

    const logId = crypto.randomUUID();
    try {
      await insertPromptLog(env, logId, body, req);
    } catch (err) {
      console.error("Failed to insert prompt log to D1", err);
    }

    const upstreamBase = (env.UPSTREAM_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
    const upstreamUrl = `${upstreamBase}/v1/chat/completions`;
    const upstreamHeaders = pickForwardHeaders(req.headers);
    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body)
    });

    const shouldTryCaptureOutput = upstreamResp.ok;
    if (shouldTryCaptureOutput) {
      if (body.stream === true && upstreamResp.body) {
        const [clientStream, logStream] = upstreamResp.body.tee();
        ctx.waitUntil(
          extractAssistantTextFromStream(logStream)
            .then((assistantOutput) => updateAssistantOutput(env, logId, assistantOutput))
            .catch((err) => console.error("Failed to capture assistant output (stream)", err))
        );

        const outHeaders = new Headers(upstreamResp.headers);
        return new Response(clientStream, {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: mergeHeaders(outHeaders, corsHeaders())
        });
      }

      ctx.waitUntil(
        upstreamResp
          .clone()
          .json<ChatCompletionResponseBody>()
          .then((json) => extractAssistantTextFromResponse(json))
          .then((assistantOutput) => updateAssistantOutput(env, logId, assistantOutput))
          .catch((err) => console.error("Failed to capture assistant output (non-stream)", err))
      );
    }

    const outHeaders = new Headers(upstreamResp.headers);
    const out = new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: mergeHeaders(outHeaders, corsHeaders())
    });
    return out;
  }
};
