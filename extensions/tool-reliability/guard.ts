/**
 * tool-reliability guard: pure logic for retry-loop blocking, edit precheck
 * and error recovery hints. No pi imports, so tests run on plain Node.
 */

/** Serialize a value deterministically (sorted object keys) for fingerprinting. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

/**
 * Fingerprint for one tool call. bash and powershell include the session cwd
 * and the full command, because the same command text behaves differently in
 * different directories. Other tools key on tool name plus full arguments.
 */
export function fingerprint(toolName: string, input: unknown, cwd?: string): string {
	if ((toolName === "bash" || toolName === "powershell") && typeof cwd === "string") {
		return `${toolName}\ncwd:${cwd}\n${stableStringify(input)}`;
	}
	return `${toolName}\n${stableStringify(input)}`;
}

/** First non-empty line of an error text, clipped for display. */
export function summarizeError(text: string, max = 120): string {
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return "(empty error)";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

const MAX_RECORDS = 200;

interface FailureRecord {
	count: number;
	lastError: string;
}

/**
 * Tracks consecutive failures per fingerprint. Reset semantics are narrow:
 * a success clears only its own fingerprint; a successful edit or write also
 * clears bash failures, because the code the command runs against may have
 * changed. Success of any other tool clears nothing else.
 */
export class FailureTracker {
	private records = new Map<string, FailureRecord>();
	private threshold: number;

	constructor(threshold = 2) {
		this.threshold = threshold;
	}

	recordFailure(fp: string, errorSummary: string): void {
		const record = this.records.get(fp);
		if (record) {
			record.count += 1;
			record.lastError = errorSummary;
		} else {
			this.records.set(fp, { count: 1, lastError: errorSummary });
		}
		while (this.records.size > MAX_RECORDS) {
			const oldest = this.records.keys().next();
			if (oldest.done) break;
			this.records.delete(oldest.value);
		}
	}

	recordSuccess(toolName: string, input: unknown, cwd?: string): void {
		this.records.delete(fingerprint(toolName, input, cwd));
		if (toolName === "edit" || toolName === "write") {
			for (const key of this.records.keys()) {
				if (key.startsWith("bash\n") || key.startsWith("powershell\n")) {
					this.records.delete(key);
				}
			}
		}
	}

	isBlocked(fp: string): boolean {
		const record = this.records.get(fp);
		return record !== undefined && record.count >= this.threshold;
	}

	count(fp: string): number {
		return this.records.get(fp)?.count ?? 0;
	}

	size(): number {
		return this.records.size;
	}

	lastError(fp: string): string | undefined {
		return this.records.get(fp)?.lastError;
	}

	reset(): void {
		this.records.clear();
	}
}

/** Block reason with a change-approach instruction for the model. */
export function blockReason(toolName: string, count: number, lastError?: string): string {
	const lines = [
		`[tool-reliability] ${toolName} failed ${count} times in a row with the same arguments.`,
	];
	if (lastError) lines.push(`Last error: ${lastError}`);
	lines.push(
		"Do not retry the identical call.",
		"Change approach: re-read the current file or command output, adjust the arguments, or pick a different tool.",
	);
	return lines.join("\n");
}

interface EditPair {
	index: number;
	oldText: string;
	newText: string;
}

function asEditPairs(input: unknown): EditPair[] | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const edits = (input as Record<string, unknown>).edits;
	if (!Array.isArray(edits)) return undefined;
	const pairs: EditPair[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (!edit || typeof edit !== "object") return undefined;
		const { oldText, newText } = edit as Record<string, unknown>;
		if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
		pairs.push({ index: i, oldText, newText });
	}
	return pairs.length > 0 ? pairs : undefined;
}

/**
 * Parameter-only edit precheck. Detects mistakes that are certain from the
 * arguments alone: empty oldText, oldText === newText, and duplicate or
 * containing oldText within one call. Runtime match failures (not found,
 * multiple occurrences) stay with the native tool and its recovery hints.
 * Returns a concrete fix description, or undefined when nothing is certain.
 */
export function checkEditInput(input: unknown): string | undefined {
	const pairs = asEditPairs(input);
	if (!pairs) return undefined;
	for (const pair of pairs) {
		if (pair.oldText.trim() === "") {
			return `edits[${pair.index}].oldText is empty. oldText must be the exact existing text to replace. Set oldText to a unique snippet from the file and newText to its replacement.`;
		}
		if (pair.oldText === pair.newText) {
			return `edits[${pair.index}] has identical oldText and newText, so it changes nothing. Set newText to the desired new content, or drop this edit if no change is intended.`;
		}
	}
	for (let i = 0; i < pairs.length; i++) {
		for (let j = i + 1; j < pairs.length; j++) {
			const a = pairs[i];
			const b = pairs[j];
			if (a.oldText === b.oldText) {
				return `edits[${a.index}] and edits[${b.index}] have identical oldText. Each oldText must be unique in one call. Merge them into a single edit, or use distinct oldText snippets.`;
			}
			if (a.oldText.includes(b.oldText) || b.oldText.includes(a.oldText)) {
				return `edits[${a.index}] and edits[${b.index}] overlap: one oldText contains the other, so both cannot match uniquely. Merge them into one edit, or shorten each oldText to a disjoint, unique snippet.`;
			}
		}
	}
	return undefined;
}

/**
 * Short recovery hint for a real tool error. Returns undefined when the error
 * text matches nothing known. Hints are appended to the original result
 * content; the original error text is never rewritten.
 */
export function recoveryHint(toolName: string, errorText: string): string | undefined {
	const text = errorText;
	switch (toolName) {
		case "edit": {
			if (/oldText must not be empty/.test(text)) {
				return "[tool-reliability] oldText was empty. Re-read the target file, then set oldText to the exact existing snippet you want to replace.";
			}
			if (/overlap/.test(text)) {
				return "[tool-reliability] The oldText entries overlap. Merge the overlapping entries into one edit, or shorten them to disjoint, unique snippets.";
			}
			if (/occurrences of/.test(text) || /must be unique|Each oldText must be unique/.test(text)) {
				return "[tool-reliability] The oldText matches more than one location. Re-read the file and extend oldText with surrounding lines so it matches exactly once.";
			}
			if (/Could not find|did not match|not match exactly/.test(text)) {
				return "[tool-reliability] oldText does not match the file exactly. Re-read the file and copy the target text verbatim, including whitespace and indentation; do not guess.";
			}
			return undefined;
		}
		case "read":
		case "grep":
		case "find":
		case "ls": {
			if (/ENOENT|no such file or directory/i.test(text)) {
				return "[tool-reliability] The path does not exist. Check the path for typos, or run ls/find on the parent directory to locate the file. Relative paths resolve against the session working directory.";
			}
			return undefined;
		}
		case "codemode": {
			if (/SyntaxError|Unexpected token|Parse error|not valid JavaScript/i.test(text)) {
				return "[tool-reliability] The codemode script has a syntax error. Fix the reported line, remove stray markdown fences, and keep each tool call awaited; run a smaller script first if unsure.";
			}
			return undefined;
		}
		case "bash":
		case "powershell": {
			// Non-zero exit with no output at all: stderr was likely swallowed.
			const match = /Command exited with code (\d+)\s*$/.exec(text.trim());
			if (match && text.replace(/Command exited with code \d+/, "").trim() === "") {
				return `[tool-reliability] The command exited with code ${match[1]} and produced no output. Re-run with 2>&1 appended (for example: <command> 2>&1) to capture stderr, or check that the command exists.`;
			}
			return undefined;
		}
		default:
			return undefined;
	}
}
