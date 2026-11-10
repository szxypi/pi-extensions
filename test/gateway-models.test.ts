import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCatalog, parseListedIds } from "../extensions/gateway-models/discover.ts";

const known = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("parseListedIds reads OpenAI-style bodies and rejects bad shapes", () => {
	assert.deepEqual(parseListedIds({ data: [{ id: "a" }, { id: "" }, null, { id: 5 }, { id: "b" }] }), ["a", "b"]);
	assert.equal(parseListedIds({}), undefined);
	assert.equal(parseListedIds(null), undefined);
});

test("unlisted models are removed, metadata is kept", () => {
	assert.deepEqual(filterCatalog(known, ["a", "c", "z"]), [{ id: "a" }, { id: "c" }]);
});

test("an empty match returns the known list unchanged", () => {
	assert.deepEqual(filterCatalog(known, ["x", "y"]), known);
	assert.deepEqual(filterCatalog(known, []), known);
});

test("includeUnknown adds chat ids and skips image, tts and voice ids", () => {
	const result = filterCatalog(known, ["a", "new-chat", "gpt-image-2", "grok-tts", "grok-voice-tts-1.0"], { includeUnknown: true });
	assert.deepEqual(result.map((model) => model.id), ["a", "new-chat"]);
	assert.equal(result[1]?.contextWindow, 128000);
});
