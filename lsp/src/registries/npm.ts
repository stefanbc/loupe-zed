import { VersionCache } from "../cache";
import { getJson } from "../http";
import { log } from "../log";
import type { PackageInfo, RegistryHandler } from "../types";
import {
	authHeaderFor,
	hostOf,
	httpsAgent,
	registryFor,
	reloadNpmrc,
} from "./npmrc";

const cache = new VersionCache();
/** Lookups in flight, keyed by package name. */
const pending = new Map<string, Promise<string>>();
/** Registries known to lack "/-/package/<name>/dist-tags". */
const noDistTags = new Set<string>();

// Abbreviated metadata is much smaller than the full packument but still
// contains dist-tags; registries that don't support it fall back to JSON.
const PACKUMENT_ACCEPT =
	"application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

const DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
] as const;

export const npmHandler: RegistryHandler = {
	matches(uri: string): boolean {
		return uri.endsWith("package.json");
	},

	extractPackages(text: string, lines: string[]): PackageInfo[] {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text);
		} catch {
			return [];
		}

		const packages: PackageInfo[] = [];

		for (const section of DEP_SECTIONS) {
			const deps = parsed[section] as Record<string, string> | undefined;
			if (!deps) continue;

			for (const [name, currentRange] of Object.entries(deps)) {
				const lineIndex = findPackageLine(lines, name);
				if (lineIndex === -1) continue;

				const currentVersion = String(currentRange).replace(/[\^~>=<]/g, "");
				packages.push({ name, currentVersion, lineIndex });
			}
		}

		return packages;
	},

	clearCache(): void {
		cache.clear();
		pending.clear();
		noDistTags.clear();
		// Pick up edits to ~/.npmrc on save and on the periodic refresh.
		reloadNpmrc();
	},

	async fetchLatestVersion(name: string): Promise<string> {
		const cached = cache.get(name);
		if (cached) return cached;

		// Concurrent inlay-hint requests share one lookup per package.
		let lookup = pending.get(name);
		if (!lookup) {
			const current = lookupLatest(name).finally(() => {
				if (pending.get(name) === current) pending.delete(name);
			});
			lookup = current;
			pending.set(name, lookup);
		}
		return lookup;
	},
};

async function lookupLatest(name: string): Promise<string> {
	const registry = registryFor(name);
	const escaped = escapeName(name);
	try {
		// The dist-tags document is a few bytes, while packuments of popular
		// packages are megabytes. Registries without that endpoint (and
		// without "/latest", e.g. Artifactory or GitHub Packages) get the packument.
		let distTagsStatus: number | undefined;
		if (!noDistTags.has(registry)) {
			const res = await get(`${registry}-/package/${escaped}/dist-tags`);
			const latest = (res.body as { latest?: unknown } | undefined)?.latest;
			if (res.status >= 200 && res.status < 300 && typeof latest === "string") {
				cache.set(name, latest);
				return latest;
			}
			distTagsStatus = res.status;
		}

		const res = await get(`${registry}${escaped}`, PACKUMENT_ACCEPT);
		if (res.status < 200 || res.status >= 300) {
			log(`npm fetch failed for ${name} (${hostOf(registry)}): ${res.status}`);
			return "?";
		}
		// The package exists, so the registry lacks the dist-tags endpoint.
		if (distTagsStatus === 404) noDistTags.add(registry);

		const data = res.body as {
			"dist-tags"?: { latest?: string };
		};
		const latest = data["dist-tags"]?.latest;
		if (!latest) {
			log(`npm: no latest dist-tag for ${name} (${hostOf(registry)})`);
			return "?";
		}
		cache.set(name, latest);
		return latest;
	} catch (e) {
		log(`npm fetch error for ${name} (${hostOf(registry)}): ${e}`);
		return "?";
	}
}

function get(url: string, accept = "application/json") {
	// Auth is resolved per URL so it follows redirects (e.g. http → https)
	// only to hosts that have credentials configured in ~/.npmrc.
	return getJson(url, {
		headers: { Accept: accept },
		authFor: authHeaderFor,
		agent: httpsAgent(),
	});
}

/** "@scope/name" → "@scope%2fname", like the npm CLI; everything else is fully encoded. */
function escapeName(name: string): string {
	return encodeURIComponent(name).replace(/^%40/, "@").replace(/%2F/g, "%2f");
}

function findPackageLine(lines: string[], pkgName: string): number {
	const pattern = new RegExp(
		`"${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`,
	);
	return lines.findIndex((line) => pattern.test(line));
}
