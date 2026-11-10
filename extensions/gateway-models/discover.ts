/**
 * Pure helpers for gateway-models: filter a known model list by the ids a gateway lists.
 */

export interface ModelDef {
	id: string;
	[key: string]: unknown;
}

export interface DiscoverOptions {
	/** Also add gateway ids that are not in the known list, with conservative defaults. Default false. */
	includeUnknown?: boolean;
}

/** Ids of image, speech and voice models. They never become chat models. */
export const SKIP_PATTERN = /(^|[-/])(image|tts|voice)([-./]|$)/i;

export function parseListedIds(body: unknown): string[] | undefined {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return undefined;
	return data
		.map((item) => (item as { id?: unknown } | null)?.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function defaultModel(id: string): ModelDef {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

/**
 * Keep known models that the gateway lists. An empty result returns the known list unchanged,
 * so a broken gateway response never removes every model.
 */
export function filterCatalog(known: readonly ModelDef[], listed: readonly string[], options: DiscoverOptions = {}): ModelDef[] {
	const listedSet = new Set(listed);
	const kept = known.filter((model) => listedSet.has(model.id));
	if (kept.length === 0) return [...known];
	if (!options.includeUnknown) return kept;
	const knownIds = new Set(known.map((model) => model.id));
	const extra = listed.filter((id) => !knownIds.has(id) && !SKIP_PATTERN.test(id)).map(defaultModel);
	return [...kept, ...extra];
}
