import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FailureTracker,
	blockReason,
	checkEditInput,
	fingerprint,
	recoveryHint,
	stableStringify,
	summarizeError,
} from "../extensions/tool-reliability/guard.ts";

const BASH_INPUT = { command: "npm test", timeout: 60000 };

test("stableStringify is key-order independent", () => {
	assert.equal(stableStringify({ a: 1, b: [2, { c: 3 }] }), stableStringify({ b: [2, { c: 3 }], a: 1 }));
	assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("fingerprint for bash includes cwd and full command", () => {
	const a = fingerprint("bash", BASH_INPUT, "/repo");
	const b = fingerprint("bash", BASH_INPUT, "/repo");
	const otherCwd = fingerprint("bash", BASH_INPUT, "/other");
	const otherCmd = fingerprint("bash", { command: "npm run build", timeout: 60000 }, "/repo");
	assert.equal(a, b);
	assert.notEqual(a, otherCwd);
	assert.notEqual(a, otherCmd);
	assert.ok(!fingerprint("read", { path: "x" }).includes("cwd:"));
});

test("failure state machine blocks after two consecutive failures", () => {
	const tracker = new FailureTracker(2);
	const fp = fingerprint("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
	assert.equal(tracker.isBlocked(fp), false);
	tracker.recordFailure(fp, "err1");
	assert.equal(tracker.isBlocked(fp), false);
	tracker.recordFailure(fp, "err2");
	assert.equal(tracker.isBlocked(fp), true);
	assert.equal(tracker.count(fp), 2);
	assert.ok(blockReason("edit", tracker.count(fp), tracker.lastError(fp)).includes("Do not retry"));
});

test("different fingerprint does not block", () => {
	const tracker = new FailureTracker(2);
	const fp1 = fingerprint("bash", { command: "make" }, "/r");
	tracker.recordFailure(fp1, "e");
	tracker.recordFailure(fp1, "e");
	assert.equal(tracker.isBlocked(fp1), true);
	assert.equal(tracker.isBlocked(fingerprint("bash", { command: "make test" }, "/r")), false);
	assert.equal(tracker.isBlocked(fingerprint("bash", { command: "make" }, "/elsewhere")), false);
});

test("success clears only its own fingerprint", () => {
	const tracker = new FailureTracker(2);
	const fpA = fingerprint("read", { path: "a" });
	const fpB = fingerprint("read", { path: "b" });
	tracker.recordFailure(fpA, "e");
	tracker.recordFailure(fpA, "e");
	tracker.recordFailure(fpB, "e");
	tracker.recordFailure(fpB, "e");
	tracker.recordSuccess("read", { path: "a" });
	assert.equal(tracker.isBlocked(fpA), false);
	assert.equal(tracker.isBlocked(fpB), true);
});

test("successful edit or write clears bash failures but not other tools", () => {
	const tracker = new FailureTracker(2);
	const fpBash = fingerprint("bash", { command: "npm test" }, "/repo");
	const fpRead = fingerprint("read", { path: "a" });
	tracker.recordFailure(fpBash, "e");
	tracker.recordFailure(fpBash, "e");
	tracker.recordFailure(fpRead, "e");
	tracker.recordFailure(fpRead, "e");
	tracker.recordSuccess("edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] });
	assert.equal(tracker.isBlocked(fpBash), false);
	assert.equal(tracker.isBlocked(fpRead), true);
});

test("unrelated tool success does not clear failures", () => {
	const tracker = new FailureTracker(2);
	const fp = fingerprint("grep", { pattern: "foo" });
	tracker.recordFailure(fp, "e");
	tracker.recordFailure(fp, "e");
	tracker.recordSuccess("read", { path: "a" });
	tracker.recordSuccess("ls", { path: "." });
	assert.equal(tracker.isBlocked(fp), true);
});

test("reset clears everything", () => {
	const tracker = new FailureTracker(2);
	const fp = fingerprint("grep", { pattern: "foo" });
	tracker.recordFailure(fp, "e");
	tracker.reset();
	assert.equal(tracker.isBlocked(fp), false);
	assert.equal(tracker.size(), 0);
});

test("summarizeError returns the first non-empty line clipped", () => {
	assert.equal(summarizeError("\n  Error: boom  \nmore"), "Error: boom");
	assert.equal(summarizeError("   "), "(empty error)");
	assert.ok(summarizeError("x".repeat(200)).length <= 121);
});

test("checkEditInput flags empty oldText", () => {
	const reason = checkEditInput({ path: "a.ts", edits: [{ oldText: "  ", newText: "y" }] });
	assert.ok(reason);
	assert.match(reason, /oldText is empty/);
});

test("checkEditInput flags identical oldText and newText", () => {
	const reason = checkEditInput({ path: "a.ts", edits: [{ oldText: "same", newText: "same" }] });
	assert.ok(reason);
	assert.match(reason, /identical oldText and newText/);
});

test("checkEditInput flags duplicate oldText in one call", () => {
	const reason = checkEditInput({
		path: "a.ts",
		edits: [
			{ oldText: "foo", newText: "a" },
			{ oldText: "foo", newText: "b" },
		],
	});
	assert.ok(reason);
	assert.match(reason, /identical oldText/);
});

test("checkEditInput flags containing (overlapping) oldText", () => {
	const reason = checkEditInput({
		path: "a.ts",
		edits: [
			{ oldText: "function foo() { return 1; }", newText: "a" },
			{ oldText: "return 1;", newText: "b" },
		],
	});
	assert.ok(reason);
	assert.match(reason, /overlap/);
});

test("checkEditInput passes valid edits and non-standard shapes", () => {
	assert.equal(
		checkEditInput({
			path: "a.ts",
			edits: [
				{ oldText: "foo", newText: "bar" },
				{ oldText: "baz", newText: "qux" },
			],
		}),
		undefined,
	);
	assert.equal(checkEditInput({ path: "a.ts", edits: "not-array" }), undefined);
	assert.equal(checkEditInput({ oldText: "x", newText: "y" }), undefined);
	assert.equal(checkEditInput({ path: "a.ts", edits: [{ oldText: 1, newText: "y" }] }), undefined);
});

test("recoveryHint for edit errors", () => {
	assert.match(
		recoveryHint("edit", "Could not find the exact text in a.ts. The old text must match exactly including all whitespace and newlines.")!,
		/Re-read the file/,
	);
	assert.match(recoveryHint("edit", "Found 3 occurrences of the text in a.ts. The text must be unique.")!, /exactly once/);
	assert.match(recoveryHint("edit", "oldText must not be empty in a.ts.")!, /oldText was empty/);
	assert.match(recoveryHint("edit", "edits[0] and edits[1] overlap in a.ts. Merge them into one edit.")!, /overlap/);
	assert.equal(recoveryHint("edit", "Permission denied"), undefined);
});

test("recoveryHint for ENOENT and codemode syntax errors", () => {
	assert.match(recoveryHint("read", "Error: ENOENT: no such file or directory, open '/x/y'")!, /path does not exist/i);
	assert.match(recoveryHint("grep", "ENOENT: no such file or directory")!, /ls\/find/);
	assert.match(recoveryHint("codemode", "SyntaxError: unexpected token")!, /syntax error/);
	assert.match(recoveryHint("codemode", "Parse error: not valid JavaScript")!, /syntax error/);
	assert.equal(recoveryHint("ls", "permission denied"), undefined);
});

test("recoveryHint for bash non-zero exit without output", () => {
	const hint = recoveryHint("bash", "Command exited with code 1");
	assert.ok(hint);
	assert.match(hint, /2>&1/);
	// Non-zero exit WITH output gets no hint (the error text explains itself).
	assert.equal(recoveryHint("bash", "some error output\nCommand exited with code 1"), undefined);
});

test("recoveryHint ignores unrelated tools and texts", () => {
	assert.equal(recoveryHint("write", "whatever"), undefined);
	assert.equal(recoveryHint("bash", "Command not found in text"), undefined);
});
