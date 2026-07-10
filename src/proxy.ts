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

export interface AnthropicContentBlock {
	type?: string;
	text?: string;
	// tool_use fields
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	// tool_result fields
	tool_use_id?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

export interface AnthropicMessage {
	role: string;
	content: string | AnthropicContentBlock[];
}

export interface AnthropicRequestBody {
	system?: string | Array<{ text?: string }>;
	messages?: AnthropicMessage[];
	max_tokens?: number;
	temperature?: number;
	model?: string;
	tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
	tool_choice?: string | Record<string, unknown>;
}

export interface OpenAIMessage {
	role: string;
	content: string;
}

/**
 * Translates an Anthropic Messages API request body into an array of
 * OpenAI Chat Completions messages. Handles text, tool_use (assistant),
 * and tool_result (user) content blocks.
 */
export function translateAnthropicToOpenAI(body: AnthropicRequestBody): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];

	if (body.system) {
		const text =
			typeof body.system === "string"
				? body.system
				: body.system.map((b) => b.text || "").join("\n");
		messages.push({ role: "system", content: text });
	}

	for (const m of body.messages || []) {
		if (typeof m.content === "string") {
			messages.push({ role: m.role, content: m.content });
			continue;
		}

		// Array content — may contain text, tool_use, or tool_result blocks
		const textParts: string[] = [];
		const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
		const toolResults: Array<{ role: string; tool_call_id: string; content: string }> = [];

		for (const block of m.content) {
			if (block.type === "text") {
				textParts.push(block.text || "");
			} else if (block.type === "tool_use") {
				toolCalls.push({
					id: block.id || "",
					type: "function",
					function: {
						name: block.name || "",
						arguments: JSON.stringify(block.input || {}),
					},
				});
			} else if (block.type === "tool_result") {
				const resultContent = typeof block.content === "string"
					? block.content
					: Array.isArray(block.content)
						? block.content.map((b: any) => b.text || "").join("")
						: "";
				toolResults.push({
					role: "tool",
					tool_call_id: block.tool_use_id || "",
					content: resultContent,
				});
			}
		}

		if (m.role === "assistant" && toolCalls.length > 0) {
			// Assistant message with tool calls
			const msg: Record<string, unknown> = {
				role: "assistant",
				content: textParts.join("") || null,
				tool_calls: toolCalls,
			};
			messages.push(msg);
		} else if (toolResults.length > 0) {
			// Tool results → individual tool role messages in OpenAI format
			for (const tr of toolResults) {
				messages.push(tr);
			}
		} else {
			messages.push({ role: m.role, content: textParts.join("") });
		}
	}

	return messages;
}

