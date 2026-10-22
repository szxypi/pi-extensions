/**
 * image-paste: paste a clipboard image into the prompt as `[Image #1]`, like Claude Code.
 *
 * pi turns a pasted clipboard image into a temporary file and inserts its path. This extension
 * wraps Editor.insertTextAtCursor: when the inserted text is such a file, it reads the bytes,
 * deletes the file, and inserts `[Image #N]` instead. The image is attached to the prompt through
 * the input event when the prompt is submitted, and the placeholder stays in the text.
 *
 * - Editor.segment is wrapped too, so one backspace or arrow key treats a placeholder as one unit.
 * - Bash mode (`!`) keeps the temporary path.
 * - Clearing the input and starting a new prompt restarts numbering at 1.
 * - A placeholder recalled from history has no image left to attach.
 * - The clipboard read is pi's own code (wl-paste / PowerShell fallback on WSL).
 *
 * Env: PI_IMAGE_PASTE=0 disables the extension.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import {
	ImageStore,
	type TextSegment,
	clipboardImageMime,
	mergePlaceholderSegments,
	placeholder,
	spacedPlaceholder,
} from "./placeholders.ts";

/** The parts of Editor this extension touches. `segment` is private in pi-tui. */
interface EditorLike {
	getText(): string;
	getCursor(): { line: number; col: number };
	getLines(): string[];
}

type InsertTextAtCursor = (this: EditorLike, text: string) => void;
type SegmentFn = (this: EditorLike, text: string, mode: string) => Iterable<TextSegment>;

interface Hooks {
	enabled: () => boolean;
	store: ImageStore;
}

interface Patched {
	hooks: Hooks;
}

const KEY = Symbol.for("pi-extensions.image-paste.editor");

/**
 * Install the Editor.prototype patch once per process. A reload replaces only the hooks below, so
 * the newest extension instance decides whether image paste is on and owns the image store.
 * The patch never reads a captured extension context: a stale context throws after a session swap.
 */
function installEditorPatch(hooks: Hooks): void {
	const proto = (Editor as unknown as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
	if (!proto) return;
	const existing = proto[KEY] as Patched | undefined;
	if (existing) {
		existing.hooks = hooks;
		return;
	}
	const patched: Patched = { hooks };
	const originalInsert = proto.insertTextAtCursor;
	if (typeof originalInsert === "function") {
		const insert = originalInsert as InsertTextAtCursor;
		proto.insertTextAtCursor = function (this: EditorLike, text: string): void {
			let replacement = text;
			try {
				const { enabled, store } = patched.hooks;
				const mimeType = enabled() ? clipboardImageMime(text, tmpdir()) : undefined;
				// Bash mode runs the text as a shell command, so it needs the real file path.
				if (mimeType && !this.getText().trimStart().startsWith("!")) {
					const data = readImageBase64(text);
					if (data !== undefined) {
						// An empty input starts a fresh prompt: images and numbering start over.
						if (!this.getText().trim()) store.reset();
						const id = store.add({ data, mimeType });
						const cursor = this.getCursor();
						const line = this.getLines()[cursor.line] ?? "";
						const charBefore = cursor.col > 0 ? line[cursor.col - 1] ?? "" : "";
						const charAfter = line[cursor.col] ?? "";
						replacement = spacedPlaceholder(placeholder(id), charBefore, charAfter);
						try {
							unlinkSync(text);
						} catch {
							// Another process removed the file or the filesystem refuses; harmless.
						}
					}
				}
			} catch {
				// Any unexpected state falls back to pi's own behavior.
				replacement = text;
			}
			return insert.call(this, replacement);
		};
	}
	const originalSegment = proto.segment;
	if (typeof originalSegment === "function") {
		const segment = originalSegment as SegmentFn;
		proto.segment = function (this: EditorLike, text: string, mode: string): Iterable<TextSegment> {
			const base = segment.call(this, text, mode);
			try {
				const { enabled, store } = patched.hooks;
				if (!enabled()) return base;
				return mergePlaceholderSegments(text, base, store.ids());
			} catch {
				return base;
			}
		};
	}
	proto[KEY] = patched;
}

/** Read a pasted image file. Returns undefined when the read fails, so the path stays in the input. */
function readImageBase64(path: string): string | undefined {
	try {
		return readFileSync(path).toString("base64");
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_IMAGE_PASTE === "0" || process.env.PI_SUBAGENT_CHILD === "1") return;

	const store = new ImageStore();
	let enabled = false;
	installEditorPatch({ enabled: () => enabled, store });

	pi.on("session_start", () => {
		enabled = true;
		store.reset();
	});

	pi.on("session_shutdown", () => {
		enabled = false;
		store.reset();
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive") return;
		const images = store.take(event.text);
		if (images.length === 0) return;
		return {
			action: "transform",
			text: event.text,
			images: [
				...(event.images ?? []),
				...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
			],
		};
	});
}
