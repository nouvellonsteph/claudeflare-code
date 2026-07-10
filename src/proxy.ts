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
