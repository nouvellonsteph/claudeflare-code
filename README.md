# Claudeflare Code

Per-user [Claude Code](https://docs.anthropic.com/en/docs/claude-code) web terminals running in [Cloudflare Containers](https://developers.cloudflare.com/containers/), with all API calls routed through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) for observability, caching, and cost control.

Each user gets their own isolated container instance, authenticated via [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). No shared state between users. No direct Anthropic API access from containers.

```
Browser (Cloudflare Access)
  └── GET /terminal/* ──> Worker ──> Container[user@email.com]
                                          └── ttyd :8080
                                               └── claude CLI
                                                    └── http://anthropic.proxy
                                                         └── outboundByHost
                                                              └── AIG Proxy ──> AI Gateway
```

## What it does

- **Isolated terminals**: Each authenticated user gets their own container running `ttyd` + Claude Code CLI, keyed by their email address.
- **API proxy**: All Claude Code API calls are intercepted at the container boundary via `outboundByHost`, translated from Anthropic format to OpenAI format, and forwarded through AI Gateway.
- **Observability**: Every request is tagged with user identity metadata in AI Gateway, giving you per-user usage visibility.
- **Caching**: Identical prompts are cached at the AI Gateway edge for 5 minutes, reducing latency and cost.
- **Cost control**: `max_tokens` is clamped to a configurable ceiling (default 8192) regardless of what Claude Code requests.

## Cloudflare services used

| Service | Role |
|---------|------|
| [Workers](https://developers.cloudflare.com/workers/) | HTTP routing, auth middleware, API proxy |
| [Containers](https://developers.cloudflare.com/containers/) | Per-user isolated Claude Code terminals |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | Container lifecycle, user state (SQLite) |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/) | Model routing, logging, caching, rate limiting |
| [Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) | Zero Trust authentication (JWT) |

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/) with Workers Paid plan
- [Cloudflare Containers](https://developers.cloudflare.com/containers/) enabled (beta)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/) configured with at least one provider
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application for the worker domain
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for building container images)
- Node.js 18+

## Setup

### 1. Clone and install

```bash
git clone https://github.com/cloudflare/claudeflare-code.git
cd claudeflare-code
npm install
```

### 2. Configure

Copy the example config and fill in your values:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc`:

| Variable | Description |
|----------|-------------|
| `GATEWAY_ID` | Your AI Gateway slug (from the AI Gateway dashboard) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `AIG_PROXY_URL` | The public URL of this worker (update after first deploy) |
| `CF_ACCESS_AUD` | Audience tag from your Access application |
| `CF_ACCESS_CERTS_URL` | JWKs URL from your Access team (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) |

### 3. Deploy

```bash
npm run deploy
```

The first deploy builds the Docker image and pushes it to Cloudflare's container registry. This takes a few minutes.

### 4. Set secrets

```bash
npx wrangler secret put CF_AIG_TOKEN
```

Paste your AI Gateway authentication token when prompted. This token needs the "Run" permission on your gateway.

### 5. Configure Access

Create a Cloudflare Access application for your worker domain (`<name>.<subdomain>.workers.dev`) in the [Zero Trust dashboard](https://one.dash.cloudflare.com/). Update `CF_ACCESS_AUD` and `CF_ACCESS_CERTS_URL` in `wrangler.jsonc` if they changed, then redeploy.

### 6. Open

Navigate to your worker URL. Cloudflare Access will prompt you to authenticate, then you'll see the terminal. Type `claude` to start a Claude Code session.

## Project structure

```
claudeflare-code/
├── src/
│   └── index.ts              # Worker: routes, auth, proxy, container class, UI
├── container_src/
│   ├── entrypoint.sh          # Container startup: ttyd on port 8080
│   └── claude-settings.json   # Claude Code model configuration
├── Dockerfile.claude-code     # Container image: node + ttyd + claude-code CLI
├── wrangler.jsonc.example     # Config template (copy to wrangler.jsonc)
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md            # Detailed technical architecture
└── AGENTS.md                  # How the AI agent pipeline works
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Toggle proxy logs panel |
| `Ctrl+K` | Toggle container management panel |
| `Ctrl+D` | Destroy container (with confirmation) |

## How the proxy works

Claude Code CLI inside the container sends Anthropic Messages API requests to `http://anthropic.proxy` (configured via `ANTHROPIC_BASE_URL`). The container's outbound traffic is intercepted by `outboundByHost` and routed through the AIG proxy, which:

1. Extracts user identity via DO RPC (`getUserEmail()`)
2. Translates Anthropic format to OpenAI Chat Completions format
3. Clamps `max_tokens` to `MAX_TOKENS_CEILING` (8192)
4. Forwards to AI Gateway with auth, metadata, and cache headers
5. Translates the OpenAI response back to Anthropic format

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical breakdown.

## Configuration

### Container settings

In `wrangler.jsonc`:

- `instance_type`: Container size (`standard-1` by default)
- `max_instances`: Maximum concurrent containers (20 by default)
- `sleepAfter`: Container idle timeout (`10m` in `src/index.ts`)

### Proxy settings

In `src/index.ts`:

- `MAX_TOKENS_CEILING`: Maximum tokens per response (8192)
- Cache TTL: AI Gateway cache duration (300s / 5 minutes via `cf-aig-cache-ttl` header)

## License

Apache 2.0 — see [LICENSE](LICENSE).
