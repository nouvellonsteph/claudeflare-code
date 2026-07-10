# Architecture

This document describes the technical architecture of Claudeflare Code.

## Overview

Claudeflare Code is a single Cloudflare Worker (`src/index.ts`) that serves two roles:

1. **Container orchestrator** — manages per-user Durable Object instances that each run a Docker container with `ttyd` + Claude Code CLI.
2. **AI Gateway proxy** — intercepts all API calls from the container, translates between Anthropic and OpenAI formats, and forwards through Cloudflare AI Gateway. Each request is potentially tagged with a `complexity` (`low`/`medium`/`high`) custom metadata value, classified by a small Workers AI model.

Everything runs on Cloudflare's network. There is no origin server.

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                           │
│                                                             │
│  ┌──────────────────┐    ┌─────────────────────────────┐    │
│  │  Cloudflare       │    │  Worker (Hono)               │    │
│  │  Access           │───>│                              │    │
│  │  (JWT auth)       │    │  GET /          Landing page │    │
│  └──────────────────┘    │  /terminal/*    Container     │    │
│                          │  /api/*         Management    │    │
│                          │  /v1/messages   AIG Proxy     │    │
│                          │  /v1/models     Model list    │    │
│                          └──────┬──────────────────────┘    │
│                                 │                            │
│                    ┌────────────┴────────────┐               │
│                    ▼                         ▼               │
│  ┌──────────────────────────┐  ┌──────────────────────┐     │
│  │  Durable Object           │  │  AI Gateway           │     │
│  │  ClaudeCodeContainer      │  │                       │     │
│  │                           │  │  /compat/chat/        │     │
│  │  ┌─────────────────────┐  │  │  completions          │     │
│  │  │  Container           │  │  │                       │     │
│  │  │  ┌─────┐  ┌───────┐ │  │  │  - Logging            │     │
│  │  │  │ttyd │  │claude │ │  │  │  - Caching (300s)     │     │
│  │  │  │:8080│  │ CLI   │─┼──┼──│  - Rate limiting      │     │
│  │  │  └─────┘  └───────┘ │  │  │  - Model routing      │     │
│  │  └─────────────────────┘  │  └──────────────────────┘     │
│  │                           │               │               │
│  │  SQLite: userEmail        │               ▼               │
│  └──────────────────────────┘     Upstream LLM provider      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Request flows

### Browser → Terminal

1. User navigates to the worker URL.
2. Cloudflare Access intercepts, authenticates, injects `Cf-Access-Jwt-Assertion` header.
3. Worker Hono middleware verifies the JWT (RS256 signature, audience, expiry).
4. `GET /` serves the landing page HTML with embedded `<iframe src="/terminal/">`.
5. `ALL /terminal/*` strips the prefix and proxies into the user's Durable Object.
6. The DO calls `containerFetch()` which forwards to `ttyd` on port 8080 inside the container.

### Container → AI Gateway (outbound interception)

1. Claude Code CLI sends `POST http://anthropic.proxy/v1/messages` (configured via `ANTHROPIC_BASE_URL`).
2. `ClaudeCodeContainer.outboundByHost["anthropic.proxy"]` intercepts the request.
3. The outbound handler runs in the **ContainerProxy isolate** (not the DO). It cannot access DO instance state directly.
4. To get the user email, it calls `env.CLAUDE_CODE_CONTAINER.get(id).getUserEmail()` — an RPC call back into the DO, which reads from SQLite storage.
5. The intercepted request is forwarded to `handleProxy()` with `skipAuth: true` and the resolved user email.
6. `handleProxy()` translates Anthropic → OpenAI, calls AI Gateway, translates back.

### API format translation

**Anthropic → OpenAI (request)**

```
Anthropic Messages API              OpenAI Chat Completions
─────────────────────              ──────────────────────────
system: string|block[]      →      messages[0].role: "system"
messages[].role             →      messages[].role
messages[].content (blocks) →      messages[].content (string)
max_tokens                  →      max_tokens (clamped to 8192)
temperature                 →      temperature
model (ignored)             →      model: "dynamic/<gateway-id>"
```

**OpenAI → Anthropic (response)**

```
OpenAI Chat Completions             Anthropic Messages API
──────────────────────────          ─────────────────────
choices[0].message.content  →      content[0].type: "text"
choices[0].finish_reason    →      stop_reason
usage.prompt_tokens         →      usage.input_tokens
usage.completion_tokens     →      usage.output_tokens
id                          →      id
model                       →      model
```

## Component details

### Worker (`src/index.ts`)

Single-file Worker using [Hono](https://hono.dev/) for routing. ~985 lines covering:

- **Access JWT verification** (lines 33-168): Full RS256 JWT verification with JWK caching (10 min TTL). Validates audience, expiry, and signature.
- **ClaudeCodeContainer class** (lines 183-249): Extends `Container<Env>` from `@cloudflare/containers`. Configures the container runtime (port, sleep timeout, env vars, internet access). Provides `getUserEmail()` RPC method.
- **Outbound handlers** (lines 258-278): `outboundByHost` intercepts `anthropic.proxy` traffic. Catch-all `outbound` passes through all other traffic.
- **Complexity classification** (lines 289-420): `COMPLEXITY_ROLLOUT`, `shouldClassifyComplexity()`, `extractTaskText()`, and `classifyComplexity()` — gates and runs the small Workers AI model that produces `complexity` metadata.
- **AIG proxy** (lines 422-604): `handleProxy()` function handling translation, auth, metadata (incl. complexity tagging), clamping, and AI Gateway forwarding.
- **Hono routes** (lines 608-1018): Landing page, terminal proxy, management API, test endpoint.

### Container (`Dockerfile.claude-code`)

Debian-based (`node:22-bookworm-slim`) image with:

- **ttyd** 1.7.7 — terminal-over-HTTP server on port 8080
- **Claude Code CLI** — `@anthropic-ai/claude-code` installed globally
- **Configuration** — pre-baked `/root/.claude/settings.json` with model settings

Environment variables injected by the DO:

| Variable | Value | Purpose |
|----------|-------|---------|
| `ANTHROPIC_API_KEY` | `sk-ant-fake-...` | Passes Claude Code's local key validation |
| `ANTHROPIC_BASE_URL` | `http://anthropic.proxy` | Routes API calls to outbound interceptor |
| `DISABLE_AUTOUPDATER` | `1` | Prevents Claude Code from auto-updating |
| `CLAUDE_MODEL` | `dynamic/<gateway-id>` | Model name sent in API requests |

The fake API key never reaches any external service. Real authentication is handled by the outbound handler using `CF_AIG_TOKEN`.

### Durable Object state

Each `ClaudeCodeContainer` instance stores minimal state in SQLite:

| Key | Type | Purpose |
|-----|------|---------|
| `userEmail` | `string` | User identity for AIG metadata tagging |

The email is written on every `fetch()` via the `X-User-Email` header (set by the Worker). The outbound handler reads it via the `getUserEmail()` RPC method.

### AI Gateway integration

Requests hit the AI Gateway `/compat/chat/completions` endpoint which accepts OpenAI format and routes to any configured provider.

Headers sent:

| Header | Value | Purpose |
|--------|-------|---------|
| `cf-aig-authorization` | `Bearer <CF_AIG_TOKEN>` | Gateway authentication |
| `cf-aig-metadata` | `{"source":"claude-code","user":"...","complexity":"..."}` | Per-request metadata for analytics |
| `cf-aig-cache-ttl` | `300` | Cache identical requests for 5 minutes |

The `model` field is set to `dynamic/<gateway-id>`, which tells AI Gateway to use its configured model routing (fallback chains, load balancing, etc.).

### Task complexity classification

Before forwarding to AI Gateway, `handleProxy()` extracts the original task text (the first `user` message containing actual text, skipping tool-result-only messages) and classifies it as `low`, `medium`, or `high` complexity using a small, fast Workers AI model (`@cf/meta/llama-3.2-1b-instruct`, via the `env.AI` binding). The result is added to `cf-aig-metadata` as `complexity`.

This is purely an observability signal:

- It never changes the request or response Claude Code sees — the classification call and the main proxied request are independent, and a classification failure/timeout silently omits the `complexity` key rather than failing or altering the request.
- Results are cached in-memory per isolate (keyed by task text) to avoid re-classifying the same task on every turn of an agentic tool-call loop, since Claude Code resends the full conversation history on each request.
- Because custom metadata is limited to 5 keys per request, `complexity` brings the total to 3 (alongside `source` and `user`), leaving headroom for future tags.

**Rollout control**: the `COMPLEXITY_ROLLOUT` constant in `src/index.ts` (just above `classifyComplexity()`) is the single place that controls this feature — `enabled: false` turns it off for everyone, and `sampleRate` (0–1) rolls it out to a fraction of requests. Sampling is gated by `shouldClassifyComplexity()`, which hashes the resolved `user` identifier (FNV-1a) into `[0, 1)` so a given user consistently lands on the same side of the threshold across an agentic task's multiple requests, rather than being included on one turn and excluded on the next. There is currently no per-user or per-JWT-claim targeting — it's a global code-level toggle, by design, for simplicity.

## Security model

- **Zero Trust auth**: Cloudflare Access protects the entire worker domain. No anonymous access.
- **Container isolation**: Each user's container is a separate Durable Object instance with its own lifecycle.
- **No real API keys in containers**: The `ANTHROPIC_API_KEY` env var is a fake `sk-ant-` token. Real auth (`CF_AIG_TOKEN`) lives only in the Worker's secret store and is injected in the outbound handler.
- **Outbound interception**: Containers cannot make direct calls to Anthropic. All `anthropic.proxy` traffic is intercepted and routed through the AIG proxy.
- **Internet access**: Containers have `enableInternet = true` to pass Claude Code's connectivity check to `api.anthropic.com`, but actual API traffic goes through `http://anthropic.proxy` which is intercepted before it leaves the container network.

## Limitations

- **Claude Code model picker**: The CLI's model selection UI is hardcoded client-side and cannot be customized via settings. The proxy ignores the `model` field and always routes through `dynamic/<gateway-id>`, so this is cosmetic only.
- **No streaming**: Responses use `stream: false`. AI Gateway streaming support could be added but requires chunked response translation.
- **Single-file Worker**: All logic is in one file. For larger deployments, consider splitting into modules.
