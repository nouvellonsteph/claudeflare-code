import { describe, it, expect } from "vitest";
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
	hashToUnitInterval,
	shouldClassifyComplexity,
	isNewSession,
	createStreamTransformer,
	openAIStreamToAnthropicStream,
	MAX_TOKENS_CEILING,
} from "../src/proxy";

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

describe("base64urlDecode", () => {
	it("decodes a standard base64url string", () => {
		// "hello" = aGVsbG8 in base64url
		const bytes = base64urlDecode("aGVsbG8");
		expect(new TextDecoder().decode(bytes)).toBe("hello");
	});

	it("handles base64url chars (- and _)", () => {
		// Base64url uses - instead of + and _ instead of /
		const standard = btoa("\xfb\xff\xfe"); // +/+/
		const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const bytes = base64urlDecode(urlSafe);
		expect(bytes[0]).toBe(0xfb);
		expect(bytes[1]).toBe(0xff);
		expect(bytes[2]).toBe(0xfe);
	});
});

// Build a fake JWT with the given header and payload (no real signature needed for decode tests)
function fakeJwt(header: object, payload: object): string {
	const enc = (obj: object) =>
		btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	return `${enc(header)}.${enc(payload)}.fakesig`;
}

describe("decodeJwtPayload", () => {
	it("decodes the payload from a JWT", () => {
		const token = fakeJwt({ alg: "RS256" }, { email: "alice@example.com", sub: "user-1" });
		const payload = decodeJwtPayload(token);
		expect(payload.email).toBe("alice@example.com");
		expect(payload.sub).toBe("user-1");
	});

	it("throws on invalid JWT format", () => {
		expect(() => decodeJwtPayload("not-a-jwt")).toThrow("Invalid JWT format");
		expect(() => decodeJwtPayload("two.parts")).toThrow("Invalid JWT format");
	});
});

describe("decodeJwtHeader", () => {
	it("decodes the header from a JWT", () => {
		const token = fakeJwt({ alg: "RS256", kid: "key-1" }, { email: "a@b.c" });
		const header = decodeJwtHeader(token);
		expect(header.alg).toBe("RS256");
		expect(header.kid).toBe("key-1");
	});

	it("throws on invalid JWT format", () => {
		expect(() => decodeJwtHeader("bad")).toThrow("Invalid JWT format");
	});
});

// ---------------------------------------------------------------------------
// Anthropic <-> OpenAI translation
// ---------------------------------------------------------------------------

describe("translateAnthropicToOpenAI", () => {
	it("converts system string + messages", () => {
		const result = translateAnthropicToOpenAI({
			system: "You are helpful.",
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
			],
		});
		expect(result).toEqual([
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		]);
	});

	it("converts system array (content blocks)", () => {
		const result = translateAnthropicToOpenAI({
			system: [{ text: "Be concise." }, { text: " Be helpful." }],
			messages: [],
		});
		expect(result).toEqual([{ role: "system", content: "Be concise.\n Be helpful." }]);
	});

	it("converts content block arrays in messages", () => {
		const result = translateAnthropicToOpenAI({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Part 1 " },
						{ type: "text", text: "Part 2" },
					],
				},
			],
		});
		expect(result).toEqual([{ role: "user", content: "Part 1 Part 2" }]);
	});

	it("handles empty input", () => {
		expect(translateAnthropicToOpenAI({})).toEqual([]);
	});

	it("handles messages with no system prompt", () => {
		const result = translateAnthropicToOpenAI({
			messages: [{ role: "user", content: "Just a question" }],
		});
		expect(result).toEqual([{ role: "user", content: "Just a question" }]);
	});
});

