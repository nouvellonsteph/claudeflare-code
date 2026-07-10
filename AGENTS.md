# Agents

How Claudeflare Code works as an AI agent platform.

## The agent

Each user gets an isolated instance of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's agentic coding assistant — running inside a Cloudflare Container. Claude Code is a full terminal-based agent that can:

- Read, write, and edit files
- Run shell commands
- Search codebases
- Use tools autonomously
- Maintain conversation context across a session

The agent runs in a standard Linux environment (Debian bookworm) with Node.js 22, git, bash, and tmux available. Users interact through a web terminal (ttyd) embedded in the browser.

## Agent lifecycle

```
User authenticates via Cloudflare Access
        │
        ▼
Worker extracts email from Access JWT
        │
        ▼
Durable Object ID = idFromName(email)
        │
        ▼
Container starts (or wakes from sleep)
  ┌─────────────────────────┐
  │  ttyd :8080              │
  │    └── bash -l           │
  │         └── claude       │  ◄── user types "claude" to start
  │              └── session  │
  └─────────────────────────┘
        │
        ▼  (idle 10 minutes)
Container sleeps (state preserved)
        │
        ▼  (destroyed via UI or API)
Container terminated, DO state cleared
```

### Container persistence

- **Running**: Active container with ttyd + shell. User can interact.
- **Sleeping**: Container sleeps after 10 minutes idle (`sleepAfter = "10m"`). Wakes on next request. Filesystem state is preserved across sleep/wake cycles.
- **Destroyed**: Container is terminated. Next access creates a fresh container.

## API call pipeline

Every time Claude Code makes an API call (thinking, tool use, code generation), the request travels through a multi-stage pipeline:

```
Claude Code CLI
    │
    │  POST http://anthropic.proxy/v1/messages
    │  (Anthropic Messages API format)
    │
    ▼
outboundByHost["anthropic.proxy"]
    │
    │  1. Resolve user email via DO RPC
    │  2. Forward to handleProxy() with skipAuth
    │
    ▼
handleProxy()
    │
    │  3. Translate Anthropic → OpenAI format
    │  4. Clamp max_tokens to 8192
    │  5. Inject metadata: { source, user }
    │  6. Add cache header: cf-aig-cache-ttl: 300
    │
    ▼
AI Gateway (/compat/chat/completions)
    │
    │  7. Log request with metadata
    │  8. Check cache (return cached if hit)
    │  9. Route to upstream provider
    │
    ▼
LLM Provider (configured in AI Gateway)
    │
    │  10. Generate response
    │
    ▼
AI Gateway
    │
    │  11. Cache response
    │  12. Log response
    │
    ▼
handleProxy()
    │
    │  13. Translate OpenAI → Anthropic format
    │
    ▼
Claude Code CLI
    │
    │  14. Process response, continue agent loop
    ▼
```

### Why translate formats?

Claude Code CLI speaks the Anthropic Messages API natively. AI Gateway's `/compat` endpoint speaks OpenAI Chat Completions. The proxy translates between them so that:

- Claude Code thinks it's talking to Anthropic
- AI Gateway can route to **any** provider (OpenAI, Anthropic, Workers AI, etc.)
- The model routing decision is made at the gateway level, not in the client

This means you can swap the backing model without touching the container or the CLI configuration. Change the routing rules in AI Gateway and every running agent uses the new model on their next request.

## Per-user isolation

The isolation model ensures no state leaks between users:

| Layer | Isolation mechanism |
|-------|-------------------|
| **Authentication** | Cloudflare Access JWT — each user identified by email |
| **Container** | Separate Durable Object instance per email (`idFromName(email)`) |
| **Filesystem** | Each container has its own filesystem, not shared |
| **API calls** | Outbound handler resolves user via DO RPC, tags metadata per-user |
| **AI Gateway logs** | Metadata includes user email — filter logs by user in dashboard |

## Observability

### AI Gateway dashboard

Every API call appears in the AI Gateway logs with:

- `source: "claude-code"` — identifies this as a Claudeflare Code request
- `user: "<email>"` — the authenticated user who triggered the request
- Request/response bodies, latency, token counts, cache status

### Worker logs

The Worker emits structured logs via `console.log`:

- `[container] Stored user email: <email>` — user identity persisted to DO
- `[outbound] POST http://anthropic.proxy/v1/messages (user: <email>)` — API call intercepted
- `[outbound-passthrough] <method> <url>` — non-API traffic passed through
- `AIG proxy error: status=<n> <body>` — upstream error from AI Gateway

### Container logs

Inside the container, Claude Code's own output is visible in the ttyd terminal. The entrypoint script prints startup diagnostics:

```
==============================
  Claudeflare Code Terminal
==============================
  Model route : dynamic/<gateway-id>
  Proxy       : http://anthropic.proxy
  API key     : set (hidden)
  Container   : <durable-object-id>
  CLI version : 1.x.x
```

## Extending the agent

### Adding tools

Claude Code supports [custom tools](https://docs.anthropic.com/en/docs/claude-code/tools) via MCP servers. You can install MCP servers inside the container by modifying the Dockerfile:

```dockerfile
# Example: add a filesystem MCP server
RUN npm install -g @anthropic-ai/mcp-server-filesystem
```

### Custom system prompts

Claude Code supports project-level configuration via `.claude/` directories. Pre-populate the workspace in the Dockerfile or mount configuration at runtime.

### Multiple model tiers

Configure AI Gateway with different routing rules per gateway ID. Deploy multiple instances of Claudeflare Code with different `GATEWAY_ID` values to offer different model tiers (e.g., fast/cheap vs. capable/expensive).

### Rate limiting

AI Gateway supports per-user rate limiting. Configure rate limit rules in the AI Gateway dashboard using the `user` metadata field to enforce per-user quotas.

## Cost model

Costs come from three sources:

| Source | Billing unit | Notes |
|--------|-------------|-------|
| **Cloudflare Containers** | Per-second, per instance type | Sleeping containers are free. `standard-1` is the smallest. |
| **AI Gateway** | Free (logging/caching) | No additional cost for gateway routing |
| **Upstream LLM** | Per-token | Depends on provider and model configured in AI Gateway |

The 5-minute cache (`cf-aig-cache-ttl: 300`) can significantly reduce costs when users repeat similar prompts or when Claude Code retries failed operations.
