/**
 * Pure helpers for session-autoname. No pi imports, so `node --test` can load
 * this file directly with Node's built-in type stripping.
 */

export interface AutonameConfig {
	/** Turn automatic naming on or off. */
	enabled: boolean;
	/** "provider/model-id" used for naming. Empty means the session's current model. */
	model: string;
	/** Maximum title length in characters (code points). */
	maxLength: number;
	/** Abort the naming request after this many milliseconds. */
	timeoutMs: number;
}

export const DEFAULT_CONFIG: AutonameConfig = {
	enabled: true,
	model: "",
	maxLength: 40,
	timeoutMs: 20_000,
};

/** Merge a parsed JSON object over the defaults, ignoring fields with the wrong type. */
export function mergeConfig(raw: unknown): AutonameConfig {
	const config = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object") return config;
	const input = raw as Record<string, unknown>;
	if (typeof input.enabled === "boolean") config.enabled = input.enabled;
	if (typeof input.model === "string") config.model = input.model.trim();
	if (typeof input.maxLength === "number" && input.maxLength >= 8) config.maxLength = Math.floor(input.maxLength);
	if (typeof input.timeoutMs === "number" && input.timeoutMs >= 1000) config.timeoutMs = Math.floor(input.timeoutMs);
	return config;
}

type ContentPart = { type: string; text?: string };
type MessageLike = { role?: string; content?: string | ContentPart[] };
type EntryLike = { type?: string; message?: MessageLike };

/** Join the text parts of a message, skipping images and tool calls. */
export function messageText(message: MessageLike | undefined): string {
	if (!message) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** First user prompt and first assistant reply text on the branch. */
export function firstExchange(entries: readonly EntryLike[]): { user: string; assistant: string } {
	let user = "";
	let assistant = "";
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const text = messageText(entry.message).trim();
		if (!text) continue;
		if (!user && entry.message.role === "user") user = text;
		else if (user && !assistant && entry.message.role === "assistant") assistant = text;
		if (user && assistant) break;
	}
	return { user, assistant };
}

/** Truncate to `max` code points, adding an ellipsis when cut. */
export function clip(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export const SYSTEM_PROMPT = [
	"You name coding-agent sessions.",
	"Read the user's first request and reply with one short title that says what the task is.",
	"Rules:",
	"- Use the same language as the request (Chinese request → Chinese title).",
	"- At most 6 words in English, or 16 characters in Chinese/Japanese/Korean.",
	"- No quotes, no trailing punctuation, no emoji, no prefix like 'Title:'.",
	"- Reply with the title only.",
].join("\n");

/** Build the user message for the naming request. Inputs are clipped to keep the call cheap. */
export function buildNamingPrompt(user: string, assistant = ""): string {
	const parts = [`<request>\n${clip(user, 2000)}\n</request>`];
	if (assistant) parts.push(`<first_reply>\n${clip(assistant, 600)}\n</first_reply>`);
	parts.push("Title:");
	return parts.join("\n\n");
}

const QUOTE_CHARS = /^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/g;
const TRAILING_PUNCT = /[\s.,;:!?。，；：！？、…]+$/u;

/** Turn raw model output into a clean single-line title, or "" when nothing usable remains. */
export function sanitizeTitle(raw: string, maxLength: number = DEFAULT_CONFIG.maxLength): string {
	let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const line = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return "";
	text = line
		.replace(/^#+\s*/, "")
		.replace(/^\*\*(.*)\*\*$/, "$1")
		.replace(/^(title|session name|标题|名称)\s*[:：]\s*/i, "")
		.replace(QUOTE_CHARS, "")
		.replace(TRAILING_PUNCT, "")
		.replace(/\s+/g, " ")
		.trim();
	return text ? clip(text, maxLength) : "";
}

/** Title derived from the prompt itself, used when the model call fails. */
export function fallbackTitle(user: string, maxLength: number = DEFAULT_CONFIG.maxLength): string {
	const firstLine = user
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !l.startsWith("```"));
	if (!firstLine) return "";
	return sanitizeTitle(firstLine.replace(/^\/\S+\s*/, ""), Math.min(maxLength, 30));
}
