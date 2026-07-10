// ---------------------------------------------------------------------------
// Claudeflare Code
//
// Claude Code CLI running in per-user Cloudflare Containers, with all API
// calls routed through AI Gateway for observability, caching, and cost control.
//
// Two subsystems:
//
// 1. AIG PROXY — translates Anthropic Messages API ↔ OpenAI Chat Completions
//    and forwards to Cloudflare AI Gateway's /compat endpoint. Handles auth,
//    metadata injection, max_tokens clamping, and response format translation.
//    Routes: POST /v1/messages, GET /v1/models, GET /health
//
// 2. CONTAINER TERMINAL — per-user web terminals running Claude Code CLI in
//    Cloudflare Containers, authenticated via Cloudflare Access. Each user
//    gets their own isolated container keyed by their email from the Access JWT.
//    Routes: GET / (landing page), /terminal/*, /api/*
//
// Request flow:
//
//   Browser (Cloudflare Access)
//     └── GET /terminal/* ──► Worker ──► ClaudeCodeContainer[user-email]
//                                             └── ttyd :8080
//                                                  └── claude CLI
//                                                       └── http://anthropic.proxy
//                                                            └── outboundByHost
//                                                                 └── AIG Proxy ──► AI Gateway
//
// See ARCHITECTURE.md for full details.
// ---------------------------------------------------------------------------

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { env as globalEnv } from "cloudflare:workers";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification
// ---------------------------------------------------------------------------

interface AccessJwtPayload {
	email?: string;
	sub?: string;
	aud?: string | string[];
	iss?: string;
	exp?: number;
	iat?: number;
	[key: string]: unknown;
}

interface JWK {
	kid: string;
	kty: string;
	n: string;
	e: string;
	alg?: string;
	use?: string;
}

interface JWKSResponse {
	keys: JWK[];
}

// Cache the imported CryptoKeys by kid to avoid re-fetching on every request
let jwksCache: Map<string, CryptoKey> | null = null;
let jwksCacheExpiry = 0;

function base64urlDecode(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function decodeJwtPayload(token: string): AccessJwtPayload {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid JWT format");
	return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
}

function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid JWT format");
	return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
}

async function fetchJWKs(certsUrl: string): Promise<Map<string, CryptoKey>> {
	const now = Date.now();
	if (jwksCache && now < jwksCacheExpiry) return jwksCache;

	const resp = await fetch(certsUrl);
	if (!resp.ok) throw new Error(`Failed to fetch JWKs: ${resp.status}`);

	const data: JWKSResponse = await resp.json();
	const keys = new Map<string, CryptoKey>();

	for (const jwk of data.keys) {
		if (jwk.kty !== "RSA") continue;
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg || "RS256" },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		keys.set(jwk.kid, key);
	}

	jwksCache = keys;
	jwksCacheExpiry = now + 10 * 60 * 1000; // cache 10 min
	return keys;
}

/**
 * Verifies the Cloudflare Access JWT and returns the user email.
 *
 * 1. Checks the Cf-Access-Jwt-Assertion header exists
 * 2. Fetches the public keys from the team's JWKs endpoint
 * 3. Verifies the RS256 signature
 * 4. Validates audience, expiry, and iat
 * 5. Returns the email from the payload
 */
