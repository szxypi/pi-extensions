/**
 * gateway-models: drop models that a gateway no longer lists.
 *
 * Pi has no models.json option to discover models from a gateway. This extension registers a
 * `refreshModels` hook for one provider. The hook reads that provider's models from models.json,
 * calls `<baseUrl>/models`, and returns only the models the gateway lists.
 * A failed request returns the models.json list unchanged.
 *
 * Config: ~/.pi/agent/gateway-models.json, `{ "provider": "cpamc", "includeUnknown": false }`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { filterCatalog, parseListedIds, type ModelDef } from "./discover.ts";

const CONFIG_FILE = "gateway-models.json";
const TIMEOUT_MS = 8000;

function readJson(path: string): any {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const dir = getAgentDir();
	const config = readJson(join(dir, CONFIG_FILE)) ?? {};
	const providerId: string = typeof config.provider === "string" ? config.provider : "cpamc";
	const includeUnknown = config.includeUnknown === true;
	const provider = readJson(join(dir, "models.json"))?.providers?.[providerId];
	if (!provider?.baseUrl || !Array.isArray(provider.models)) return;
	const known: ModelDef[] = provider.models;

	pi.registerProvider(providerId, {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		api: provider.api,
		async refreshModels(context) {
			if (!context.allowNetwork) return known as any;
			try {
				const credential: any = context.credential;
				const key = credential?.type === "api_key" ? credential.key : provider.apiKey;
				const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
				const response = await fetch(`${String(provider.baseUrl).replace(/\/$/, "")}/models`, {
					headers: key ? { Authorization: `Bearer ${key}` } : {},
					signal,
				});
				if (!response.ok) return known as any;
				const listed = parseListedIds(await response.json());
				if (!listed) return known as any;
				return filterCatalog(known, listed, { includeUnknown }) as any;
			} catch {
				return known as any;
			}
		},
	});
}
