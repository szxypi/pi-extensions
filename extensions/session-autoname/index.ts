/**
 * session-autoname: give each pi session a short title generated from the first request.
 *
 * - Runs once per session, in parallel with the first agent run, so the name shows up
 *   while the agent is still working.
 * - Never overwrites a name set with /name, --name or another extension.
 * - Falls back to a clipped first line of the prompt when the model call fails.
 * - Skips print/json modes and pi-subagents child processes.
 *
 * Config: ~/.pi/agent/session-autoname.json (see README).
 * Command: /autoname          regenerate the title for the current session
 *          /autoname status   show config and current name
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type AutonameConfig,
	SYSTEM_PROMPT,
	buildNamingPrompt,
	fallbackTitle,
	firstExchange,
	mergeConfig,
	messageText,
	sanitizeTitle,
} from "./naming.ts";

const CONFIG_FILE = "session-autoname.json";

function loadConfig(): AutonameConfig {
	const path = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(path)) return mergeConfig(undefined);
	try {
		return mergeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return mergeConfig(undefined);
	}
}

export default function (pi: ExtensionAPI) {
	// Session-scoped state. `generation` changes on every shutdown so late results
	// from an old session are dropped instead of touching a stale ctx.
	let generation = 0;
	let attempted = false;
	let inflight: AbortController | undefined;

	const isChild = process.env.PI_SUBAGENT_CHILD === "1";

	function resolveModel(ctx: ExtensionContext, config: AutonameConfig) {
		if (config.model) {
			const slash = config.model.indexOf("/");
			if (slash > 0) {
				const found = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
				if (found) return found;
			}
		}
		return ctx.model;
	}

	async function generateTitle(
		ctx: ExtensionContext,
		config: AutonameConfig,
		user: string,
		assistant: string,
		signal: AbortSignal,
	): Promise<string> {
		const model = resolveModel(ctx, config);
		if (!model) return "";
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [{ role: "user", content: buildNamingPrompt(user, assistant), timestamp: Date.now() }],
			},
			// Lowest thinking effort; models without reasoning clamp to off. maxTokens leaves
			// room for models that think anyway. Empty output falls back to the prompt.
			{ reasoning: "minimal", maxTokens: 1024, signal },
		);
		const reply = await stream.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return "";
		return sanitizeTitle(messageText(reply), config.maxLength);
	}

	/** Generate and apply a name. Resolves to the applied name, or undefined. */
	async function nameSession(ctx: ExtensionContext, prompt: string, force: boolean): Promise<string | undefined> {
		const config = loadConfig();
		if (!force && !config.enabled) return undefined;

		const { user: branchUser, assistant } = firstExchange(ctx.sessionManager.getBranch());
		const user = branchUser || prompt.trim();
		if (!user) return undefined;

		inflight?.abort();
		const controller = new AbortController();
		inflight = controller;
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		timer.unref?.();
		const myGeneration = generation;

		let title = "";
		try {
			title = await generateTitle(ctx, config, user, assistant, controller.signal);
		} catch {
			title = "";
		} finally {
			clearTimeout(timer);
			if (inflight === controller) inflight = undefined;
		}

		// Session replaced or reloaded while waiting: ctx and pi belong to a dead runtime.
		if (myGeneration !== generation) return undefined;
		if (!title) title = fallbackTitle(user, config.maxLength);
		if (!title) return undefined;
		// Respect a name the user set while the request was running.
		if (!force && pi.getSessionName()) return undefined;
		pi.setSessionName(title);
		return title;
	}

	pi.on("session_start", () => {
		attempted = false;
	});

	pi.on("session_shutdown", () => {
		generation++;
		inflight?.abort();
		inflight = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (attempted || isChild) return;
		if (ctx.mode === "print" || ctx.mode === "json") return;
		if (event.messageType !== "user") return;
		attempted = true;
		if (pi.getSessionName()) return;
		// Fire and forget: never delay the main run.
		void nameSession(ctx, event.prompt, false).catch(() => undefined);
	});

	pi.registerCommand("autoname", {
		description: "Regenerate the session name from the first request (/autoname status shows config)",
		handler: async (args, ctx) => {
			if (args.trim() === "status") {
				const config = loadConfig();
				const model = resolveModel(ctx, config);
				ctx.ui.notify(
					[
						`enabled: ${config.enabled}`,
						`model: ${model ? `${model.provider}/${model.id}` : "(none)"}${config.model ? "" : " (current)"}`,
						`name: ${pi.getSessionName() ?? "(unset)"}`,
					].join("\n"),
					"info",
				);
				return;
			}
			const name = await nameSession(ctx, "", true);
			ctx.ui.notify(name ? `Session named: ${name}` : "Nothing to name yet: send a message first", name ? "info" : "warning");
		},
	});
}