export interface OpenAIToolCall {
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

export interface OpenAIResponse {
	id?: string;
	model?: string;
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: OpenAIToolCall[];
		};
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

/**
 * Translates an OpenAI Chat Completions response into an Anthropic
 * Messages API response body. Handles both text responses and tool_calls
 * (mapped to Anthropic tool_use content blocks).
 */
export function translateOpenAIToAnthropic(oai: OpenAIResponse, route: string) {
	const choice = oai.choices?.[0];
	const content: Array<Record<string, unknown>> = [];

	// Add text content if present
	if (choice?.message?.content) {
		content.push({ type: "text", text: choice.message.content });
	}

	// Convert OpenAI tool_calls → Anthropic tool_use blocks
	if (choice?.message?.tool_calls?.length) {
		for (const tc of choice.message.tool_calls) {
			let input: Record<string, unknown> = {};
			try {
				input = JSON.parse(tc.function?.arguments || "{}");
			} catch {}
			content.push({
				type: "tool_use",
				id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
				name: tc.function?.name || "unknown",
				input,
			});
		}
	}

	// Fallback: if no content at all, return empty text
	if (content.length === 0) {
		content.push({ type: "text", text: "" });
	}

	// Map finish_reason: "tool_calls" → "tool_use", "stop" → "end_turn"
	let stopReason = choice?.finish_reason;
	if (stopReason === "tool_calls") stopReason = "tool_use";
	else if (stopReason === "stop") stopReason = "end_turn";

	return {
		id: oai.id || "msg_proxy",
		type: "message" as const,
		role: "assistant" as const,
		model: oai.model || route,
		content,
		stop_reason: stopReason,
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

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE → Anthropic SSE TransformStream
// ---------------------------------------------------------------------------

/** Format a single Anthropic SSE event. */
function sseEvent(eventName: string, data: Record<string, unknown>): string {
	return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * State machine that transforms an OpenAI streaming response (SSE chunks
 * with `choices[0].delta.*`) into Anthropic Messages streaming events.
 *
 * Handles:
 * - Text content deltas → text_delta
 * - Tool call deltas (incremental function arguments) → input_json_delta
 * - Finish reasons → content_block_stop + message_delta + message_stop
 *
 * Returns a function that processes one parsed OpenAI chunk at a time and
 * returns zero or more Anthropic SSE event strings.
 */
export function createStreamTransformer(route: string, messageId: string) {
	let contentBlockIndex = 0;
	let hasOpenTextBlock = false;
	// Track active tool calls by their OpenAI index
	const activeToolCalls = new Map<number, { anthropicIndex: number; id: string; name: string }>();
	let inputTokens = 0;
	let outputTokens = 0;
	let started = false;

	return function processChunk(chunk: any): string {
		let out = "";

		// Emit message_start on first chunk
		if (!started) {
			started = true;
			out += sseEvent("message_start", {
				type: "message_start",
				message: {
					id: messageId,
					type: "message",
					role: "assistant",
					content: [],
					model: chunk.model || route,
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			});
		}

		const choice = chunk.choices?.[0];
		if (!choice) return out;

		const delta = choice.delta || {};

		// --- Text content ---
		if (delta.content != null && delta.content !== "") {
			if (!hasOpenTextBlock) {
				out += sseEvent("content_block_start", {
					type: "content_block_start",
					index: contentBlockIndex,
					content_block: { type: "text", text: "" },
				});
				hasOpenTextBlock = true;
			}
			out += sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: contentBlockIndex,
				delta: { type: "text_delta", text: delta.content },
			});
		}

		// --- Tool calls ---
		if (delta.tool_calls) {
			// Close text block before starting tool blocks
			if (hasOpenTextBlock) {
				out += sseEvent("content_block_stop", {
					type: "content_block_stop",
					index: contentBlockIndex,
				});
				contentBlockIndex++;
				hasOpenTextBlock = false;
			}

			for (const tc of delta.tool_calls) {
				const tcIndex = tc.index ?? 0;

				if (!activeToolCalls.has(tcIndex)) {
					// New tool call — emit content_block_start
					const toolId = tc.id || `toolu_${Math.random().toString(36).slice(2, 14)}`;
					const toolName = tc.function?.name || "unknown";
					activeToolCalls.set(tcIndex, {
						anthropicIndex: contentBlockIndex,
						id: toolId,
						name: toolName,
					});
					out += sseEvent("content_block_start", {
						type: "content_block_start",
						index: contentBlockIndex,
						content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
					});
				}

				// Emit argument deltas
				if (tc.function?.arguments) {
					const info = activeToolCalls.get(tcIndex)!;
					out += sseEvent("content_block_delta", {
						type: "content_block_delta",
						index: info.anthropicIndex,
						delta: { type: "input_json_delta", partial_json: tc.function.arguments },
					});
				}
			}
		}

		// --- Usage ---
		if (chunk.usage) {
			inputTokens = chunk.usage.prompt_tokens || inputTokens;
			outputTokens = chunk.usage.completion_tokens || outputTokens;
		}

		// --- Finish ---
		if (choice.finish_reason) {
			// Close any open text block
			if (hasOpenTextBlock) {
				out += sseEvent("content_block_stop", {
					type: "content_block_stop",
					index: contentBlockIndex,
				});
				contentBlockIndex++;
				hasOpenTextBlock = false;
			}

			// Close any open tool call blocks
			for (const [, info] of activeToolCalls) {
				out += sseEvent("content_block_stop", {
					type: "content_block_stop",
					index: info.anthropicIndex,
				});
				contentBlockIndex++;
			}
			activeToolCalls.clear();

			// Map stop reason
			let stopReason = choice.finish_reason;
			if (stopReason === "stop") stopReason = "end_turn";
			else if (stopReason === "tool_calls") stopReason = "tool_use";

			out += sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: stopReason, stop_sequence: null },
				usage: { output_tokens: outputTokens },
			});
			out += sseEvent("message_stop", { type: "message_stop" });
		}

		return out;
	};
}

/**
 * Creates a TransformStream that converts an OpenAI SSE byte stream into
 * an Anthropic SSE byte stream. Handles line buffering, chunk parsing,
 * and the [DONE] sentinel.
 */
export function openAIStreamToAnthropicStream(route: string, messageId?: string): TransformStream<Uint8Array, Uint8Array> {
	const id = messageId || `msg_${Math.random().toString(36).slice(2, 14)}`;
	const processChunk = createStreamTransformer(route, id);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let buffer = "";

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			// Keep the last incomplete line in the buffer
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith(":")) continue; // skip empty/comments
				if (trimmed === "data: [DONE]") continue; // OpenAI end sentinel

				if (trimmed.startsWith("data: ")) {
					try {
						const parsed = JSON.parse(trimmed.slice(6));
						const events = processChunk(parsed);
						if (events) {
							controller.enqueue(encoder.encode(events));
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}
		},
		flush(controller) {
			// Process any remaining buffer
			if (buffer.trim()) {
				const trimmed = buffer.trim();
				if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
					try {
						const parsed = JSON.parse(trimmed.slice(6));
						const events = processChunk(parsed);
						if (events) {
							controller.enqueue(encoder.encode(events));
						}
					} catch {}
				}
			}
		},
	});
}
