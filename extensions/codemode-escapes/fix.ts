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
 */

import { parse } from "acorn";

/** Characters after a backslash that JavaScript treats as a real escape. */
const DEFINED_ESCAPES = new Set(["'", '"', "\\", "b", "f", "n", "r", "t", "v", "x", "u", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
/** Escapes that template literals need, so they are kept in templates only. */
const TEMPLATE_ESCAPES = new Set(["$", "`"]);
const LINE_TERMINATORS = new Set(["\n", "\r", " ", " "]);

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

/**
 * Double the backslash of each identity escape in string and untagged
 * template literals. Returns the input unchanged when the code does not
 * parse as JavaScript, or when the fixed code does not parse.
 */
export function fixLostEscapes(code: string): EscapeFix {
	const unchanged: EscapeFix = { code, changed: false, count: 0, escapes: [] };
	if (!code.includes("\\")) return unchanged;
	const ast = tryParse(code);
	if (!ast) return unchanged;

	const spans: Span[] = [];
	collectSpans(ast, spans, new Set());
	spans.sort((a, b) => a.start - b.start);

	const insertAt: number[] = [];
	const escapes = new Set<string>();
	for (const span of spans) {
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

	let out = "";
	let last = 0;
	for (const pos of insertAt) {
		out += code.slice(last, pos) + "\\";
		last = pos;
	}
	out += code.slice(last);
	if (!tryParse(out)) return unchanged;
	return { code: out, changed: true, count: insertAt.length, escapes: [...escapes] };
}

/** Note appended to the codemode result so the model knows the script changed. */
export function fixNote(fix: EscapeFix): string {
	return [
		`[codemode-escapes] JavaScript drops the backslash in ${fix.escapes.join(" ")} inside string literals.`,
		`The script ran with ${fix.count} such backslash(es) kept, so shell and regex text got them.`,
		"In codemode, write \\\\ for one backslash, or use String.raw`...`.",
	].join("\n");
}
