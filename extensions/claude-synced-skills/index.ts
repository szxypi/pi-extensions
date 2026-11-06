/**
 * claude-synced-skills: load Claude Code's claude.ai-synced skills into pi without name collisions.
 *
 * Claude Code writes one bucket per claude.ai account to `~/.claude/skills/synced/<bucket>/`.
 * The same skill exists in several buckets with different versions. Pi scans that tree
 * by itself and reports a collision for each duplicate name. This extension replaces the
 * scan: on `resources_discover` it picks one SKILL.md per name (newest wins) and returns
 * the file paths. Add `/synced/` to `~/.claude/skills/.gitignore` so pi skips the tree itself.
 *
 * Config: ~/.pi/agent/claude-synced-skills.json, `{ "skip": ["name", ...] }` (see README).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSkip, selectSkills } from "./select.ts";

const CONFIG_FILE = "claude-synced-skills.json";

function loadSkip(): readonly string[] {
	const path = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(path)) return resolveSkip(undefined);
	try {
		return resolveSkip(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return resolveSkip(undefined);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		try {
			const syncedDir = join(homedir(), ".claude", "skills", "synced");
			const skillPaths = selectSkills(syncedDir, loadSkip()).map((skill) => skill.path);
			return { skillPaths };
		} catch {
			return {};
		}
	});
}
