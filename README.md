# HookPrompt (Cloudflare Workers)

OpenAI-compatible gateway for `POST /v1/chat/completions` that:

- Extracts and stores `system/developer` + `user` prompt text into Cloudflare D1
- Proxies the request to an upstream OpenAI-compatible endpoint
- Supports `stream: true` by passing through the upstream SSE stream

## Setup

Install dependencies:

```bash
npm i
```

Create a D1 database and apply migrations:

```bash
npx wrangler d1 create hookprompt-db
# Copy the returned database_id into wrangler.toml (d1_databases.database_id)
npx wrangler d1 migrations apply hookprompt-db --local
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## Usage

Point your OpenAI client at this Worker and keep using the standard path:

- Base URL: `https://<your-worker-domain>`
- Endpoint: `POST /v1/chat/completions`

The Worker **requires** the client to send `Authorization: Bearer ...` and will forward it upstream (not stored in D1).

## Notes

- Upstream base URL is configurable via `UPSTREAM_BASE_URL` (default `https://api.openai.com`).
- D1 only stores extracted text parts; non-text message parts are ignored.

