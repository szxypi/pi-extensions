import assert from "node:assert/strict";
import { test } from "node:test";
import { fixLostEscapes, fixNote, maskFences, stripTypesInPlace } from "../extensions/codemode-escapes/fix.ts";

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

test("returns the input unchanged when no view of the code parses", () => {
	const code = "await tools.bash({command:'rg \\('}) +;";
	assert.deepEqual(fixLostEscapes(code), { code, changed: false, count: 0, escapes: [] });
});

test("fixes a script in a markdown fence and keeps the fence and the prose", () => {
	const code = "Here is the script:\n```js\nawait tools.bash({command:'rg \\(x'})\n```\nDone.";
	const fix = fixLostEscapes(code);
	assert.equal(fix.changed, true);
	assert.equal(fix.code, "Here is the script:\n```js\nawait tools.bash({command:'rg \\\\(x'})\n```\nDone.");
});

test("fixes an unterminated fence and nested fences", () => {
	const open = fixLostEscapes("```ts\nawait tools.bash({command:'a\\.b'})");
	assert.equal(open.code, "```ts\nawait tools.bash({command:'a\\\\.b'})");
	const nested = fixLostEscapes("```\n```js\nconst c = 'x\\|y';\n```\n```");
	assert.equal(nested.code, "```\n```js\nconst c = 'x\\\\|y';\n```\n```");
});

test("fixes TypeScript and keeps the type syntax", () => {
	const code = [
		"interface R { output: string }",
		"const p: string = 'src';",
		"const r = (await tools.bash({command:`rg 'foo\\(' ${p as string}`})) as R;",
		"return r.output;",
	].join("\n");
	const fix = fixLostEscapes(code);
	assert.equal(fix.changed, true);
	assert.deepEqual(fix.escapes, ["\\("]);
	assert.equal(fix.code, code.replace("foo\\(", "foo\\\\("));
});

test("fixes TypeScript inside a fence", () => {
	const code = "```ts\nconst re: RegExp = new RegExp('a\\d+');\n```";
	assert.equal(fixLostEscapes(code).code, "```ts\nconst re: RegExp = new RegExp('a\\\\d+');\n```");
});

test("leaves TypeScript that strip-only mode rejects unchanged", () => {
	const code = "enum E { A }\nconst c = 'x\\(';";
	assert.equal(stripTypesInPlace(code), undefined);
	assert.equal(fixLostEscapes(code).changed, false);
});

test("views keep the length of the script", () => {
	const fenced = "intro\n```js\nconst a = 1;\n```\nend";
	assert.equal(maskFences(fenced)?.length, fenced.length);
	assert.equal(maskFences("const a = 1;"), undefined);
	const typed = "const a: number = 1;";
	assert.equal(stripTypesInPlace(typed)?.length, typed.length);
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
