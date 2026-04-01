import { VersionCache } from "../cache";
import { log } from "../log";
import type { PackageInfo, RegistryHandler } from "../types";

const cache = new VersionCache();

// Platform requirements that are not real Packagist packages
const PLATFORM_REQUIREMENT = /^(php$|php-|hhvm|ext-|lib-)/;

const DEP_SECTIONS = ["require", "require-dev"] as const;

export const packagistHandler: RegistryHandler = {
	matches(uri: string): boolean {
		return uri.endsWith("composer.json");
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
				if (PLATFORM_REQUIREMENT.test(name)) continue;

				const lineIndex = findPackageLine(lines, name);
				if (lineIndex === -1) continue;

				// Strip leading constraint characters to get a comparable version
				const currentVersion =
					String(currentRange).replace(/^[^\d]*/, "") || "*";
				packages.push({ name, currentVersion, lineIndex });
			}
		}

		return packages;
	},

	async fetchLatestVersion(name: string): Promise<string> {
		const cached = cache.get(name);
		if (cached) return cached;

		try {
			const res = await fetch(`https://repo.packagist.org/p2/${name}.json`);
			if (!res.ok) {
				log(`packagist fetch failed for ${name}: ${res.status}`);
				return "?";
			}

			const data = (await res.json()) as {
				packages: Record<string, Array<{ version: string }>>;
			};

			const versions = data.packages[name];
			if (!versions || versions.length === 0) {
				log(`packagist: no versions found for ${name}`);
				return "?";
			}

			// Versions are sorted newest-first; skip dev branches
			const stable = versions.find((v) => !v.version.startsWith("dev-"));
			const version = (stable ?? versions[0]).version;

			// Strip leading 'v' if present
			const cleaned = version.replace(/^v/, "");
			cache.set(name, cleaned);
			return cleaned;
		} catch (e) {
			log(`packagist fetch error for ${name}: ${e}`);
			return "?";
		}
	},
};

function findPackageLine(lines: string[], pkgName: string): number {
	const pattern = new RegExp(
		`"${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`,
	);
	return lines.findIndex((line) => pattern.test(line));
}
