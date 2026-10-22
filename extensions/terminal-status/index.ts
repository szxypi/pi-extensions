/**
 * terminal-status: show pi's run state on the terminal tab, for terminals that do not
 * speak OSC 7501 (pi already sends OSC 7501 natively once the terminal confirms support).
 *
 * - OSC 9;4 progress: Windows Terminal draws it as a ring on the tab and progress on the
 *   taskbar button. Indeterminate while working, warning (yellow) while a dialog waits for
 *   you, error (red) after a failed run, cleared otherwise.
 * - Tab title: state icon + session name + project directory. Working toggles ◐/◑ every
 *   960 ms like Claude Code; idle ✳, blocked ⏸, done ✓, error ✗.
 * - done/error stay until you press a key in the terminal, then fall back to idle.
 *
 * Config: ~/.pi/agent/terminal-status.json  { "progress": "auto" | "on" | "off", "title": true }
 * Env:    PI_TERMINAL_STATUS=0 disables the extension.
 * Command: /terminal-status shows detection and the current state.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CLEAR_PROGRESS,
	FRAME_MS,
	StatusTracker,
	type TerminalStatusConfig,
	detectCapabilities,
	formatTitle,
	isPassiveInput,
	mergeConfig,
	progressSequence,
	titleSequence,
} from "./status.ts";

const CONFIG_FILE = "terminal-status.json";

function loadConfig(): TerminalStatusConfig {
	const path = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(path)) return mergeConfig(undefined);
	try {
		return mergeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return mergeConfig(undefined);
	}
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_TERMINAL_STATUS === "0" || process.env.PI_SUBAGENT_CHILD === "1") return;

	const tracker = new StatusTracker();
	const caps = detectCapabilities(process.env);

	// Session-scoped state, reset in session_start and torn down in session_shutdown.
	let active = false;
	let config = mergeConfig(undefined);
	let useProgress = false;
	let cwdName = "";
	let sessionName: string | undefined;
	let frame = 0;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let deferred: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let lastProgress = "";
	let lastTitle = "";

	const write = (data: string) => {
		if (!process.stdout.isTTY) return;
		try {
			process.stdout.write(data);
		} catch {
			// The terminal went away; nothing useful to do.
		}
	};

	/** Write the current state. `force` re-sends unchanged sequences (keepalive, title restore). */
	function render(force = false) {
		if (!active) return;
		const status = tracker.current();
		if (useProgress) {
			const seq = progressSequence(status);
			if (force || seq !== lastProgress) {
				lastProgress = seq;
				write(seq);
			}
		}
		if (config.title) {
			const title = formatTitle(status, frame, sessionName, cwdName);
			if (force || title !== lastTitle) {
				lastTitle = title;
				write(titleSequence(title));
			}
		}
		syncTicker(status.state === "working");
	}

	/** Animate the title and keep OSC 9;4 alive (Ghostty drops it after ~15 s) while working. */
	function syncTicker(working: boolean) {
		if (working && !ticker) {
			ticker = setInterval(() => {
				frame++;
				render(true);
			}, FRAME_MS);
			ticker.unref?.();
		} else if (!working && ticker) {
			clearInterval(ticker);
			ticker = undefined;
			frame = 0;
		}
	}

	const update = () => render();

	// pi rewrites the title itself after binding a session and on session_info_changed
	// (before extensions see the event). Re-apply ours right after.
	function renderSoon() {
		if (deferred) clearTimeout(deferred);
		deferred = setTimeout(() => {
			deferred = undefined;
			render(true);
		}, 50);
		deferred.unref?.();
	}

	const onExit = () => {
		if (useProgress && lastProgress && lastProgress !== CLEAR_PROGRESS) write(CLEAR_PROGRESS);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !process.stdout.isTTY) return;
		config = loadConfig();
		// pi's own terminal.showTerminalProgress writes OSC 9;4 too; don't fight over it.
		const piProgress = pi.getSettings().terminal?.showTerminalProgress === true;
		useProgress = !piProgress && (config.progress === "on" || (config.progress === "auto" && caps.progress));
		cwdName = basename(ctx.cwd);
		sessionName = pi.getSessionName();
		tracker.reset();
		lastProgress = "";
		lastTitle = "";
		active = true;
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!isPassiveInput(data) && tracker.userInput()) render();
			return undefined;
		});
		process.once("exit", onExit);
		render(true);
		renderSoon();
	});

	pi.on("session_shutdown", (event) => {
		if (!active) return;
		active = false;
		syncTicker(false);
		if (deferred) clearTimeout(deferred);
		deferred = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		process.removeListener("exit", onExit);
		// Reload and session switches hand over to the next runtime, which renders again.
		if (event.reason === "quit") {
			if (useProgress) write(CLEAR_PROGRESS);
			if (config.title) write(titleSequence(sessionName ? `π - ${sessionName} - ${cwdName}` : `π - ${cwdName}`));
		}
	});

	pi.on("session_info_changed", (event) => {
		sessionName = event.name;
		renderSoon();
	});

	pi.on("agent_start", () => {
		tracker.agentStart();
		update();
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") return;
		tracker.assistantEnd(message.stopReason, message.errorMessage);
	});

	pi.on("agent_settled", (event) => {
		tracker.settled(event.aborted);
		update();
	});

	pi.on("session_before_compact", () => {
		tracker.compactStart();
		update();
	});

	pi.on("session_compact", (event) => {
		tracker.compactEnd({ manual: event.reason === "manual" });
		update();
	});

	pi.on("session_compact_failed", (event) => {
		tracker.compactEnd({ aborted: event.aborted, errorMessage: event.errorMessage, manual: event.reason === "manual" });
		update();
	});

	pi.on("ui_prompt_start", (event) => {
		tracker.setBlocked(event.title, true);
		update();
	});

	pi.on("ui_prompt_end", () => {
		tracker.setBlocked(undefined, false);
		update();
	});

	pi.registerCommand("terminal-status", {
		description: "Show terminal-status detection and the current tab state",
		handler: async (_args, ctx) => {
			const status = tracker.current();
			ctx.ui.notify(
				[
					`terminal: ${caps.terminal}${caps.multiplexer ? ` (inside ${caps.multiplexer})` : ""}`,
					`OSC 9;4 progress: ${active && useProgress ? "on" : "off"} (config ${config.progress})`,
					`title: ${active && config.title ? "on" : "off"}`,
					`state: ${status.state}${status.message ? ` (${status.message})` : ""}`,
				].join("\n"),
				"info",
			);
		},
	});
}
