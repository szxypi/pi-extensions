/**
 * tool-reliability: stop repeated identical tool failures, precheck edit
 * arguments, and append recovery hints to tool errors.
 *
 * - A tool call that fails twice in a row with the same fingerprint (tool name
 *   plus stable argument serialization; bash and powershell also include the
 *   session cwd) is blocked. The model gets a change-approach instruction
 *   instead of a third copy of the same error. Blocked calls never reach the
 *   tool, so they do not add to the failure count.
 * - Reset is narrow: a success clears only its own fingerprint. A successful
 *   edit or write also clears bash and powershell failures, because the code
 *   the command runs against may have changed. Success of any other tool
 *   clears nothing else.
 * - edit precheck only judges what is certain from the arguments: empty
 *   oldText, oldText === newText, duplicate or overlapping oldText within one
 *   call. Runtime match failures stay with the native tool; the tool_result
 *   handler appends a short recovery hint to its error instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	FailureTracker,
	blockReason,
	checkEditInput,
	fingerprint,
	recoveryHint,
	summarizeError,
} from "./guard.ts";

function shellCwd(toolName: string, cwd: string): string | undefined {
	return toolName === "bash" || toolName === "powershell" ? cwd : undefined;
}

export default function (pi: ExtensionAPI) {
	const tracker = new FailureTracker(2);

	pi.on("session_start", () => {
		tracker.reset();
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "edit") {
			const problem = checkEditInput(event.input);
			if (problem) {
				return { block: true, reason: `[tool-reliability] ${problem}` };
			}
		}
		const fp = fingerprint(event.toolName, event.input, shellCwd(event.toolName, ctx.cwd));
		if (tracker.isBlocked(fp)) {
			return { block: true, reason: blockReason(event.toolName, tracker.count(fp), tracker.lastError(fp)) };
		}
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!event.isError) {
			tracker.recordSuccess(event.toolName, event.input, shellCwd(event.toolName, ctx.cwd));
			return undefined;
		}
		const text = event.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const fp = fingerprint(event.toolName, event.input, shellCwd(event.toolName, ctx.cwd));
		tracker.recordFailure(fp, summarizeError(text));
		const hint = recoveryHint(event.toolName, text);
		if (!hint) return undefined;
		// Append a new content block so the original error text stays untouched.
		return { content: [...event.content, { type: "text" as const, text: hint }] };
	});
}