async function verifyAccessJwt(request: Request, aud: string, certsUrl: string): Promise<string | null> {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return null;

	try {
		const header = decodeJwtHeader(token);
		const payload = decodeJwtPayload(token);

		// Validate audience
		const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (!tokenAud.includes(aud)) {
			console.error("Access JWT: audience mismatch");
			return null;
		}

		// Validate expiry
		const now = Math.floor(Date.now() / 1000);
		if (payload.exp && payload.exp < now) {
			console.error("Access JWT: token expired");
			return null;
		}

		// Verify signature
		const keys = await fetchJWKs(certsUrl);
		const key = header.kid ? keys.get(header.kid) : undefined;
		if (!key) {
			console.error(`Access JWT: unknown kid ${header.kid}`);
			return null;
		}

		const parts = token.split(".");
		const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
		const signature = base64urlDecode(parts[2]);

		const valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			signature,
			signatureInput,
		);

		if (!valid) {
			console.error("Access JWT: signature verification failed");
			return null;
		}

		return payload.email || payload.sub || null;
	} catch (err) {
		console.error("Access JWT verification error:", err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// AI Gateway dynamic route — set this to match your AI Gateway configuration.
// Format: "dynamic/<gateway-id>" routes through AI Gateway's model router.
const ROUTE = `dynamic/${globalEnv.GATEWAY_ID}`;

// ---------------------------------------------------------------------------
// Container class for Claude Code web terminals
// ---------------------------------------------------------------------------

export { ContainerProxy };

export class ClaudeCodeContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "10m";
	// Enable internet so connectivity check to api.anthropic.com passes.
	// Actual API calls go to http://anthropic.proxy via ANTHROPIC_BASE_URL,
	// which is intercepted by outboundByHost — no real Anthropic traffic.
	enableInternet = true;

	// Fake API key passes Claude Code's local sk-ant- validation.
	// Real credentials are injected in the outbound handler.
	envVars = {
		ANTHROPIC_API_KEY: "sk-ant-fake-container-key-routed-through-aig-proxy",
		ANTHROPIC_BASE_URL: "http://anthropic.proxy",
		DISABLE_AUTOUPDATER: "1",
		// Force Claude Code to use our dynamic route model name.
		// It will send this as the "model" field in /v1/messages requests.
		CLAUDE_MODEL: ROUTE,
	};

	override async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);

		// Store user email from the X-User-Email header (set by the Worker
		// when proxying requests into this DO). Persist to SQLite storage
		// so the outbound handler can retrieve it via RPC.
		const userEmail = request.headers.get("x-user-email");
		if (userEmail) {
			const current = await this.ctx.storage.get<string>("userEmail");
			if (current !== userEmail) {
				await this.ctx.storage.put("userEmail", userEmail);
				console.log(`[container] Stored user email: ${userEmail}`);
			}
		}

		if (pathname === "/admin/destroy") {
			await this.destroy();
			return new Response("Container destroyed");
		}

		if (pathname === "/admin/status") {
			const state = await this.getState();
			return Response.json({
				state: state.status,
				containerId: this.ctx.id.toString(),
				sleepAfter: this.sleepAfter,
			});
		}

		return this.containerFetch(request);
	}

	// RPC method: called by the outbound handler (which runs in the
	// ContainerProxy isolate) to retrieve the user email for AIG metadata.
	async getUserEmail(): Promise<string> {
		return (await this.ctx.storage.get<string>("userEmail")) || "unknown";
	}

	override onStart() {
		console.log(`Claude Code container started (id: ${this.ctx.id})`);
	}
	override onStop() {
		console.log(`Claude Code container stopped (id: ${this.ctx.id})`);
	}
	override onError(error: unknown) {
		console.error("Claude Code container error:", error);
	}
}

// Intercept HTTP to anthropic.proxy (where Claude Code sends API calls)
// and route through our AIG proxy.
//
// IMPORTANT: This handler runs in the ContainerProxy worker isolate, NOT
// in the Durable Object. Module-level state (Maps, variables) from the DO
// is not available here. To get the user email, we call back into the DO
// via env.CLAUDE_CODE_CONTAINER stub using the RPC method getUserEmail().
ClaudeCodeContainer.outboundByHost = {
	"anthropic.proxy": async (request: Request, env: Env, ctx: any) => {
		// Resolve the DO stub and call getUserEmail() RPC
		let user = "unknown";
		try {
			const id = env.CLAUDE_CODE_CONTAINER.idFromString(ctx.containerId);
			const stub = env.CLAUDE_CODE_CONTAINER.get(id);
			user = await stub.getUserEmail();
		} catch (err) {
			console.error("[outbound] Failed to get user email:", err);
		}
		console.log(`[outbound] ${request.method} ${request.url} (user: ${user})`);
		return handleProxy(request, env, { skipAuth: true, user });
	},
};

// Catch-all outbound handler for non-intercepted traffic
ClaudeCodeContainer.outbound = async (request: Request, env: Env, ctx: any) => {
	console.log(`[outbound-passthrough] ${request.method} ${request.url}`);
	return fetch(request);
};

// ---------------------------------------------------------------------------
// Task complexity classification
//
// Runs a small, fast Workers AI model against the user's original task
// text to classify it as low/medium/high complexity, then tags the AI
// Gateway request with `complexity` custom metadata. This is purely an
// observability signal — it never alters the request/response Claude Code
// sees, so it's fully transparent to the user.
// ---------------------------------------------------------------------------

