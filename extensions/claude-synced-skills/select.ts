/**
 * Pure logic for claude-synced-skills (no pi imports, so it runs under plain Node tests).
 *
 * Claude Code keeps one bucket directory per claude.ai account under `<skills>/synced/`.
 * Each bucket has a `manifest.json` and one `<name>/SKILL.md` per skill. The same skill
 * name appears in several buckets with different versions. This module picks one
 * `SKILL.md` per name.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Skills that need claude.ai connectors or memory tools, which pi does not have. */
export const DEFAULT_SKIP: readonly string[] = [
	"skill-creator",
	"docs",
	"google-workspace",
	"import-memory",
	"morning",
	"setup-writing-style",
];

export interface Candidate {
	name: string;
	bucket: string;
	/** Absolute path of the SKILL.md file. */
	path: string;
	/** Skill `updatedAt` in ms, NaN when missing or invalid. */
	updatedAt: number;
	/** Bucket `lastUpdated` in ms, NaN when missing or invalid. */
	bucketUpdated: number;
}

export interface SelectedSkill {
	name: string;
	path: string;
	bucket: string;
}

/** NaN ranks below every valid number. */
function rank(value: number): number {
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Positive when `a` should win over `b`. */
export function compareCandidates(a: Candidate, b: Candidate): number {
	const byUpdated = rank(a.updatedAt) - rank(b.updatedAt);
	if (byUpdated !== 0 && !Number.isNaN(byUpdated)) return byUpdated;
	const byBucket = rank(a.bucketUpdated) - rank(b.bucketUpdated);
	if (byBucket !== 0 && !Number.isNaN(byBucket)) return byBucket;
	// Plain code-unit comparison keeps the result independent of locale.
	if (a.bucket === b.bucket) return 0;
	return a.bucket > b.bucket ? 1 : -1;
}

function toMillis(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") return Date.parse(value);
	return Number.NaN;
}

function readManifest(dir: string): { lastUpdated: number; skills: unknown[] } | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const { lastUpdated, skills } = parsed as { lastUpdated?: unknown; skills?: unknown };
		if (!Array.isArray(skills)) return undefined;
		return { lastUpdated: toMillis(lastUpdated), skills };
	} catch {
		return undefined;
	}
}

/** A skill name must be a plain directory name. */
function isSafeName(name: unknown): name is string {
	return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

/**
 * Pick one SKILL.md per skill name from every bucket under `syncedDir`.
 * Newest `updatedAt` wins, then the bucket's `lastUpdated`, then the bucket directory name.
 * Skills in `skip`, entries without a SKILL.md file, and buckets without a valid manifest are ignored.
 * Never throws. The result is sorted by name.
 */
export function selectSkills(syncedDir: string, skip: readonly string[] = DEFAULT_SKIP): SelectedSkill[] {
	let buckets: string[];
	try {
		buckets = readdirSync(syncedDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}

	const skipSet = new Set(skip);
	const best = new Map<string, Candidate>();
	for (const bucket of buckets) {
		const bucketDir = join(syncedDir, bucket);
		const manifest = readManifest(bucketDir);
		if (!manifest) continue;
		for (const entry of manifest.skills) {
			if (!entry || typeof entry !== "object") continue;
			const { name, updatedAt } = entry as { name?: unknown; updatedAt?: unknown };
			if (!isSafeName(name) || skipSet.has(name)) continue;
			const path = join(bucketDir, name, "SKILL.md");
			// A bucket can be mid-sync: the manifest lists the skill before the file exists.
			// Check before ranking so the skill falls through to another bucket.
			if (!existsSync(path)) continue;
			const candidate: Candidate = {
				name,
				bucket,
				path,
				updatedAt: toMillis(updatedAt),
				bucketUpdated: manifest.lastUpdated,
			};
			const current = best.get(name);
			if (!current || compareCandidates(candidate, current) > 0) best.set(name, candidate);
		}
	}

	return [...best.values()]
		.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))
		.map(({ name, path, bucket }) => ({ name, path, bucket }));
}

/** Read the skip list from a parsed config. Anything invalid gives the default list. */
export function resolveSkip(config: unknown): readonly string[] {
	if (!config || typeof config !== "object") return DEFAULT_SKIP;
	const skip = (config as { skip?: unknown }).skip;
	if (!Array.isArray(skip) || !skip.every((item) => typeof item === "string")) return DEFAULT_SKIP;
	return skip.map((item) => item.trim()).filter(Boolean);
}
