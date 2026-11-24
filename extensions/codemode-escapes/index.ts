/**
 * codemode-escapes: keep backslashes that JavaScript would drop from codemode
 * scripts.
 *
 * A codemode script such as tools.bash({command: `rg 'foo\(' src`}) loses
 * the backslash in `\(`, so rg gets `foo(` and fails with "regex parse error:
 * unclosed group". The tool_call handler rewrites `input.code` so each such
 * identity escape keeps its backslash (see fix.ts). The tool_result handler
 * appends one note to the result, so the model learns the rule.
 *
 * TypeScript scripts and scripts in a markdown code fence are fixed too; the
 * types and the fence stay. Scripts that still do not parse are left unchanged.
 * PI_CODEMODE_ESCAPES=0 turns the extension off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixLostEscapes, fixNote, type EscapeFix } from "./fix.ts";

/** Pending fixes are deleted on tool_result; this cap bounds aborted calls. */
const MAX_PENDING = 32;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_CODEMODE_ESCAPES === "0") return;

	const pending = new Map<string, EscapeFix>();

	pi.on("tool_call", (event) => {
		if (event.toolName !== "codemode") return undefined;
		const input = event.input as Record<string, unknown>;
		if (typeof input.code !== "string") return undefined;
		let fix: EscapeFix;
		try {
			fix = fixLostEscapes(input.code);
		} catch {
			// A bug here must never block the tool: run the script as written.
			return undefined;
		}
		if (!fix.changed) return undefined;
		input.code = fix.code;
		pending.set(event.toolCallId, fix);
		while (pending.size > MAX_PENDING) {
			const oldest = pending.keys().next();
			if (oldest.done) break;
			pending.delete(oldest.value);
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "codemode") return undefined;
		const fix = pending.get(event.toolCallId);
		if (!fix) return undefined;
		pending.delete(event.toolCallId);
		return { content: [...event.content, { type: "text" as const, text: fixNote(fix) }] };
	});
}
