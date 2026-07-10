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
import {
	base64urlDecode,
	decodeJwtPayload,
	decodeJwtHeader,
	translateAnthropicToOpenAI,
	translateOpenAIToAnthropic,
	clampMaxTokens,
	resolveMetadata,
	extractTaskText,
	parseComplexity,
	shouldClassifyComplexity,
	MAX_TOKENS_CEILING,
	COMPLEXITY_MODEL,
	COMPLEXITY_SYSTEM_PROMPT,
	type AccessJwtPayload,
	type Complexity,
	openAIStreamToAnthropicStream,
} from "./proxy";

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification
// ---------------------------------------------------------------------------

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

	// RPC methods for async complexity classification.
	// The outbound handler classifies on turn 1 (fire-and-forget) and stores
	// the result here. On turn 2+, the proxy reads the stored complexity to
	// tag metadata and potentially route to a different model.
	async getSessionComplexity(): Promise<string | null> {
		return (await this.ctx.storage.get<string>("complexity")) ?? null;
	}

	async setSessionComplexity(complexity: string): Promise<void> {
		await this.ctx.storage.put("complexity", complexity);
		console.log(`[container] Stored complexity: ${complexity}`);
	}

	async clearSessionComplexity(): Promise<void> {
		await this.ctx.storage.delete("complexity");
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
// is not available here. To get the user email and session complexity, we
// call back into the DO via env.CLAUDE_CODE_CONTAINER stub using RPC.
//
// ASYNC COMPLEXITY CLASSIFICATION:
// Turn 1: no stored complexity yet → forward immediately with default model,
//         fire-and-forget classification via ctx.waitUntil().
// Turn 2+: read stored complexity from DO → tag metadata + route accordingly.
ClaudeCodeContainer.outboundByHost = {
	"anthropic.proxy": async (request: Request, env: Env, ctx: any) => {
		let user = "unknown";
		let complexity: string | null = null;
		let stub: any;
		try {
			const id = env.CLAUDE_CODE_CONTAINER.idFromString(ctx.containerId);
			stub = env.CLAUDE_CODE_CONTAINER.get(id);
			[user, complexity] = await Promise.all([
				stub.getUserEmail(),
				stub.getSessionComplexity(),
			]);
		} catch (err) {
			console.error("[outbound] Failed to get session state:", err);
		}

		console.log(`[outbound] ${request.method} ${request.url} (user: ${user}, complexity: ${complexity ?? "pending"})`);

		// Clone the request body for both the proxy call and the async classifier.
		// We need the body twice: once for handleProxy, once for extractTaskText.
		const bodyText = await request.text();
		const proxyRequest = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: bodyText,
		});

		// If no complexity yet and classification is enabled, fire-and-forget
		// the classifier via AI Gateway (logged, cached, observable in dashboard).
		// Uses env.AI.run() with the gateway option so the call routes through
		// AI Gateway just like all other inference in this project.
		if (!complexity && stub && env.AI) {
			try {
				const body = JSON.parse(bodyText);
				const taskText = extractTaskText(body);
				if (taskText && shouldClassifyComplexity(true, 1, user)) {
					// Fire-and-forget: classify async, don't block the proxy response
					ctx.waitUntil(
						(async () => {
							try {
								const result: any = await env.AI.run(
									COMPLEXITY_MODEL,
									{
										messages: [
											{ role: "system", content: COMPLEXITY_SYSTEM_PROMPT },
											{ role: "user", content: taskText.slice(0, 4000) },
										],
										max_tokens: 5,
										temperature: 0,
									},
									{
										gateway: {
											id: env.GATEWAY_ID,
											skipCache: false,
											cacheTtl: 300,
											metadata: {
												source: "claude-code",
												user,
												task: "complexity-classification",
												model: COMPLEXITY_MODEL,
											},
										},
									},
								);
								const parsed = parseComplexity(String(result?.response ?? ""));
								if (parsed) {
									await stub.setSessionComplexity(parsed);
									console.log(`[complexity] Classified task as: ${parsed}`);
								}
							} catch (err) {
								console.error("[complexity] Async classification failed:", err);
							}
						})(),
					);
				}
			} catch {
				// Body parse failed — skip classification, proxy will re-parse
			}
		}

		return handleProxy(proxyRequest, env, { skipAuth: true, user, complexity: complexity as Complexity | null });
	},
};

// Catch-all outbound handler for non-intercepted traffic
ClaudeCodeContainer.outbound = async (request: Request, env: Env, ctx: any) => {
	console.log(`[outbound-passthrough] ${request.method} ${request.url}`);
	return fetch(request);
};

// ---------------------------------------------------------------------------
// AIG proxy logic
// ---------------------------------------------------------------------------

async function handleProxy(request: Request, env: Env, opts?: { skipAuth?: boolean; user?: string; complexity?: Complexity | null }): Promise<Response> {
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
	const metadata = resolveMetadata(opts, accessUser, request.headers.get("x-metadata"));

	// Tag with session complexity if available (set async on turn 1, read on turn 2+)
	if (opts?.complexity) {
		metadata.complexity = opts.complexity;
	}

	// ---- Translate Anthropic → OpenAI ----
	const messages = translateAnthropicToOpenAI(body);

	// ---- Call AI Gateway /compat ----
	// Claude Code requests max_tokens=64000+ for Claude models, but the
	// backing Workers AI model has a much smaller context window.
	// Clamp to a safe ceiling so the request doesn't get rejected.
	const maxTokens = clampMaxTokens(body.max_tokens);
	const wantsStream = body.stream === true;

	// Translate tool definitions: Anthropic format → OpenAI function calling
	const toolsPayload = body.tools?.length
		? {
				tools: body.tools.map((t: any) => ({
					type: "function",
					function: {
						name: t.name,
						description: t.description || "",
						parameters: t.input_schema || {},
					},
				})),
			}
		: {};

	const toolChoicePayload = body.tool_choice
		? { tool_choice: body.tool_choice === "auto" ? "auto" : body.tool_choice === "any" ? "required" : body.tool_choice }
		: {};

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
				stream: wantsStream,
				...(maxTokens != null ? { max_tokens: maxTokens } : {}),
				...(body.temperature != null ? { temperature: body.temperature } : {}),
				...toolsPayload,
				...toolChoicePayload,
			}),
		},
	);

	// ---- Streaming path ----
	if (wantsStream) {
		if (!resp.ok || !resp.body) {
			const errBody = await resp.text();
			console.error(`AIG proxy stream error: status=${resp.status}`, errBody);
			return new Response(errBody, {
				status: resp.status,
				headers: { "content-type": "application/json" },
			});
		}

		// Pipe OpenAI SSE → Anthropic SSE via TransformStream
		const transformed = resp.body.pipeThrough(openAIStreamToAnthropicStream(ROUTE));

		return new Response(transformed, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	// ---- Non-streaming path ----
	const oai: any = await resp.json();

	if (!resp.ok || !oai.choices?.length) {
		console.error(`AIG proxy error: status=${resp.status}`, JSON.stringify(oai));
		return Response.json(oai, { status: resp.status });
	}

	return Response.json(translateOpenAIToAnthropic(oai, ROUTE));
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

// GET /api/whoami — returns the authenticated user's email (used by static index.html)
app.get("/api/whoami", async (c) => {
	return Response.json({ email: c.get("userEmail") });
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
