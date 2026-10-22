import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	buildNamingPrompt,
	clip,
	fallbackTitle,
	firstExchange,
	mergeConfig,
	sanitizeTitle,
} from "../extensions/session-autoname/naming.ts";

test("mergeConfig keeps defaults for bad input", () => {
	assert.deepEqual(mergeConfig(undefined), DEFAULT_CONFIG);
	assert.deepEqual(mergeConfig({ enabled: "no", maxLength: 2, timeoutMs: 10 }), DEFAULT_CONFIG);
	assert.deepEqual(mergeConfig({ enabled: false, model: " cpamc/x ", maxLength: 24.7 }), {
		...DEFAULT_CONFIG,
		enabled: false,
		model: "cpamc/x",
		maxLength: 24,
	});
});

test("sanitizeTitle strips quotes, prefixes, punctuation and extra lines", () => {
	assert.equal(sanitizeTitle('"Fix login redirect bug."'), "Fix login redirect bug");
	assert.equal(sanitizeTitle("Title: Add pagination to users API"), "Add pagination to users API");
	assert.equal(sanitizeTitle("标题：开发会话自动命名扩展。\n解释……"), "开发会话自动命名扩展");
	assert.equal(sanitizeTitle("「排查 CPA 503」"), "排查 CPA 503");
	assert.equal(sanitizeTitle("**Refactor auth**"), "Refactor auth");
	assert.equal(sanitizeTitle("<think>hmm</think>\n\nUpgrade deps"), "Upgrade deps");
	assert.equal(sanitizeTitle("   \n  "), "");
});

test("sanitizeTitle clips by code point", () => {
	const title = sanitizeTitle("一二三四五六七八九十一二三四五", 10);
	assert.equal(Array.from(title).length, 10);
	assert.ok(title.endsWith("…"));
});

test("clip leaves short text alone", () => {
	assert.equal(clip("short", 10), "short");
	assert.equal(clip("abcdefghijk", 5), "abcd…");
});

test("firstExchange picks first user text and the reply after it", () => {
	const entries = [
		{ type: "model_change" },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "stray" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "fix the bug" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		{ type: "message", message: { role: "user", content: "second" } },
	];
	assert.deepEqual(firstExchange(entries), { user: "fix the bug", assistant: "done" });
	assert.deepEqual(firstExchange([]), { user: "", assistant: "" });
});

test("fallbackTitle uses the first meaningful line and drops slash commands", () => {
	assert.equal(fallbackTitle("\n```ts\ncode\n```"), "code");
	assert.equal(fallbackTitle("/skill:pdf merge these files\nmore"), "merge these files");
	assert.equal(fallbackTitle(""), "");
	assert.ok(Array.from(fallbackTitle("x".repeat(100))).length <= 30);
});

test("buildNamingPrompt clips long input and includes reply only when present", () => {
	const prompt = buildNamingPrompt("a".repeat(5000));
	assert.ok(prompt.length < 2100);
	assert.ok(!prompt.includes("<first_reply>"));
	assert.ok(buildNamingPrompt("q", "r").includes("<first_reply>\nr\n</first_reply>"));
});
