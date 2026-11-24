/**
 * codemode-escapes fix: pure logic, no pi imports, so tests run on plain Node.
 *
 * In a JavaScript string or untagged template literal, an escape such as
 * `\(`, `\.`, `\|` or `\d` is an identity escape: JavaScript drops the
 * backslash. Models write these escapes for the shell or regex layer inside
 * the string, for example `tools.bash({command: `rg 'foo\(' src`})`. The
 * command then reaches bash as `rg 'foo(' src`, and rg fails with
 * "regex parse error: unclosed group".
 *
 * fixLostEscapes() doubles the backslash of each identity escape, so the
 * string value keeps the backslash the model wrote. It does not change:
 * - escapes that JavaScript defines (\n, \t, \b, \\, \', \", \x.., \u.., \0-\9),
 * - line continuations,
 * - `\$` and `` \` `` in templates, which templates need to stop
 *   interpolation or to close (in quoted strings these are doubled too),
 * - regex literals and tagged templates such as String.raw`...`.
 *
 * The script can also be TypeScript, or sit in a markdown code fence. The fix
 * then parses a JavaScript view of the script that has the same length and
 * the same character positions: type syntax becomes spaces, and fence lines
 * and text outside the fence become spaces. The fix inserts the backslashes
 * into the original script at the positions found in the view, so the fence
 * and the types stay for the next compiler (pi-codemode-guard).
 */

import * as nodeModule from "node:module";
import { parse } from "acorn";

/** Characters after a backslash that JavaScript treats as a real escape. */
const DEFINED_ESCAPES = new Set(["'", '"', "\\", "b", "f", "n", "r", "t", "v", "x", "u", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
/** Escapes that template literals need, so they are kept in templates only. */
const TEMPLATE_ESCAPES = new Set(["$", "`"]);
const LINE_TERMINATORS = new Set(["\n", "\r", " ", " "]);

/** A markdown fence line: ``` or ~~~, an optional language tag, nothing else. */
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+.-]*[ \t]*\r?$/;

export interface EscapeFix {
	/** Fixed source, or the input unchanged when nothing changed. */
	code: string;
	changed: boolean;
	/** Number of doubled backslashes. */
	count: number;
	/** Distinct escapes that were doubled, for example ["\\(", "\\."]. */
	escapes: string[];
}

interface Span {
	start: number;
	end: number;
	template: boolean;
}

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

const PARSE_OPTIONS = {
	ecmaVersion: "latest",
	sourceType: "script",
	allowAwaitOutsideFunction: true,
	allowReturnOutsideFunction: true,
	allowHashBang: true,
} as const;

function isNode(value: unknown): value is AstNode {
	return !!value && typeof value === "object" && typeof (value as AstNode).type === "string";
}

/** Collect spans of string literal bodies and untagged template quasis. */
function collectSpans(node: AstNode, spans: Span[], tagged: Set<AstNode>): void {
	if (node.type === "Literal" && typeof node.value === "string" && !node.regex) {
		// Skip the opening and closing quote.
		spans.push({ start: node.start + 1, end: node.end - 1, template: false });
	} else if (node.type === "TemplateLiteral" && !tagged.has(node)) {
		for (const quasi of node.quasis as AstNode[]) {
			spans.push({ start: quasi.start, end: quasi.end, template: true });
		}
	} else if (node.type === "TaggedTemplateExpression" && isNode(node.quasi)) {
		tagged.add(node.quasi);
	}
	for (const key of Object.keys(node)) {
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) collectSpans(item, spans, tagged);
		} else if (isNode(value)) {
			collectSpans(value, spans, tagged);
		}
	}
}

function tryParse(code: string): AstNode | undefined {
	try {
		return parse(code, PARSE_OPTIONS) as unknown as AstNode;
	} catch {
		return undefined;
	}
}

/** Replace every character except line breaks with a space. */
function blank(text: string): string {
	return text.replace(/[^\r\n]/g, " ");
}

/**
 * Same-length view of a fenced script: keep the text between the first and
 * the last fence line, and blank the fence lines and everything outside them.
 * With one fence line only (unterminated fence), keep everything after it.
 * Returns undefined when the code has no fence line.
 */
export function maskFences(code: string): string | undefined {
	const lines = code.split("\n");
	const fences: number[] = [];
	lines.forEach((line, i) => {
		if (FENCE_LINE.test(line)) fences.push(i);
	});
	if (fences.length === 0) return undefined;
	const first = fences[0];
	const last = fences.length > 1 ? fences[fences.length - 1] : lines.length;
	return lines
		.map((line, i) => (i <= first || i >= last || fences.includes(i) ? blank(line) : line))
		.join("\n");
}

