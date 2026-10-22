import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLEAR_PROGRESS,
	DEFAULT_CONFIG,
	StatusTracker,
	detectCapabilities,
	formatTitle,
	isPassiveInput,
	mergeConfig,
	progressSequence,
	titleSequence,
} from "../extensions/terminal-status/status.ts";

test("run lifecycle: idle → working → done → idle after a key", () => {
	const t = new StatusTracker();
	assert.equal(t.current().state, "idle");
	t.agentStart();
	assert.equal(t.current().state, "working");
	t.assistantEnd("stop");
	t.settled(false);
	assert.equal(t.current().state, "done");
	assert.equal(t.userInput(), true);
	assert.equal(t.current().state, "idle");
	assert.equal(t.userInput(), false);
});

test("a retried error is replaced by its successful retry", () => {
	const t = new StatusTracker();
	t.agentStart();
	t.assistantEnd("error", "429 rate limited\nretry later");
	assert.equal(t.current().state, "working");
	t.assistantEnd("stop");
	t.settled(false);
	assert.equal(t.current().state, "done");
});

test("final error shows the first error line; abort goes to idle", () => {
	const t = new StatusTracker();
	t.agentStart();
	t.assistantEnd("error", "boom\nstack");
	t.settled(false);
	assert.deepEqual(t.current(), { state: "error", message: "boom" });
	t.agentStart();
	t.settled(true);
	assert.equal(t.current().state, "idle");
});

test("blocked wins over working and restores after the dialog", () => {
	const t = new StatusTracker();
	t.agentStart();
	t.setBlocked("Allow rm -rf?", true);
	assert.deepEqual(t.current(), { state: "blocked", message: "Allow rm -rf?" });
	assert.equal(t.userInput(), false);
	t.setBlocked(undefined, false);
	assert.equal(t.current().state, "working");
});

test("manual compaction while idle reports working then done or error", () => {
	const t = new StatusTracker();
	t.compactStart();
	assert.equal(t.current().state, "working");
	t.compactEnd({ manual: true });
	assert.equal(t.current().state, "done");
	t.compactStart();
	t.compactEnd({ manual: true, errorMessage: "context too small" });
	assert.deepEqual(t.current(), { state: "error", message: "context too small" });
});

test("detectCapabilities", () => {
	assert.deepEqual(detectCapabilities({ WT_SESSION: "x" }), { terminal: "Windows Terminal", multiplexer: undefined, progress: true });
	assert.equal(detectCapabilities({ WT_SESSION: "x", TMUX: "/tmp/t,1,0" }).progress, false);
	assert.equal(detectCapabilities({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.1.3" }).progress, false);
	assert.equal(detectCapabilities({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" }).progress, true);
	assert.equal(detectCapabilities({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.10" }).progress, true);
	assert.equal(detectCapabilities({ TERM_PROGRAM: "vscode" }).progress, false);
	assert.equal(detectCapabilities({}).terminal, "unknown");
});

test("progress sequences match the Windows Terminal OSC 9;4 states", () => {
	assert.equal(progressSequence({ state: "working" }), "\x1b]9;4;3\x07");
	assert.equal(progressSequence({ state: "blocked" }), "\x1b]9;4;4;100\x07");
	assert.equal(progressSequence({ state: "error" }), "\x1b]9;4;2;100\x07");
	assert.equal(progressSequence({ state: "done" }), CLEAR_PROGRESS);
	assert.equal(progressSequence({ state: "idle" }), CLEAR_PROGRESS);
});

test("formatTitle animates working and strips control characters", () => {
	assert.equal(formatTitle({ state: "working" }, 0, "修复登录", "app"), "◐ 修复登录 · app");
	assert.equal(formatTitle({ state: "working" }, 1, "修复登录", "app"), "◑ 修复登录 · app");
	assert.equal(formatTitle({ state: "idle" }, 0, undefined, "app"), "✳ π · app");
	assert.equal(formatTitle({ state: "done" }, 0, "a\x1b]0;evil\x07b", ""), "✓ a ]0;evil b");
	assert.ok(Array.from(formatTitle({ state: "error" }, 0, "x".repeat(100), "d")).length <= 62);
	assert.equal(titleSequence("t"), "\x1b]0;t\x07");
});

test("mouse and focus reports are passive input", () => {
	assert.equal(isPassiveInput("\x1b[<0;10;5M"), true);
	assert.equal(isPassiveInput("\x1b[I"), true);
	assert.equal(isPassiveInput("a"), false);
	assert.equal(isPassiveInput("\r"), false);
});

test("mergeConfig", () => {
	assert.deepEqual(mergeConfig(null), DEFAULT_CONFIG);
	assert.deepEqual(mergeConfig({ progress: "on", title: false }), { progress: "on", title: false });
	assert.deepEqual(mergeConfig({ progress: "yes" }), DEFAULT_CONFIG);
});