describe("translateOpenAIToAnthropic", () => {
	it("translates a successful OpenAI response", () => {
		const oai = {
			id: "chatcmpl-123",
			model: "gpt-4",
			choices: [
				{
					message: { content: "Hello there!" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		};
		const result = translateOpenAIToAnthropic(oai, "dynamic/my-gw");
		expect(result).toEqual({
			id: "chatcmpl-123",
			type: "message",
			role: "assistant",
			model: "gpt-4",
			content: [{ type: "text", text: "Hello there!" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		});
	});

	it("maps non-stop finish reasons directly", () => {
		const oai = {
			choices: [{ message: { content: "..." }, finish_reason: "length" }],
		};
		const result = translateOpenAIToAnthropic(oai, "route");
		expect(result.stop_reason).toBe("length");
	});

	it("uses fallback values for missing fields", () => {
		const oai = { choices: [{ message: {}, finish_reason: "stop" }] };
		const result = translateOpenAIToAnthropic(oai, "dynamic/test");
		expect(result.id).toBe("msg_proxy");
		expect(result.model).toBe("dynamic/test");
		expect(result.content[0].text).toBe("");
		expect(result.usage.input_tokens).toBe(0);
		expect(result.usage.output_tokens).toBe(0);
	});

	it("handles empty choices", () => {
		const result = translateOpenAIToAnthropic({}, "route");
		expect(result.content[0].text).toBe("");
	});

	it("translates tool_calls to Anthropic tool_use blocks", () => {
		const oai = {
			id: "chatcmpl-456",
			model: "gpt-4",
			choices: [
				{
					message: {
						content: "Let me check that.",
						tool_calls: [
							{
								id: "call_abc123",
								type: "function",
								function: {
									name: "Bash",
									arguments: '{"command":"ls -la"}',
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 20, completion_tokens: 10 },
		};
		const result = translateOpenAIToAnthropic(oai, "route");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Let me check that." });
		expect(result.content[1]).toEqual({
			type: "tool_use",
			id: "call_abc123",
			name: "Bash",
			input: { command: "ls -la" },
		});
		expect(result.stop_reason).toBe("tool_use");
	});

	it("translates tool_calls with no text content", () => {
		const oai = {
			choices: [
				{
					message: {
						content: null,
						tool_calls: [
							{
								id: "call_xyz",
								type: "function",
								function: {
									name: "Read",
									arguments: '{"path":"/tmp/file.txt"}',
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		};
		const result = translateOpenAIToAnthropic(oai, "route");
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("tool_use");
		expect(result.content[0].name).toBe("Read");
	});

	it("translates multiple tool_calls", () => {
		const oai = {
			choices: [
				{
					message: {
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "Bash", arguments: '{"command":"pwd"}' },
							},
							{
								id: "call_2",
								type: "function",
								function: { name: "Read", arguments: '{"path":"."}' },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		};
		const result = translateOpenAIToAnthropic(oai, "route");
		expect(result.content).toHaveLength(2);
		expect(result.content[0].name).toBe("Bash");
		expect(result.content[1].name).toBe("Read");
		expect(result.stop_reason).toBe("tool_use");
	});
});

describe("translateAnthropicToOpenAI — tool messages", () => {
	it("converts assistant tool_use blocks to OpenAI tool_calls", () => {
		const result = translateAnthropicToOpenAI({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check." },
						{
							type: "tool_use",
							id: "toolu_abc",
							name: "Bash",
							input: { command: "ls" },
						},
					],
				},
			],
		});
		expect(result).toHaveLength(1);
		const msg = result[0] as any;
		expect(msg.role).toBe("assistant");
		expect(msg.content).toBe("Let me check.");
		expect(msg.tool_calls).toHaveLength(1);
		expect(msg.tool_calls[0].id).toBe("toolu_abc");
		expect(msg.tool_calls[0].function.name).toBe("Bash");
		expect(msg.tool_calls[0].function.arguments).toBe('{"command":"ls"}');
	});

	it("converts user tool_result blocks to OpenAI tool messages", () => {
		const result = translateAnthropicToOpenAI({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_abc",
							content: "file1.txt\nfile2.txt",
						},
					],
				},
			],
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			role: "tool",
			tool_call_id: "toolu_abc",
			content: "file1.txt\nfile2.txt",
		});
	});
});

// ---------------------------------------------------------------------------
// max_tokens clamping
// ---------------------------------------------------------------------------

describe("clampMaxTokens", () => {
	it("clamps values above the ceiling", () => {
		expect(clampMaxTokens(64000)).toBe(MAX_TOKENS_CEILING);
		expect(clampMaxTokens(100000)).toBe(MAX_TOKENS_CEILING);
	});

	it("passes through values at or below ceiling", () => {
		expect(clampMaxTokens(4096)).toBe(4096);
		expect(clampMaxTokens(MAX_TOKENS_CEILING)).toBe(MAX_TOKENS_CEILING);
		expect(clampMaxTokens(1)).toBe(1);
	});

	it("returns undefined for null/undefined", () => {
		expect(clampMaxTokens(undefined)).toBeUndefined();
		expect(clampMaxTokens(null)).toBeUndefined();
	});

	it("ceiling is 8192", () => {
		expect(MAX_TOKENS_CEILING).toBe(8192);
	});
});

// ---------------------------------------------------------------------------
// Metadata resolution
// ---------------------------------------------------------------------------

describe("resolveMetadata", () => {
	it("defaults to source=claude-code, user=unknown", () => {
		const m = resolveMetadata();
		expect(m.source).toBe("claude-code");
		expect(m.user).toBe("unknown");
	});

	it("prefers accessUser over opts.user", () => {
		const m = resolveMetadata({ user: "container@x.com" }, "access@y.com");
		expect(m.user).toBe("access@y.com");
	});

	it("falls back to opts.user when accessUser is null", () => {
		const m = resolveMetadata({ user: "container@x.com" }, null);
		expect(m.user).toBe("container@x.com");
	});

	it("merges x-metadata header JSON", () => {
		const m = resolveMetadata(undefined, "a@b.c", JSON.stringify({ custom: "value" }));
		expect(m.custom).toBe("value");
		expect(m.user).toBe("a@b.c"); // accessUser overrides any user in x-metadata
	});

	it("handles malformed x-metadata gracefully", () => {
		const m = resolveMetadata(undefined, null, "not-json");
		expect(m.source).toBe("claude-code");
		expect(m.user).toBe("unknown");
	});

	it("accessUser overrides user from x-metadata", () => {
		const m = resolveMetadata(undefined, "real@cf.com", JSON.stringify({ user: "fake@bad.com" }));
		expect(m.user).toBe("real@cf.com");
	});
});

// ---------------------------------------------------------------------------
// Session detection
// ---------------------------------------------------------------------------

describe("isNewSession", () => {
	it("returns true for a single user message (first turn)", () => {
		const body = { messages: [{ role: "user", content: "Build a REST API" }] };
		expect(isNewSession(body)).toBe(true);
	});

	it("returns true for a single user message with content blocks", () => {
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
		};
		expect(isNewSession(body)).toBe(true);
	});

	it("returns false when assistant messages are present (continuation)", () => {
		const body = {
			messages: [
				{ role: "user", content: "Build a REST API" },
				{ role: "assistant", content: "Sure, let me help." },
				{ role: "user", content: "Use Express" },
			],
		};
		expect(isNewSession(body)).toBe(false);
	});

	it("returns false for empty messages", () => {
		expect(isNewSession({ messages: [] })).toBe(false);
		expect(isNewSession({})).toBe(false);
	});

	it("returns false when multiple user messages exist without assistant", () => {
		const body = {
			messages: [
				{ role: "user", content: "First message" },
				{ role: "user", content: "Second message" },
			],
		};
		expect(isNewSession(body)).toBe(false);
	});

	it("returns true with system prompt and single user message", () => {
		const body = {
			system: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello" }],
		};
		expect(isNewSession(body)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Task complexity classification
// ---------------------------------------------------------------------------

describe("extractTaskText", () => {
	it("extracts text from a simple string message", () => {
		const body = { messages: [{ role: "user", content: "Build a REST API" }] };
		expect(extractTaskText(body)).toBe("Build a REST API");
	});

	it("extracts text from content block arrays", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Refactor the " },
						{ type: "text", text: "database layer" },
					],
				},
			],
		};
		expect(extractTaskText(body)).toBe("Refactor the \ndatabase layer");
	});

	it("skips assistant messages and returns first user message", () => {
		const body = {
			messages: [
				{ role: "assistant", content: "How can I help?" },
				{ role: "user", content: "Fix the login bug" },
				{ role: "user", content: "Also update tests" },
			],
		};
		expect(extractTaskText(body)).toBe("Fix the login bug");
	});

	it("skips tool_result-only content blocks", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [{ type: "tool_result", text: "some result" }],
				},
				{ role: "user", content: "The actual task" },
			],
		};
		expect(extractTaskText(body)).toBe("The actual task");
	});

	it("returns null for empty messages", () => {
		expect(extractTaskText({ messages: [] })).toBeNull();
		expect(extractTaskText({})).toBeNull();
	});

	it("returns null when all user messages are empty strings", () => {
		const body = {
			messages: [
				{ role: "user", content: "   " },
			],
		};
		expect(extractTaskText(body)).toBeNull();
	});
});

describe("parseComplexity", () => {
	it("parses 'low'", () => {
		expect(parseComplexity("low")).toBe("low");
		expect(parseComplexity("Low")).toBe("low");
		expect(parseComplexity("  LOW  ")).toBe("low");
	});

	it("parses 'medium'", () => {
		expect(parseComplexity("medium")).toBe("medium");
		expect(parseComplexity("Medium.")).toBe("medium");
	});

	it("parses 'high'", () => {
		expect(parseComplexity("high")).toBe("high");
		expect(parseComplexity("HIGH")).toBe("high");
	});

	it("returns undefined for unrecognized values", () => {
		expect(parseComplexity("")).toBeUndefined();
		expect(parseComplexity("moderate")).toBeUndefined();
		expect(parseComplexity("5")).toBeUndefined();
	});

	it("extracts from verbose responses", () => {
		expect(parseComplexity("I think this is high complexity")).toBe("high");
		expect(parseComplexity("This task is of medium difficulty")).toBe("medium");
	});
});

describe("hashToUnitInterval", () => {
	it("returns a value in [0, 1)", () => {
		const val = hashToUnitInterval("alice@example.com");
		expect(val).toBeGreaterThanOrEqual(0);
		expect(val).toBeLessThan(1);
	});

	it("is deterministic (same input = same output)", () => {
		const a = hashToUnitInterval("bob@test.com");
		const b = hashToUnitInterval("bob@test.com");
		expect(a).toBe(b);
	});

	it("produces different values for different inputs", () => {
		const a = hashToUnitInterval("alice@test.com");
		const b = hashToUnitInterval("bob@test.com");
		expect(a).not.toBe(b);
	});
});

describe("shouldClassifyComplexity", () => {
	it("returns false when disabled", () => {
		expect(shouldClassifyComplexity(false, 1, "user@test.com")).toBe(false);
	});

	it("returns true when enabled with sampleRate=1", () => {
		expect(shouldClassifyComplexity(true, 1, "user@test.com")).toBe(true);
	});

	it("returns false when sampleRate=0", () => {
		expect(shouldClassifyComplexity(true, 0, "user@test.com")).toBe(false);
	});

	it("is deterministic per user (same user always gets same result)", () => {
		const r1 = shouldClassifyComplexity(true, 0.5, "consistent@test.com");
		const r2 = shouldClassifyComplexity(true, 0.5, "consistent@test.com");
		expect(r1).toBe(r2);
	});

	it("partitions users deterministically at 50%", () => {
		// With enough users, roughly half should be included at 50% sample rate.
		// We test that it's not all-or-nothing.
		const users = Array.from({ length: 100 }, (_, i) => `user${i}@test.com`);
		const included = users.filter((u) => shouldClassifyComplexity(true, 0.5, u));
		expect(included.length).toBeGreaterThan(20);
		expect(included.length).toBeLessThan(80);
	});
});

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE → Anthropic SSE
// ---------------------------------------------------------------------------

describe("createStreamTransformer", () => {
	it("emits message_start on first chunk", () => {
		const process = createStreamTransformer("dynamic/gw", "msg_test");
		const out = process({ model: "gpt-4", choices: [{ delta: { role: "assistant" } }] });
		expect(out).toContain("event: message_start");
		expect(out).toContain('"type":"message_start"');
		expect(out).toContain('"id":"msg_test"');
	});

	it("emits text content_block_start and text_delta", () => {
		const process = createStreamTransformer("route", "msg_1");
		// First chunk triggers message_start
		process({ choices: [{ delta: { role: "assistant" } }] });
		// Text chunk
		const out = process({ choices: [{ delta: { content: "Hello" } }] });
		expect(out).toContain("event: content_block_start");
		expect(out).toContain('"type":"text"');
		expect(out).toContain("event: content_block_delta");
		expect(out).toContain('"type":"text_delta"');
		expect(out).toContain('"text":"Hello"');
	});

	it("streams multiple text deltas without reopening the block", () => {
		const process = createStreamTransformer("route", "msg_1");
		process({ choices: [{ delta: { role: "assistant" } }] });
		const out1 = process({ choices: [{ delta: { content: "Hello" } }] });
		const out2 = process({ choices: [{ delta: { content: " world" } }] });
		// First delta opens the block
		expect(out1).toContain("event: content_block_start");
		// Second delta does NOT reopen it
		expect(out2).not.toContain("event: content_block_start");
		expect(out2).toContain('"text":" world"');
	});

	it("emits tool_use blocks from tool_calls delta", () => {
		const process = createStreamTransformer("route", "msg_1");
		process({ choices: [{ delta: { role: "assistant" } }] });
		const out = process({
			choices: [{
				delta: {
					tool_calls: [{
						index: 0,
						id: "call_abc",
						function: { name: "Bash", arguments: '{"command":' },
					}],
				},
			}],
		});
		expect(out).toContain("event: content_block_start");
		expect(out).toContain('"type":"tool_use"');
		expect(out).toContain('"name":"Bash"');
		expect(out).toContain("event: content_block_delta");
		expect(out).toContain('"type":"input_json_delta"');
		expect(out).toContain('"partial_json":"{\\"command\\":');
	});

	it("accumulates tool call argument deltas", () => {
		const process = createStreamTransformer("route", "msg_1");
		process({ choices: [{ delta: { role: "assistant" } }] });
		// First delta — opens the tool block
		process({
			choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"path":' } }] } }],
		});
		// Second delta — appends arguments
		const out = process({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp"}' } }] } }],
		});
		// Should NOT open a new block
		expect(out).not.toContain("event: content_block_start");
		expect(out).toContain('"partial_json":"\\"/tmp\\"}"');
	});

	it("emits content_block_stop + message_delta + message_stop on finish", () => {
		const process = createStreamTransformer("route", "msg_1");
		process({ choices: [{ delta: { role: "assistant" } }] });
		process({ choices: [{ delta: { content: "Hi" } }] });
		const out = process({ choices: [{ delta: {}, finish_reason: "stop" }] });
		expect(out).toContain("event: content_block_stop");
		expect(out).toContain("event: message_delta");
		expect(out).toContain('"stop_reason":"end_turn"');
		expect(out).toContain("event: message_stop");
	});

	it("maps finish_reason tool_calls to stop_reason tool_use", () => {
		const process = createStreamTransformer("route", "msg_1");
		process({ choices: [{ delta: { role: "assistant" } }] });
		process({
			choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: '{}' } }] } }],
		});
		const out = process({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
		expect(out).toContain('"stop_reason":"tool_use"');
	});
});

describe("openAIStreamToAnthropicStream", () => {
	it("transforms a complete OpenAI SSE stream to Anthropic SSE", async () => {
		const openAISSE = [
			'data: {"id":"cmpl-1","model":"gpt-4","choices":[{"delta":{"role":"assistant","content":""},"index":0}]}',
			'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
			'data: {"choices":[{"delta":{"content":"!"},"index":0}]}',
			'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
			"data: [DONE]",
		].join("\n") + "\n";

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const input = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(openAISSE));
				controller.close();
			},
		});

		const output = input.pipeThrough(openAIStreamToAnthropicStream("route"));
		const reader = output.getReader();
		let result = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value);
		}

		expect(result).toContain("event: message_start");
		expect(result).toContain("event: content_block_start");
		expect(result).toContain('"type":"text_delta"');
		expect(result).toContain('"text":"Hello"');
		expect(result).toContain('"text":"!"');
		expect(result).toContain("event: content_block_stop");
		expect(result).toContain("event: message_delta");
		expect(result).toContain('"stop_reason":"end_turn"');
		expect(result).toContain("event: message_stop");
	});
});
