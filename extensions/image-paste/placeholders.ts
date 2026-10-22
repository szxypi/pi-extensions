/**
 * Placeholder bookkeeping for image-paste. Pure logic, no pi imports, so tests run on plain Node.
 *
 * pi writes a pasted clipboard image to <tmpdir>/pi-clipboard-<uuid>.<ext> and inserts that path
 * into the editor. The extension swaps the path for `[Image #N]`, keeps the bytes until the prompt
 * is submitted, and merges the placeholder into one atomic editor segment so edits treat it as a
 * single unit.
 */

import { basename, dirname, resolve } from "node:path";

/** Matches `[Image #1]` and larger ids. Global: use with matchAll, never with exec on shared state. */
export const PLACEHOLDER_REGEX = /\[Image #(\d+)\]/g;

const CLIPBOARD_FILE_REGEX = /^pi-clipboard-[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

export interface StoredImage {
	data: string;
	mimeType: string;
}

/** One editor segment: shaped like the objects Intl.Segmenter returns. Extra fields pass through. */
export interface TextSegment {
	segment: string;
	index: number;
	input: string;
}

/** The text the editor shows for an attached image. */
export function placeholder(id: number): string {
	return `[Image #${id}]`;
}

/**
 * Return the MIME type when `text` is a file pi wrote for a pasted clipboard image.
 * `tmpDir` is normally os.tmpdir().
 */
export function clipboardImageMime(text: string, tmpDir: string): string | undefined {
	if (!text) return undefined;
	if (dirname(text) !== resolve(tmpDir)) return undefined;
	const match = CLIPBOARD_FILE_REGEX.exec(basename(text));
	if (!match) return undefined;
	return MIME_BY_EXTENSION[match[1]];
}

/**
 * Add spaces around a placeholder so it reads as a separate word. A space goes in front when the
 * character before the cursor is not whitespace. A space goes after when the next character is not
 * whitespace, including the end of the line, so typing can continue right away.
 */
export function spacedPlaceholder(marker: string, charBefore: string, charAfter: string): string {
	const leading = charBefore && !/\s/.test(charBefore) ? " " : "";
	const trailing = /\s/.test(charAfter) ? "" : " ";
	return leading + marker + trailing;
}

/** Placeholder ids in order of first appearance, without duplicates. */
export function placeholderIds(text: string): number[] {
	const ids: number[] = [];
	for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
		const id = Number.parseInt(match[1], 10);
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** Images pasted in the current prompt, keyed by the id shown in the placeholder. */
export class ImageStore {
	private nextId = 1;
	private images = new Map<number, StoredImage>();

	add(image: StoredImage): number {
		const id = this.nextId++;
		this.images.set(id, image);
		return id;
	}

	/** Ids that placeholders may merge into one atomic segment. */
	ids(): Set<number> {
		return new Set(this.images.keys());
	}

	/** Images referenced by `text`, in order of first appearance. Clears the store. */
	take(text: string): StoredImage[] {
		const taken: StoredImage[] = [];
		for (const id of placeholderIds(text)) {
			const image = this.images.get(id);
			if (image) taken.push(image);
		}
		this.reset();
		return taken;
	}

	/** Drop every image and restart numbering at 1. */
	reset(): void {
		this.images.clear();
		this.nextId = 1;
	}
}

/**
 * Merge `[Image #N]` spans whose id is in `validIds` into single segments.
 * This mirrors pi's own paste-marker merging (editor.js segmentWithMarkers).
 */
export function mergePlaceholderSegments(
	text: string,
	segments: Iterable<TextSegment>,
	validIds: Set<number>,
): TextSegment[] {
	const base = [...segments];
	if (validIds.size === 0 || !text.includes("[Image #")) return base;
	const markers: { start: number; end: number }[] = [];
	for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
		if (!validIds.has(Number.parseInt(match[1], 10))) continue;
		markers.push({ start: match.index, end: match.index + match[0].length });
	}
	if (markers.length === 0) return base;
	const result: TextSegment[] = [];
	let markerIndex = 0;
	for (const segment of base) {
		while (markerIndex < markers.length && markers[markerIndex].end <= segment.index) markerIndex++;
		const marker = markerIndex < markers.length ? markers[markerIndex] : undefined;
		if (marker && segment.index >= marker.start && segment.index < marker.end) {
			// Emit the marker once, at its first covered segment; skip the rest of the span.
			if (segment.index === marker.start) {
				result.push({ segment: text.slice(marker.start, marker.end), index: marker.start, input: text });
			}
		} else {
			result.push(segment);
		}
	}
	return result;
}