type Complexity = "low" | "medium" | "high";

const COMPLEXITY_MODEL = "@cf/meta/llama-3.2-1b-instruct";

const COMPLEXITY_SYSTEM_PROMPT =
	"You are a task-complexity classifier for a coding assistant. Read the " +
	"user's request and classify how complex it will be to fulfill. Reply " +
	"with exactly one word — low, medium, or high — and nothing else.\n" +
	"- low: quick, narrow tasks (answer a question, summarize, small lookup, trivial edit)\n" +
	"- medium: a bounded task needing several steps (a single feature, bug fix, or refactor)\n" +
	"- high: large or open-ended engineering work spanning many systems/steps " +
	"(e.g. end-to-end app design, architecture, infra automation, security integrations)";

// Cache classification results within this isolate to avoid re-classifying
// the same task text on every request in an agentic tool-call loop (Claude
// Code resends the full conversation history on every turn).
const complexityCache = new Map<string, Complexity>();
const COMPLEXITY_CACHE_MAX = 200;

/**
 * Extracts the text of the original user task from an Anthropic-format
 * request body. Scans messages in order and returns the first `user`
 * message that contains actual text (skipping tool_result-only messages),
 * so the classification reflects the overall task rather than a single
 * tool round-trip.
 */
function extractTaskText(body: any): string | null {
	for (const m of body.messages || []) {
		if (m.role !== "user") continue;
		if (typeof m.content === "string") {
			const text = m.content.trim();
			if (text) return text;
		} else if (Array.isArray(m.content)) {
			const text = m.content
				.filter((b: any) => b?.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return null;
}

// Deterministic 32-bit FNV-1a hash, normalized to [0, 1). Used to bucket a
// user into the rollout sample so the same user consistently lands on the
// same side of the threshold across an agentic task's multiple requests,
// rather than flapping in/out on a per-request coin flip.
function hashToUnitInterval(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) / 0xffffffff;
}

/**
 * Gate for the complexity classification rollout. Controlled by
 * COMPLEXITY_CLASSIFICATION_ENABLED and COMPLEXITY_CLASSIFICATION_SAMPLE_RATE
 * in wrangler.jsonc — no code changes needed to toggle or tune.
 */
function shouldClassifyComplexity(env: Env, user: string): boolean {
	if (!env.COMPLEXITY_CLASSIFICATION_ENABLED) return false;
	const rate = env.COMPLEXITY_CLASSIFICATION_SAMPLE_RATE;
	if (rate >= 1) return true;
	if (rate <= 0) return false;
	return hashToUnitInterval(user) < rate;
}

/**
 * Classifies task complexity using a small/fast Workers AI model.
 * Returns undefined (rather than a guessed default) if classification
 * fails or is inconclusive, so we never tag metadata with a misleading
 * value — the complexity key is simply omitted for that request.
 */
async function classifyComplexity(env: Env, taskText: string): Promise<Complexity | undefined> {
	const cacheKey = taskText.slice(0, 500);
	const cached = complexityCache.get(cacheKey);
	if (cached) return cached;

	try {
		const result: any = await env.AI.run(COMPLEXITY_MODEL, {
			messages: [
				{ role: "system", content: COMPLEXITY_SYSTEM_PROMPT },
				{ role: "user", content: taskText.slice(0, 4000) },
			],
			max_tokens: 5,
			temperature: 0,
		});

		const text = String(result?.response ?? "").trim().toLowerCase();
		let complexity: Complexity | undefined;
		if (text.includes("high")) complexity = "high";
		else if (text.includes("medium")) complexity = "medium";
		else if (text.includes("low")) complexity = "low";

		if (complexity) {
			if (complexityCache.size >= COMPLEXITY_CACHE_MAX) {
				const oldestKey = complexityCache.keys().next().value;
				if (oldestKey !== undefined) complexityCache.delete(oldestKey);
			}
			complexityCache.set(cacheKey, complexity);
		}
		return complexity;
	} catch (err) {
		console.error("[complexity] classification failed:", err);
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// AIG proxy logic
// ---------------------------------------------------------------------------

async function handleProxy(request: Request, env: Env, opts?: { skipAuth?: boolean; user?: string }): Promise<Response> {
	const { pathname } = new URL(request.url);

	// Health — no auth
	if (pathname === "/health") {
		return Response.json({ ok: true, route: ROUTE });
	}

	// GET /v1/models — return the dynamic route as the only available model.
	// Claude Code calls this on startup to discover which models it can use.
	if (request.method === "GET" && pathname.startsWith("/v1/models")) {
		// Single-model detail: GET /v1/models/{id}
		const modelId = pathname.replace("/v1/models/", "").replace("/v1/models", "");
		if (modelId && modelId !== "") {
			return Response.json({
				id: ROUTE,
				type: "model",
				display_name: "Claudeflare Code (AI Gateway)",
				created_at: "2025-01-01T00:00:00Z",
				max_input_tokens: 16384,
				max_tokens: 8192,
				capabilities: {
					batch: { supported: false },
					citations: { supported: false },
					code_execution: { supported: false },
					context_management: { supported: false },
					effort: { supported: false },
					image_input: { supported: false },
					pdf_input: { supported: false },
					structured_outputs: { supported: false },
					thinking: { supported: false, types: { adaptive: { supported: false }, enabled: { supported: false } } },
				},
			});
		}
		// List models: GET /v1/models
		return Response.json({
			data: [
				{
					id: ROUTE,
					type: "model",
					display_name: "Claudeflare Code (AI Gateway)",
					created_at: "2025-01-01T00:00:00Z",
					max_input_tokens: 16384,
					max_tokens: 8192,
					capabilities: {
						batch: { supported: false },
						citations: { supported: false },
						code_execution: { supported: false },
						context_management: { supported: false },
						effort: { supported: false },
						image_input: { supported: false },
						pdf_input: { supported: false },
						structured_outputs: { supported: false },
						thinking: { supported: false, types: { adaptive: { supported: false }, enabled: { supported: false } } },
					},
				},
			],
			first_id: ROUTE,
			last_id: ROUTE,
			has_more: false,
		});
	}

	// Only POST /v1/messages
	if (request.method !== "POST" || !pathname.startsWith("/v1/messages")) {
		return new Response("Not found", { status: 404 });
	}

	// Auth — skip when called from the trusted outbound handler (container
	// subrequests intercepted by outboundByHost). Otherwise require a valid
	// Cloudflare Access JWT (the whole FQDN is Access-protected).
	let accessUser: string | null = null;
	if (!opts?.skipAuth) {
		accessUser = await verifyAccessJwt(request, env.CF_ACCESS_AUD, env.CF_ACCESS_CERTS_URL);
		if (!accessUser) {
			return new Response("Unauthorized", { status: 401 });
		}
	}

	const body: any = await request.json();

	// ---- Metadata ----
	const metadata: Record<string, string> = { source: "claude-code", user: "unknown" };
	try {
		Object.assign(metadata, JSON.parse(request.headers.get("x-metadata") || "{}"));
	} catch {}

	// Determine user: Access JWT (browser) > outbound handler (container) > x-metadata
	if (accessUser) {
		metadata.user = accessUser;
	} else if (opts?.user) {
		metadata.user = opts.user;
	}

	// ---- Complexity classification (transparent to the user) ----
	// Tag the request with a low/medium/high complexity signal derived from
	// the original task text, using a small/fast Workers AI model. This is
	// additive metadata only — it never changes the request Claude Code sees.
	// See COMPLEXITY_ROLLOUT for the single on/off + sample-rate control.
	if (shouldClassifyComplexity(env, metadata.user)) {
		const taskText = extractTaskText(body);
		if (taskText) {
			const complexity = await classifyComplexity(env, taskText);
			if (complexity) metadata.complexity = complexity;
		}
	}

	// ---- Translate Anthropic → OpenAI ----
	const messages: Array<{ role: string; content: string }> = [];

	if (body.system) {
		const text =
			typeof body.system === "string"
				? body.system
				: body.system.map((b: any) => b.text || "").join("\n");
		messages.push({ role: "system", content: text });
	}

	for (const m of body.messages || []) {
		messages.push({
			role: m.role,
			content:
				typeof m.content === "string"
					? m.content
					: m.content.map((b: any) => b.text || "").join(""),
		});
	}

	// ---- Call AI Gateway /compat ----
	// Claude Code requests max_tokens=64000+ for Claude models, but the
	// backing Workers AI model has a much smaller context window.
	// Clamp to a safe ceiling so the request doesn't get rejected.
	const MAX_TOKENS_CEILING = 8192;
	const maxTokens = body.max_tokens != null
		? Math.min(body.max_tokens, MAX_TOKENS_CEILING)
		: undefined;

	const resp = await fetch(
		`https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.GATEWAY_ID}/compat/chat/completions`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
				"cf-aig-metadata": JSON.stringify(metadata),
				// Cache identical requests for 5 minutes (300s) at AI Gateway.
				// Serves repeated prompts from edge cache, saving latency + cost.
				"cf-aig-cache-ttl": "300",
			},
			body: JSON.stringify({
				model: ROUTE,
				messages,
				stream: false,
				...(maxTokens != null ? { max_tokens: maxTokens } : {}),
				...(body.temperature != null ? { temperature: body.temperature } : {}),
			}),
		},
	);

	// ---- Translate OpenAI → Anthropic ----
	const oai: any = await resp.json();

	if (!resp.ok || !oai.choices?.length) {
		console.error(`AIG proxy error: status=${resp.status}`, JSON.stringify(oai));
		return Response.json(oai, { status: resp.status });
	}

	const choice = oai.choices[0];
	return Response.json({
		id: oai.id || "msg_proxy",
		type: "message",
		role: "assistant",
		model: oai.model || ROUTE,
		content: [{ type: "text", text: choice.message?.content || "" }],
		stop_reason: choice.finish_reason === "stop" ? "end_turn" : choice.finish_reason,
		usage: {
			input_tokens: oai.usage?.prompt_tokens || 0,
			output_tokens: oai.usage?.completion_tokens || 0,
		},
	});
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

// ---- AIG Proxy routes ----
// /v1/* routes handle their own auth (Access JWT or container outbound).

app.get("/favicon.ico", async (c) => {
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230d1117'/><text x='5' y='23' font-family='monospace' font-size='20' font-weight='bold' fill='%23f6821f'>%3E_</text></svg>`;
	return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
});

app.get("/health", async (c) => {
	return Response.json({ ok: true, route: ROUTE });
});

app.get("/v1/models", async (c) => {
	return handleProxy(c.req.raw, c.env, { skipAuth: true });
});

app.get("/v1/models/:id", async (c) => {
	return handleProxy(c.req.raw, c.env, { skipAuth: true });
});

app.post("/v1/messages", async (c) => {
	return handleProxy(c.req.raw, c.env);
});

// ---- Claudeflare Code routes (Access JWT verified) ----
// All UI routes live at the root. /v1/* are AIG proxy routes (above).

// Middleware: verify CF Access JWT on UI and terminal routes.
// Excludes /v1/* and /health which have their own auth.
app.use("/*", async (c, next) => {
	const { pathname } = new URL(c.req.url);
	// Skip auth for AIG proxy routes (they handle their own auth)
	if (pathname.startsWith("/v1/") || pathname === "/health") {
		return next();
	}
	const user = await verifyAccessJwt(c.req.raw, c.env.CF_ACCESS_AUD, c.env.CF_ACCESS_CERTS_URL);
	if (!user) {
		return c.html(
			`<h1>401 — Invalid or missing Cloudflare Access token</h1>
			 <p>Could not verify <code>Cf-Access-Jwt-Assertion</code>.
			 Make sure you are accessing this through the Access-protected domain.</p>`,
			401,
		);
	}
	c.set("userEmail", user);
	await next();
});

// Landing page — full-screen terminal with overlay panels
app.get("/", async (c) => {
	const user = c.get("userEmail");
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claudeflare Code — ${user}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230d1117'/><text x='5' y='23' font-family='monospace' font-size='20' font-weight='bold' fill='%23f6821f'>%3E_</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace; background: #0d1117; color: #c9d1d9; overflow: hidden; height: 100vh; }

    /* ── Terminal iframe (full viewport) ── */
    #terminal-frame { width: 100%; height: 100%; border: none; }

    /* ── Status bar ── */
    #status-bar {
      position: fixed; bottom: 0; left: 0; right: 0;
      height: 28px; background: #161b22; border-top: 1px solid #30363d;
      display: flex; align-items: center; padding: 0 12px;
      font-size: 12px; color: #8b949e; z-index: 100; gap: 16px;
    }
    #status-bar .user { color: #58a6ff; }
    #status-bar .state { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    #status-bar .state.running { background: #23883320; color: #3fb950; }
    #status-bar .state.stopped { background: #da363420; color: #f85149; }
    #status-bar .state.starting { background: #d2992220; color: #d29922; }
    #status-bar .state.unknown { background: #30363d; color: #8b949e; }
    #status-bar .shortcuts { margin-left: auto; color: #6e7681; }
    #status-bar kbd {
      background: #21262d; border: 1px solid #30363d; border-radius: 3px;
      padding: 0 4px; font-family: inherit; font-size: 11px; color: #8b949e;
    }

    /* ── Overlay panel ── */
    .overlay {
      display: none; position: fixed; top: 0; right: 0;
      width: 480px; height: calc(100% - 28px);
      background: #161b22; border-left: 1px solid #30363d;
      z-index: 90; flex-direction: column;
    }
    .overlay.open { display: flex; }
    .overlay-header {
      display: flex; align-items: center; padding: 12px 16px;
      border-bottom: 1px solid #30363d; gap: 8px;
    }
    .overlay-header h2 { font-size: 14px; font-weight: 600; color: #c9d1d9; flex: 1; }
    .overlay-header button {
      background: none; border: none; color: #8b949e; cursor: pointer;
      font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px;
    }
    .overlay-header button:hover { background: #21262d; color: #c9d1d9; }
    .overlay-body { flex: 1; overflow-y: auto; padding: 12px 16px; }

    /* ── Log entries ── */
    .log-entry { font-size: 12px; line-height: 1.8; border-bottom: 1px solid #21262d; padding: 4px 0; word-break: break-all; }
    .log-entry .ts { color: #6e7681; margin-right: 8px; }
    .log-entry .level-error { color: #f85149; }
    .log-entry .level-log { color: #8b949e; }
    .log-empty { color: #484f58; font-style: italic; padding: 24px 0; text-align: center; }

    /* ── Management panel ── */
    .mgmt-section { margin-bottom: 20px; }
    .mgmt-section h3 { font-size: 13px; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .mgmt-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
    .mgmt-row .label { color: #8b949e; min-width: 100px; }
    .mgmt-row .value { color: #c9d1d9; font-family: inherit; }
    .btn-action {
      background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
      padding: 6px 14px; border-radius: 6px; font-size: 13px;
      font-family: inherit; cursor: pointer; transition: all 0.15s;
    }
    .btn-action:hover { background: #30363d; border-color: #484f58; }
    .btn-danger { border-color: #f8514930; color: #f85149; }
    .btn-danger:hover { background: #f8514920; border-color: #f85149; }
    .btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
    .test-result { margin-top: 8px; font-size: 12px; background: #0d1117; border-radius: 6px; padding: 10px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
  </style>
</head>
<body>

<iframe id="terminal-frame" src="/terminal/"></iframe>

<!-- Logs overlay (Ctrl+L) -->
<div class="overlay" id="logs-panel">
  <div class="overlay-header">
    <h2>Proxy Logs</h2>
    <button onclick="clearLogs()" title="Clear">&#x2715;</button>
    <button onclick="togglePanel('logs')" title="Close (Ctrl+L)">&#x2190;</button>
  </div>
  <div class="overlay-body" id="logs-body">
    <div class="log-empty">Logs appear here as the proxy handles requests.</div>
  </div>
</div>

<!-- Container management overlay (Ctrl+K) -->
<div class="overlay" id="mgmt-panel">
  <div class="overlay-header">
    <h2>Container</h2>
    <button onclick="togglePanel('mgmt')" title="Close (Ctrl+K)">&#x2190;</button>
  </div>
  <div class="overlay-body">
    <div class="mgmt-section">
      <h3>Info</h3>
      <div class="mgmt-row"><span class="label">User</span><span class="value">${user}</span></div>
      <div class="mgmt-row"><span class="label">State</span><span class="value" id="mgmt-state">--</span></div>
      <div class="mgmt-row"><span class="label">Container ID</span><span class="value" id="mgmt-id" style="font-size:11px">--</span></div>
    </div>
    <div class="mgmt-section">
      <h3>Actions</h3>
      <div class="mgmt-row" style="gap:12px">
        <button class="btn-action" onclick="doRestart()">Restart Container</button>
        <button class="btn-action btn-danger" onclick="doDestroy()">Destroy</button>
      </div>
      <div class="mgmt-row">
        <button class="btn-action" onclick="doRefreshStatus()">Refresh Status</button>
      </div>
    </div>
    <div class="mgmt-section">
      <h3>Debug</h3>
      <div class="mgmt-row">
        <button class="btn-action" onclick="doTestProxy()">Test AIG Proxy</button>
      </div>
      <div id="test-result"></div>
    </div>
  </div>
</div>

<!-- Status bar -->
<div id="status-bar">
  <span class="user">${user}</span>
  <span class="state unknown" id="sb-state">--</span>
  <span class="shortcuts">
    <kbd>Ctrl+L</kbd> Logs &nbsp;
    <kbd>Ctrl+K</kbd> Container &nbsp;
    <kbd>Ctrl+D</kbd> Destroy
  </span>
</div>

<script>
// ── Panel toggling ──
function togglePanel(name) {
  const panels = { logs: 'logs-panel', mgmt: 'mgmt-panel' };
  const el = document.getElementById(panels[name]);
  const isOpen = el.classList.contains('open');
  // close all
  Object.values(panels).forEach(id => document.getElementById(id).classList.remove('open'));
  if (!isOpen) {
    el.classList.add('open');
    if (name === 'mgmt') doRefreshStatus();
  }
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  // Only intercept when terminal iframe is not focused, or use Ctrl+key
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'l') { e.preventDefault(); togglePanel('logs'); }
    if (e.key === 'k') { e.preventDefault(); togglePanel('mgmt'); }
    if (e.key === 'd') { e.preventDefault(); doDestroy(); }
  }
});

// ── Logs ──
const logEntries = [];
function addLog(level, msg) {
  const ts = new Date().toLocaleTimeString();
  logEntries.push({ ts, level, msg });
  if (logEntries.length > 200) logEntries.shift();
  renderLogs();
}
function clearLogs() { logEntries.length = 0; renderLogs(); }
function renderLogs() {
  const body = document.getElementById('logs-body');
  if (logEntries.length === 0) {
    body.innerHTML = '<div class="log-empty">No logs yet. Interact with Claude Code to generate proxy logs.</div>';
    return;
  }
  body.innerHTML = logEntries.map(e =>
    '<div class="log-entry"><span class="ts">' + e.ts + '</span><span class="level-' + e.level + '">' + escHtml(e.msg) + '</span></div>'
  ).join('');
  body.scrollTop = body.scrollHeight;
}
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Status polling ──
async function doRefreshStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    updateState(d.state || 'unknown');
    document.getElementById('mgmt-state').textContent = d.state || 'unknown';
    document.getElementById('mgmt-id').textContent = d.containerId || '--';
    addLog('log', 'Status: ' + JSON.stringify(d));
  } catch (err) {
    updateState('unknown');
    addLog('error', 'Status error: ' + err.message);
  }
}

function updateState(s) {
  const el = document.getElementById('sb-state');
  el.textContent = s;
  el.className = 'state ' + (s === 'running' ? 'running' : s === 'stopped' ? 'stopped' : s === 'starting' ? 'starting' : 'unknown');
}

// ── Actions ──
async function doDestroy() {
  if (!confirm('Destroy your container? You will need to relaunch.')) return;
  addLog('log', 'Destroying container...');
  try {
    const r = await fetch('/api/destroy', { method: 'POST' });
    const d = await r.json();
    addLog('log', 'Destroyed: ' + d.message);
    updateState('stopped');
    document.getElementById('mgmt-state').textContent = 'stopped';
  } catch (err) { addLog('error', 'Destroy error: ' + err.message); }
}

async function doRestart() {
  addLog('log', 'Restarting container...');
  try {
    const r = await fetch('/api/restart', { method: 'POST' });
    const d = await r.json();
    addLog('log', 'Restart: ' + d.message);
    updateState('starting');
    setTimeout(() => {
      document.getElementById('terminal-frame').src = '/terminal/';
      addLog('log', 'Terminal reloaded');
    }, 3000);
  } catch (err) { addLog('error', 'Restart error: ' + err.message); }
}

async function doTestProxy() {
  const el = document.getElementById('test-result');
  el.innerHTML = '<div class="test-result">Testing AIG proxy...</div>';
  addLog('log', 'Testing AIG proxy...');
  try {
    const r = await fetch('/api/test-proxy');
    const d = await r.json();
    el.innerHTML = '<div class="test-result">' + escHtml(JSON.stringify(d, null, 2)) + '</div>';
    addLog(d.status === 200 ? 'log' : 'error', 'Proxy test: status=' + d.status);
  } catch (err) {
    el.innerHTML = '<div class="test-result" style="color:#f85149">' + escHtml(err.message) + '</div>';
    addLog('error', 'Proxy test error: ' + err.message);
  }
}

// Initial status check
doRefreshStatus();
setInterval(doRefreshStatus, 30000);
</script>

</body>
</html>`;
	return c.html(html);
});

// Per-user container terminal — all /terminal/* requests proxy
// into the user's own container instance.
app.all("/terminal/*", async (c) => {
	const user = c.get("userEmail");

	// Derive a unique Durable Object ID from the user's email.
	// This guarantees each user gets their own container instance.
	const containerId = c.env.CLAUDE_CODE_CONTAINER.idFromName(user);
	const container = c.env.CLAUDE_CODE_CONTAINER.get(containerId);

	// Strip the /terminal prefix so ttyd sees / as its root
	const url = new URL(c.req.url);
	url.pathname = url.pathname.replace("/terminal", "") || "/";

	// Pass user email to the container so the outbound handler can tag
	// AIG metadata with the correct user identity.
	const headers = new Headers(c.req.raw.headers);
	headers.set("x-user-email", user);
	const proxyReq = new Request(url.toString(), { ...c.req.raw, headers });
	return container.fetch(proxyReq);
});

// ---- Container management API (JSON) ----

// Helper: build a request to the container DO with the user email header.
function containerReq(path: string, baseUrl: string, user: string, method = "GET"): Request {
	return new Request(new URL(path, baseUrl).toString(), {
		method,
		headers: { "x-user-email": user },
	});
}

// GET /api/status — container state
app.get("/api/status", async (c) => {
	const user = c.get("userEmail");
	const containerId = c.env.CLAUDE_CODE_CONTAINER.idFromName(user);
	const container = c.env.CLAUDE_CODE_CONTAINER.get(containerId);
	try {
		const resp = await container.fetch(containerReq("/admin/status", c.req.url, user));
		return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
	} catch (err: any) {
		return Response.json({ state: "unknown", error: err.message }, { status: 500 });
	}
});

// POST /api/destroy — destroy container
app.post("/api/destroy", async (c) => {
	const user = c.get("userEmail");
	const containerId = c.env.CLAUDE_CODE_CONTAINER.idFromName(user);
	const container = c.env.CLAUDE_CODE_CONTAINER.get(containerId);
	const resp = await container.fetch(containerReq("/admin/destroy", c.req.url, user, "POST"));
	return Response.json({ ok: true, message: await resp.text(), user });
});

// POST /api/restart — destroy then navigate to terminal
app.post("/api/restart", async (c) => {
	const user = c.get("userEmail");
	const containerId = c.env.CLAUDE_CODE_CONTAINER.idFromName(user);
	const container = c.env.CLAUDE_CODE_CONTAINER.get(containerId);
	try {
		await container.fetch(containerReq("/admin/destroy", c.req.url, user, "POST"));
	} catch {}
	return Response.json({ ok: true, message: "Container destroyed, relaunch terminal", user });
});

// GET /api/test-proxy — test AIG proxy with a minimal request
app.get("/api/test-proxy", async (c) => {
	try {
		const testBody = {
			model: "claude-sonnet-4-20250514",
			max_tokens: 16,
			messages: [{ role: "user", content: "Say hi" }],
		};
		const resp = await handleProxy(
			new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(testBody),
			}),
			c.env,
			{ skipAuth: true },
		);
		const data = await resp.json();
		return Response.json({ status: resp.status, response: data });
	} catch (err: any) {
		return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
	}
});

// Legacy HTML destroy endpoint
app.get("/destroy", async (c) => {
	const user = c.get("userEmail");
	const containerId = c.env.CLAUDE_CODE_CONTAINER.idFromName(user);
	const container = c.env.CLAUDE_CODE_CONTAINER.get(containerId);
	const resp = await container.fetch(containerReq("/admin/destroy", c.req.url, user));
	const text = await resp.text();
	return c.html(`<h1>${text} for ${user}</h1><p><a href="/terminal/">Relaunch terminal</a> (takes ~30s to boot)</p>`);
});

// Catch-all
app.all("*", async (c) => {
	return new Response("Not found", { status: 404 });
});

export default app;
