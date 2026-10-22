/**
 * Pure parts of terminal-status: the state tracker, terminal capability detection and the
 * escape sequences. No pi imports, so `node --test` loads this file directly.
 *
 * States follow the Program Status Protocol (OSC 7501) that pi already reports natively:
 * idle, working, blocked, done, error. This module renders the same states for terminals
 * that do not speak OSC 7501, mainly Windows Terminal (OSC 9;4 tab/taskbar ring + title).
 */

export type StatusState = "idle" | "working" | "blocked" | "done" | "error";

export interface Status {
	state: StatusState;
	/** Dialog title for blocked, first error line for error. Never prompts or model output. */
	message?: string;
}

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/**
 * Derives the current status from pi lifecycle events. Mirrors pi's own
 * ProgramStatusReporter, plus one addition: `done` and `error` stay "unseen" until the
 * user presses a key in the terminal, then fall back to `idle`.
 */
export class StatusTracker {
	private runActive = false;
	private compacting = false;
	private blockedTitle: string | undefined;
	private blocked = false;
	private runResult: Status = { state: "done" };
	private resting: Status = { state: "idle" };

	agentStart(): void {
		this.runActive = true;
		this.compacting = false;
		this.runResult = { state: "done" };
	}

	/** The latest assistant message decides the outcome, so a retried error is replaced by its retry. */
	assistantEnd(stopReason: string | undefined, errorMessage?: string): void {
		this.runResult = stopReason === "error" ? { state: "error", message: firstLine(errorMessage) } : { state: "done" };
	}

	settled(aborted: boolean): void {
		this.runActive = false;
		this.compacting = false;
		this.resting = aborted ? { state: "idle" } : this.runResult;
	}

	compactStart(): void {
		this.compacting = true;
	}

	compactEnd(result: { aborted?: boolean; errorMessage?: string; manual?: boolean }): void {
		this.compacting = false;
		if (this.runActive) {
			if (result.aborted) this.runResult = { state: "idle" };
			else if (result.errorMessage) this.runResult = { state: "error", message: firstLine(result.errorMessage) };
		} else if (result.manual) {
			this.resting = result.errorMessage
				? { state: "error", message: firstLine(result.errorMessage) }
				: result.aborted
					? { state: "idle" }
					: { state: "done" };
		}
	}

	setBlocked(title: string | undefined, active: boolean): void {
		this.blocked = active;
		this.blockedTitle = active ? title : undefined;
	}

	/** The user interacted with the terminal: an unseen done/error result has been seen. */
	userInput(): boolean {
		if (this.runActive || (this.resting.state !== "done" && this.resting.state !== "error")) return false;
		this.resting = { state: "idle" };
		return true;
	}

	reset(): void {
		this.runActive = false;
		this.compacting = false;
		this.blocked = false;
		this.blockedTitle = undefined;
		this.runResult = { state: "done" };
		this.resting = { state: "idle" };
	}

	current(): Status {
		if (this.blocked) return { state: "blocked", message: this.blockedTitle };
		if (this.compacting || this.runActive) return { state: "working" };
		return this.resting;
	}
}

export type ProgressMode = "auto" | "on" | "off";

export interface TerminalStatusConfig {
	/** OSC 9;4 tab/taskbar ring. auto = only on terminals known to render it. */
	progress: ProgressMode;
	/** Prefix the tab title with a state icon. */
	title: boolean;
}

export const DEFAULT_CONFIG: TerminalStatusConfig = { progress: "auto", title: true };

export function mergeConfig(raw: unknown): TerminalStatusConfig {
	const config = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object") return config;
	const input = raw as Record<string, unknown>;
	if (input.progress === "auto" || input.progress === "on" || input.progress === "off") config.progress = input.progress;
	if (typeof input.title === "boolean") config.title = input.title;
	return config;
}

type Env = Record<string, string | undefined>;

function versionAtLeast(version: string | undefined, min: string): boolean {
	if (!version) return false;
	const a = version.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
	const b = min.split(".").map((n) => Number.parseInt(n, 10));
	for (let i = 0; i < b.length; i++) {
		if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
	}
	return true;
}

export interface Capabilities {
	terminal: string;
	multiplexer: string | undefined;
	/** Whether this terminal renders OSC 9;4. */
	progress: boolean;
}

/**
 * Terminals that render OSC 9;4. Windows Terminal sets WT_SESSION and forwards it into WSL
 * through WSLENV; it has rendered OSC 9;4 as a tab ring and taskbar progress since v1.6.
 * Inside tmux/screen/zellij the sequence is not forwarded, so it is skipped there.
 */
export function detectCapabilities(env: Env): Capabilities {
	const multiplexer = env.TMUX ? "tmux" : env.STY ? "screen" : env.ZELLIJ ? "zellij" : undefined;
	let terminal = "unknown";
	let progress = false;
	if (env.WT_SESSION) {
		terminal = "Windows Terminal";
		progress = true;
	} else if (env.ConEmuANSI || env.ConEmuPID || env.ConEmuTask) {
		terminal = "ConEmu";
		progress = true;
	} else if (env.TERM_PROGRAM === "ghostty" || env.TERM === "xterm-ghostty") {
		terminal = "Ghostty";
		progress = env.TERM_PROGRAM !== "ghostty" || versionAtLeast(env.TERM_PROGRAM_VERSION, "1.2.0");
	} else if (env.TERM_PROGRAM === "iTerm.app") {
		terminal = "iTerm2";
		progress = versionAtLeast(env.TERM_PROGRAM_VERSION, "3.6.6");
	} else if (env.TERM_PROGRAM) {
		terminal = env.TERM_PROGRAM;
	}
	return { terminal, multiplexer, progress: progress && !multiplexer };
}

const BEL = "\x07";

/** OSC 9;4 progress for a status: indeterminate while working, warning while blocked, error while unseen. */
export function progressSequence(status: Status): string {
	switch (status.state) {
		case "working":
			return `\x1b]9;4;3${BEL}`;
		case "blocked":
			return `\x1b]9;4;4;100${BEL}`;
		case "error":
			return `\x1b]9;4;2;100${BEL}`;
		default:
			return `\x1b]9;4;0${BEL}`;
	}
}

export const CLEAR_PROGRESS = `\x1b]9;4;0${BEL}`;

/** Same two frames and cadence as Claude Code's tab title. */
export const WORKING_FRAMES = ["◐", "◑"];
export const FRAME_MS = 960;

const ICONS: Record<Exclude<StatusState, "working">, string> = {
	idle: "✳",
	blocked: "⏸",
	done: "✓",
	error: "✗",
};

export function stateIcon(state: StatusState, frame = 0): string {
	return state === "working" ? WORKING_FRAMES[frame % WORKING_FRAMES.length] : ICONS[state];
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Tab title: icon, session name (or π), project directory. Control characters removed. */
export function formatTitle(status: Status, frame: number, sessionName: string | undefined, cwdName: string): string {
	const name = (sessionName ?? "").replace(CONTROL, " ").trim();
	const dir = cwdName.replace(CONTROL, " ").trim();
	const label = name ? (dir ? `${name} · ${dir}` : name) : dir ? `π · ${dir}` : "π";
	const chars = Array.from(label);
	const clipped = chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : label;
	return `${stateIcon(status.state, frame)} ${clipped}`;
}

export function titleSequence(title: string): string {
	return `\x1b]0;${title}${BEL}`;
}

/** Raw input that is not the user looking at the tab: mouse reports and focus events. */
export function isPassiveInput(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data === "\x1b[I" || data === "\x1b[O" || /^\x1b\[M/.test(data);
}
