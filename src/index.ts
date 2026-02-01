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

async function logPrompts(env: Env, body: ChatCompletionsRequestBody, req: Request): Promise<void> {
  const { systemPrompt, userPrompt } = extractPrompts(body.messages);
  const id = crypto.randomUUID();
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

    ctx.waitUntil(
      logPrompts(env, body, req).catch((err) => {
        console.error("Failed to log prompts to D1", err);
      })
    );

    const upstreamBase = (env.UPSTREAM_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
    const upstreamUrl = `${upstreamBase}/v1/chat/completions`;
    const upstreamHeaders = pickForwardHeaders(req.headers);
    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body)
    });

    const outHeaders = new Headers(upstreamResp.headers);
    const out = new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: mergeHeaders(outHeaders, corsHeaders())
    });
    return out;
  }
};
