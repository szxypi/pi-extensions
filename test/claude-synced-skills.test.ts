import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SKIP, resolveSkip, selectSkills } from "../extensions/claude-synced-skills/select.ts";

interface Entry {
	name: string;
	updatedAt?: string;
	/** Set false to list the skill in the manifest without creating SKILL.md. */
	file?: boolean;
}

function makeSynced(): { dir: string; bucket: (id: string, lastUpdated: number, skills: Entry[]) => void; done: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "synced-skills-"));
	return {
		dir,
		bucket(id, lastUpdated, skills) {
			mkdirSync(join(dir, id), { recursive: true });
			writeFileSync(
				join(dir, id, "manifest.json"),
				JSON.stringify({ lastUpdated, skills: skills.map(({ name, updatedAt }) => ({ skillId: name, name, updatedAt })) }),
			);
			for (const skill of skills) {
				if (skill.file === false) continue;
				mkdirSync(join(dir, id, skill.name), { recursive: true });
				writeFileSync(join(dir, id, skill.name, "SKILL.md"), `---\nname: ${skill.name}\n---\n${id}\n`);
			}
		},
		done: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const pick = (list: ReturnType<typeof selectSkills>, name: string) => list.find((skill) => skill.name === name);

test("newest updatedAt wins, even with an older bucket", () => {
	const fx = makeSynced();
	try {
		fx.bucket("bucket-a", 100, [{ name: "docx", updatedAt: "2026-11-05T23:00:20.704642Z" }]);
		fx.bucket("bucket-b", 999, [{ name: "docx", updatedAt: "2026-09-30T02:00:31.677168Z" }]);
		const result = selectSkills(fx.dir, []);
		assert.equal(result.length, 1);
		assert.equal(pick(result, "docx")?.bucket, "bucket-a");
		assert.equal(pick(result, "docx")?.path, join(fx.dir, "bucket-a", "docx", "SKILL.md"));
	} finally {
		fx.done();
	}
});

test("equal updatedAt: bucket lastUpdated wins, then bucket directory name", () => {
	const fx = makeSynced();
	try {
		const same = "2026-11-05T23:00:20.704642Z";
		fx.bucket("bucket-a", 100, [{ name: "docx", updatedAt: same }, { name: "pdf", updatedAt: same }]);
		fx.bucket("bucket-b", 200, [{ name: "docx", updatedAt: same }]);
		fx.bucket("bucket-c", 100, [{ name: "pdf", updatedAt: same }]);
		const result = selectSkills(fx.dir, []);
		assert.equal(pick(result, "docx")?.bucket, "bucket-b");
		assert.equal(pick(result, "pdf")?.bucket, "bucket-c");
	} finally {
		fx.done();
	}
});

test("a manifest entry without SKILL.md falls through to another bucket", () => {
	const fx = makeSynced();
	try {
		fx.bucket("bucket-new", 200, [{ name: "xlsx", updatedAt: "2026-11-05T00:00:00Z", file: false }]);
		fx.bucket("bucket-old", 100, [{ name: "xlsx", updatedAt: "2026-09-01T00:00:00Z" }]);
		assert.equal(pick(selectSkills(fx.dir, []), "xlsx")?.bucket, "bucket-old");
	} finally {
		fx.done();
	}
});

test("missing or broken manifests are skipped without throwing", () => {
	const fx = makeSynced();
	try {
		fx.bucket("bucket-ok", 100, [{ name: "pdf", updatedAt: "2026-09-01T00:00:00Z" }]);
		mkdirSync(join(fx.dir, "bucket-none"));
		mkdirSync(join(fx.dir, "bucket-bad"));
		writeFileSync(join(fx.dir, "bucket-bad", "manifest.json"), "{not json");
		mkdirSync(join(fx.dir, "bucket-shape"));
		writeFileSync(join(fx.dir, "bucket-shape", "manifest.json"), JSON.stringify({ skills: "nope" }));
		writeFileSync(join(fx.dir, "stray-file.txt"), "x");
		const result = selectSkills(fx.dir, []);
		assert.deepEqual(result.map((skill) => skill.name), ["pdf"]);
	} finally {
		fx.done();
	}
});

test("a missing synced directory gives an empty list", () => {
	assert.deepEqual(selectSkills(join(tmpdir(), "synced-skills-does-not-exist")), []);
});

test("entries with bad names or dates do not break selection", () => {
	const fx = makeSynced();
	try {
		fx.bucket("bucket-a", 100, [{ name: "pdf", updatedAt: "garbage" }]);
		fx.bucket("bucket-b", 50, [{ name: "pdf", updatedAt: "2026-09-01T00:00:00Z" }]);
		writeFileSync(
			join(fx.dir, "bucket-a", "manifest.json"),
			JSON.stringify({ lastUpdated: 100, skills: [null, { name: "../escape" }, { name: 5 }, { name: "pdf", updatedAt: "garbage" }] }),
		);
		const result = selectSkills(fx.dir, []);
		assert.deepEqual(result.map((skill) => skill.name), ["pdf"]);
		// A valid date outranks an invalid one.
		assert.equal(result[0]?.bucket, "bucket-b");
	} finally {
		fx.done();
	}
});

test("default skip list removes connector-bound skills only", () => {
	const fx = makeSynced();
	try {
		const names = [...DEFAULT_SKIP, "docx", "deep-research", "computer-use"];
		fx.bucket("bucket-a", 100, names.map((name) => ({ name, updatedAt: "2026-09-01T00:00:00Z" })));
		assert.deepEqual(selectSkills(fx.dir).map((skill) => skill.name), ["computer-use", "deep-research", "docx"]);
	} finally {
		fx.done();
	}
});

test("resolveSkip: config replaces the list, bad config gives the default", () => {
	assert.deepEqual(resolveSkip({ skip: [" docs ", "morning", ""] }), ["docs", "morning"]);
	assert.deepEqual(resolveSkip({ skip: [] }), []);
	assert.equal(resolveSkip(undefined), DEFAULT_SKIP);
	assert.equal(resolveSkip("x"), DEFAULT_SKIP);
	assert.equal(resolveSkip({}), DEFAULT_SKIP);
	assert.equal(resolveSkip({ skip: "docs" }), DEFAULT_SKIP);
	assert.equal(resolveSkip({ skip: ["docs", 1] }), DEFAULT_SKIP);
});
