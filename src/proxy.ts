// ---------------------------------------------------------------------------
// Proxy utilities — pure functions extracted for testability.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

export function base64urlDecode(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export interface AccessJwtPayload {
	email?: string;
	sub?: string;
	aud?: string | string[];
	iss?: string;
	exp?: number;
	iat?: number;
	[key: string]: unknown;
}

export function decodeJwtPayload(token: string): AccessJwtPayload {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid JWT format");
	return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
}

export function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid JWT format");
	return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
}

// ---------------------------------------------------------------------------
// Anthropic <-> OpenAI format translation
// ---------------------------------------------------------------------------

export interface AnthropicMessage {
	role: string;
	content: string | Array<{ type?: string; text?: string }>;
}

export interface AnthropicRequestBody {
	system?: string | Array<{ text?: string }>;
	messages?: AnthropicMessage[];
	max_tokens?: number;
	temperature?: number;
	model?: string;
}

export interface OpenAIMessage {
	role: string;
	content: string;
}

/**
 * Translates an Anthropic Messages API request body into an array of
 * OpenAI Chat Completions messages.
 */
export function translateAnthropicToOpenAI(body: AnthropicRequestBody): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [];

	if (body.system) {
		const text =
			typeof body.system === "string"
				? body.system
				: body.system.map((b) => b.text || "").join("\n");
		messages.push({ role: "system", content: text });
	}

	for (const m of body.messages || []) {
		messages.push({
			role: m.role,
			content:
				typeof m.content === "string"
					? m.content
					: m.content.map((b) => b.text || "").join(""),
		});
	}

	return messages;
}

export interface OpenAIResponse {
	id?: string;
	model?: string;
	choices?: Array<{
		message?: { content?: string };
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

/**
 * Translates an OpenAI Chat Completions response into an Anthropic
 * Messages API response body.
 */
export function translateOpenAIToAnthropic(oai: OpenAIResponse, route: string) {
	const choice = oai.choices?.[0];
	return {
		id: oai.id || "msg_proxy",
		type: "message" as const,
		role: "assistant" as const,
		model: oai.model || route,
		content: [{ type: "text" as const, text: choice?.message?.content || "" }],
		stop_reason: choice?.finish_reason === "stop" ? "end_turn" : choice?.finish_reason,
		usage: {
			input_tokens: oai.usage?.prompt_tokens || 0,
			output_tokens: oai.usage?.completion_tokens || 0,
		},
	};
}

// ---------------------------------------------------------------------------
// max_tokens clamping
// ---------------------------------------------------------------------------

export const MAX_TOKENS_CEILING = 8192;

/**
 * Clamps max_tokens to the ceiling value. Returns undefined if not set.
 */
export function clampMaxTokens(maxTokens: number | undefined | null): number | undefined {
	if (maxTokens == null) return undefined;
	return Math.min(maxTokens, MAX_TOKENS_CEILING);
}

// ---------------------------------------------------------------------------
// Task complexity classification
// ---------------------------------------------------------------------------

export type Complexity = "low" | "medium" | "high";

export const COMPLEXITY_MODEL = "@cf/meta/llama-3.2-1b-instruct";

export const COMPLEXITY_SYSTEM_PROMPT =
	"You are a task-complexity classifier for a coding assistant. Read the " +
	"user's request and classify how complex it will be to fulfill. Reply " +
	"with exactly one word — low, medium, or high — and nothing else.\n" +
	"- low: quick, narrow tasks (answer a question, summarize, small lookup, trivial edit)\n" +
	"- medium: a bounded task needing several steps (a single feature, bug fix, or refactor)\n" +
	"- high: large or open-ended engineering work spanning many systems/steps " +
	"(e.g. end-to-end app design, architecture, infra automation, security integrations)";

/**
 * Extracts the text of the original user task from an Anthropic-format
 * request body. Scans messages in order and returns the first `user`
 * message that contains actual text (skipping tool_result-only messages),
 * so the classification reflects the overall task rather than a single
 * tool round-trip.
 */
export function extractTaskText(body: AnthropicRequestBody): string | null {
	for (const m of body.messages || []) {
		if (m.role !== "user") continue;
		if (typeof m.content === "string") {
			const text = m.content.trim();
			if (text) return text;
		} else if (Array.isArray(m.content)) {
			const text = m.content
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text || "")
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return null;
}

/**
 * Parses a raw model response string into a Complexity value.
 * Returns undefined if the response doesn't contain a valid classification.
 */
export function parseComplexity(raw: string): Complexity | undefined {
	const text = raw.trim().toLowerCase();
	if (text.includes("high")) return "high";
	if (text.includes("medium")) return "medium";
	if (text.includes("low")) return "low";
	return undefined;
}

/**
 * Deterministic 32-bit FNV-1a hash, normalized to [0, 1).
 * Used to bucket a user into the rollout sample so the same user
 * consistently lands on the same side of the threshold across an
 * agentic task's multiple requests.
 */
export function hashToUnitInterval(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) / 0xffffffff;
}

/**
 * Gate for the complexity classification rollout.
 * @param enabled - global on/off toggle
 * @param sampleRate - 0..1 fraction of users to include
 * @param user - user identifier for deterministic bucketing
 */
export function shouldClassifyComplexity(enabled: boolean, sampleRate: number, user: string): boolean {
	if (!enabled) return false;
	if (sampleRate >= 1) return true;
	if (sampleRate <= 0) return false;
	return hashToUnitInterval(user) < sampleRate;
}

// ---------------------------------------------------------------------------
// Metadata resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the user identity for AIG metadata tagging.
 * Priority: Access JWT user > outbound handler user > x-metadata > "unknown"
 */
export function resolveMetadata(
	opts?: { user?: string },
	accessUser?: string | null,
	xMetadataHeader?: string | null,
): Record<string, string> {
	const metadata: Record<string, string> = { source: "claude-code", user: "unknown" };
	try {
		Object.assign(metadata, JSON.parse(xMetadataHeader || "{}"));
	} catch {}

	if (accessUser) {
		metadata.user = accessUser;
	} else if (opts?.user) {
		metadata.user = opts.user;
	}

	return metadata;
}
