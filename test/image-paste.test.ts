import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ImageStore,
	PLACEHOLDER_REGEX,
	clipboardImageMime,
	mergePlaceholderSegments,
	placeholder,
	placeholderIds,
	spacedPlaceholder,
} from "../extensions/image-paste/placeholders.ts";

const TMP = "/tmp";
const UUID = "3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";

test("placeholder renders the Claude Code marker", () => {
	assert.equal(placeholder(1), "[Image #1]");
	assert.equal(placeholder(12), "[Image #12]");
});

test("PLACEHOLDER_REGEX finds every id", () => {
	const ids = [..."[Image #1] and [Image #2]".matchAll(PLACEHOLDER_REGEX)].map((m) => m[1]);
	assert.deepEqual(ids, ["1", "2"]);
	assert.deepEqual([..."plain text".matchAll(PLACEHOLDER_REGEX)], []);
});

test("clipboardImageMime accepts pi's temporary clipboard files", () => {
	assert.equal(clipboardImageMime(`${TMP}/pi-clipboard-${UUID}.png`, TMP), "image/png");
	assert.equal(clipboardImageMime(`${TMP}/pi-clipboard-${UUID}.jpg`, TMP), "image/jpeg");
	assert.equal(clipboardImageMime(`${TMP}/pi-clipboard-${UUID}.webp`, TMP), "image/webp");
	assert.equal(clipboardImageMime(`${TMP}/pi-clipboard-${UUID}.gif`, TMP), "image/gif");
});

test("clipboardImageMime rejects other paths", () => {
	// Wrong directory.
	assert.equal(clipboardImageMime(`/home/user/pi-clipboard-${UUID}.png`, TMP), undefined);
	// Wrong file name.
	assert.equal(clipboardImageMime(`${TMP}/screenshot.png`, TMP), undefined);
	assert.equal(clipboardImageMime(`${TMP}/pi-clipboard-not-a-uuid.png`, TMP), undefined);
	// Unsupported extension.
	assert.equal(clipboardImageMime(`${TMP}/pi-clipboard-${UUID}.bmp`, TMP), undefined);
	// Empty input.
	assert.equal(clipboardImageMime("", TMP), undefined);
});

test("spacedPlaceholder separates the marker from neighbouring words", () => {
	assert.equal(spacedPlaceholder("[Image #1]", "", ""), "[Image #1] ");
	assert.equal(spacedPlaceholder("[Image #1]", "a", ""), " [Image #1] ");
	assert.equal(spacedPlaceholder("[Image #1]", "", "b"), "[Image #1] ");
	assert.equal(spacedPlaceholder("[Image #1]", "a", "b"), " [Image #1] ");
	assert.equal(spacedPlaceholder("[Image #1]", " ", " "), "[Image #1]");
	assert.equal(spacedPlaceholder("[Image #1]", "\n", "\n"), "[Image #1]");
});

test("placeholderIds lists ids once, in order of first appearance", () => {
	assert.deepEqual(placeholderIds("[Image #2] then [Image #1] then [Image #2]"), [2, 1]);
	assert.deepEqual(placeholderIds("no markers"), []);
});

test("ImageStore numbers images from 1 and restarts after reset", () => {
	const store = new ImageStore();
	const png = { data: "AAAA", mimeType: "image/png" };
	assert.equal(store.add(png), 1);
	assert.equal(store.add(png), 2);
	assert.deepEqual([...store.ids()], [1, 2]);
	store.reset();
	assert.equal(store.add(png), 1);
	assert.deepEqual([...store.ids()], [1]);
});

test("ImageStore.take returns referenced images in order and empties the store", () => {
	const store = new ImageStore();
	const first = { data: "first", mimeType: "image/png" };
	const second = { data: "second", mimeType: "image/jpeg" };
	store.add(first);
	store.add(second);
	assert.deepEqual(store.take("[Image #2] see [Image #1]"), [second, first]);
	assert.deepEqual([...store.ids()], []);
	// After take, numbering starts over and old placeholders no longer resolve.
	assert.equal(store.add(first), 1);
	assert.deepEqual(store.take("[Image #2]"), []);
	assert.deepEqual([...store.ids()], []);
});

test("mergePlaceholderSegments merges one placeholder into one segment", () => {
	const text = "look [Image #1] here";
	const base = [...text].map((char, index) => ({ segment: char, index, input: text }));
	const merged = mergePlaceholderSegments(text, base, new Set([1]));
	const marker = merged.find((segment) => segment.segment === "[Image #1]");
	assert.ok(marker, "merged placeholder segment exists");
	assert.equal(marker.segment.length, "[Image #1]".length);
	assert.equal(marker.index, text.indexOf("[Image #1]"));
	assert.equal(marker.input, text);
	// Every other character stays as its own segment.
	assert.equal(merged.length, text.length - "[Image #1]".length + 1);
});

test("mergePlaceholderSegments leaves unknown ids alone", () => {
	const text = "a [Image #7] b";
	const base = [...text].map((char, index) => ({ segment: char, index, input: text }));
	const merged = mergePlaceholderSegments(text, base, new Set([1]));
	assert.deepEqual(merged, base);
	// An empty id set is a fast path.
	assert.deepEqual(mergePlaceholderSegments(text, base, new Set()), base);
});

test("mergePlaceholderSegments merges several placeholders in one text", () => {
	const text = "[Image #1] and [Image #2]";
	const base = [...text].map((char, index) => ({ segment: char, index, input: text }));
	const merged = mergePlaceholderSegments(text, base, new Set([1, 2]));
	assert.deepEqual(
		merged.map((segment) => segment.segment),
		["[Image #1]", " ", "a", "n", "d", " ", "[Image #2]"],
	);
});