type StripTypes = (code: string, options?: { mode?: "strip" }) => string;

/**
 * Same-length view of a TypeScript script: Node's strip-only mode replaces
 * type syntax with spaces. Returns undefined when this Node has no
 * stripTypeScriptTypes, when the script uses syntax that needs a transform
 * (enum, namespace), or when the length changes.
 */
export function stripTypesInPlace(code: string): string | undefined {
	const strip = (nodeModule as unknown as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
	if (typeof strip !== "function") return undefined;
	// The wrapper lets top-level await and return through the TypeScript parser.
	const head = "async function __codemode_escapes__() {\n";
	const tail = "\n}";
	// Node prints an ExperimentalWarning on the first call; it must not reach the TUI.
	const emitWarning = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning?.message;
		if (typeof text === "string" && text.includes("stripTypeScriptTypes")) return;
		return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		const out = strip(head + code + tail, { mode: "strip" });
		if (out.length !== head.length + code.length + tail.length) return undefined;
		return out.slice(head.length, out.length - tail.length);
	} catch {
		return undefined;
	} finally {
		process.emitWarning = emitWarning;
	}
}

/**
 * Same-length JavaScript views of the script, in the order to try them.
 * When the first non-blank line is a fence line, the fenced views go first:
 * "```ts\n...\n```" also parses as JavaScript (tagged templates), but that
 * parse hides the strings inside the fence.
 */
function* views(code: string): Generator<string> {
	// Thunks: the TypeScript strip runs only when the views before it fail to parse.
	const fenced = maskFences(code);
	const firstLine = code.split("\n").find((line) => line.trim() !== "") ?? "";
	const plain = [() => code, () => stripTypesInPlace(code)];
	const unfenced = fenced === undefined ? [] : [() => fenced, () => stripTypesInPlace(fenced)];
	const ordered = FENCE_LINE.test(firstLine) ? [...unfenced, ...plain] : [...plain, ...unfenced];
	for (const make of ordered) {
		const view = make();
		if (view !== undefined) yield view;
	}
}

function insertBackslashes(text: string, positions: number[]): string {
	let out = "";
	let last = 0;
	for (const pos of positions) {
		out += text.slice(last, pos) + "\\";
		last = pos;
	}
	return out + text.slice(last);
}

/**
 * Double the backslash of each identity escape in string and untagged
 * template literals. Returns the input unchanged when no JavaScript view of
 * the code parses, or when the fixed view does not parse.
 */
export function fixLostEscapes(code: string): EscapeFix {
	const unchanged: EscapeFix = { code, changed: false, count: 0, escapes: [] };
	if (!code.includes("\\")) return unchanged;

	let view: string | undefined;
	let ast: AstNode | undefined;
	for (const candidate of views(code)) {
		ast = tryParse(candidate);
		if (ast) {
			view = candidate;
			break;
		}
	}
	if (!ast || view === undefined) return unchanged;

	const spans: Span[] = [];
	collectSpans(ast, spans, new Set());
	spans.sort((a, b) => a.start - b.start);

	const insertAt: number[] = [];
	const escapes = new Set<string>();
	for (const span of spans) {
		// A view only blanks text outside literals; skip a span that differs anyway.
		if (view.slice(span.start, span.end) !== code.slice(span.start, span.end)) continue;
		for (let i = span.start; i < span.end - 1; i++) {
			if (code[i] !== "\\") continue;
			const next = String.fromCodePoint(code.codePointAt(i + 1) ?? 0);
			const kept = DEFINED_ESCAPES.has(next) || LINE_TERMINATORS.has(next) || (span.template && TEMPLATE_ESCAPES.has(next));
			if (!kept) {
				insertAt.push(i);
				escapes.add(`\\${next}`);
			}
			// The escape consumes the next character (both UTF-16 units for an astral one).
			i += next.length;
		}
	}
	if (insertAt.length === 0) return unchanged;
	if (!tryParse(insertBackslashes(view, insertAt))) return unchanged;
	return { code: insertBackslashes(code, insertAt), changed: true, count: insertAt.length, escapes: [...escapes] };
}

/** Note appended to the codemode result so the model knows the script changed. */
export function fixNote(fix: EscapeFix): string {
	return [
		`[codemode-escapes] JavaScript drops the backslash in ${fix.escapes.join(" ")} inside string literals.`,
		`The script ran with ${fix.count} such backslash(es) kept, so shell and regex text got them.`,
		"In codemode, write \\\\ for one backslash, or use String.raw`...`.",
	].join("\n");
}
