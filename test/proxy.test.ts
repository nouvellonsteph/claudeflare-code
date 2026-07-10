import { describe, it, expect } from "vitest";
import {
	base64urlDecode,
	decodeJwtPayload,
	decodeJwtHeader,
	translateAnthropicToOpenAI,
	translateOpenAIToAnthropic,
	clampMaxTokens,
	resolveMetadata,
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
