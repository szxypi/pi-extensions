import assert from "node:assert/strict";
import { test } from "node:test";
import { fixLostEscapes, fixNote } from "../extensions/codemode-escapes/fix.ts";

/** Run a fixed script's string expression and return its value. */
function valueOf(code: string): unknown {
	return new Function(`return (${code});`)();
}

test("keeps the backslash of \\( in a template passed to bash", () => {
	const code = "await tools.bash({command:`rg -n 'datacustomData|setValue\\(item.field' web`})";
	const fix = fixLostEscapes(code);
	assert.equal(fix.changed, true);
	assert.deepEqual(fix.escapes, ["\\("]);
	assert.equal(fix.count, 1);
	assert.ok(fix.code.includes("setValue\\\\(item.field"));
	const cmd = valueOf("`rg -n 'datacustomData|setValue\\\\(item.field' web`");
	assert.equal(cmd, "rg -n 'datacustomData|setValue\\(item.field' web");
});

test("fixes quoted strings, including \\$", () => {
	const fix = fixLostEscapes("const a = 'req\\.body|\\$\\{x'; const b = \"find . \\( -name x \\)\";");
	assert.equal(fix.changed, true);
	assert.deepEqual(fix.escapes.sort(), ["\\$", "\\(", "\\)", "\\.", "\\{"].sort());
	assert.equal(valueOf(fix.code.slice(10, fix.code.indexOf(";"))), "req\\.body|\\$\\{x");
});

test("leaves defined escapes, template \\$ and \\`, regex literals and String.raw unchanged", () => {
	const code = [
		"const a = 'line\\n\\ttab\\\\ \\' \\x41 \\u0041 \\b \\0';",
		"const b = `cost \\${x} \\` \\$HOME`;",
		"const c = /foo\\(\\d+\\)/;",
		"const d = String.raw`rg 'foo\\('`;",
		"const e = 'a\\\nb';",
	].join("\n");
	const fix = fixLostEscapes(code);
	assert.equal(fix.changed, false);
	assert.equal(fix.code, code);
});

test("fixes template quasis but not the ${} expressions between them", () => {
	const code = "const p='x'; const c=`rg '\\(${p}' ${'\\.'}`;";
	const fix = fixLostEscapes(code);
	// Both the quasi and the nested string literal hold an identity escape.
	assert.equal(fix.count, 2);
	assert.equal(fix.code, "const p='x'; const c=`rg '\\\\(${p}' ${'\\\\.'}`;");
});

test("returns the input unchanged when the code does not parse", () => {
	const code = "```js\nawait tools.bash({command:'rg \\('})\n```";
	assert.deepEqual(fixLostEscapes(code), { code, changed: false, count: 0, escapes: [] });
});

test("accepts top-level await and return", () => {
	const fix = fixLostEscapes("const r = await tools.bash({command:'grep a\\|b f'}); return r;");
	assert.equal(fix.changed, true);
	assert.deepEqual(fix.escapes, ["\\|"]);
});

test("fixNote names the escapes and the count", () => {
	const note = fixNote({ code: "", changed: true, count: 3, escapes: ["\\(", "\\."] });
	assert.match(note, /\\\( \\\./);
	assert.match(note, /3 such backslash/);
	assert.match(note, /String\.raw/);
});
