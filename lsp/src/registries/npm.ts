import { VersionCache } from "../cache";
import { log } from "../log";
import type { PackageInfo, RegistryHandler } from "../types";

const cache = new VersionCache();

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
	},

	async fetchLatestVersion(name: string): Promise<string> {
		const cached = cache.get(name);
		if (cached) return cached;

		try {
			const res = await fetch(
				`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
			);
			if (!res.ok) {
				log(`npm fetch failed for ${name}: ${res.status}`);
				return "?";
			}
			const data = (await res.json()) as { version: string };
			cache.set(name, data.version);
			return data.version;
		} catch (e) {
			log(`npm fetch error for ${name}: ${e}`);
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
