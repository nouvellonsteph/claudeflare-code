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
