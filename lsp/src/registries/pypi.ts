import { parse } from "smol-toml";
import { VersionCache } from "../cache";
import { log } from "../log";
import type { PackageInfo, RegistryHandler } from "../types";

const cache = new VersionCache();

// Packages that are not real PyPI packages
const SKIP_NAMES = new Set(["python", "python3"]);

export const pypiHandler: RegistryHandler = {
	matches(uri: string): boolean {
		return uri.endsWith("pyproject.toml");
	},

	extractPackages(text: string, lines: string[]): PackageInfo[] {
		let parsed: Record<string, unknown>;
		try {
			parsed = parse(text);
		} catch {
			return [];
		}

		const packages: PackageInfo[] = [];
		const seen = new Set<number>();

		function addPackage(info: PackageInfo) {
			if (!seen.has(info.lineIndex)) {
				seen.add(info.lineIndex);
				packages.push(info);
			}
		}

		// ── PEP 621: [project].dependencies ────────────────────────────────────
		const project = parsed.project as Record<string, unknown> | undefined;
		if (Array.isArray(project?.dependencies)) {
			for (const dep of project.dependencies as unknown[]) {
				if (typeof dep !== "string") continue;
				const name = parsePep508Name(dep);
				if (!name || SKIP_NAMES.has(name.toLowerCase())) continue;
				const lineIndex = findPep508Line(lines, name);
				if (lineIndex === -1) continue;
				const currentVersion = parsePep508Version(dep);
				addPackage({ name: normalizeName(name), currentVersion, lineIndex });
			}
		}

		// ── PEP 621: [project.optional-dependencies].* ─────────────────────────
		const optDeps = project?.["optional-dependencies"] as
			| Record<string, unknown[]>
			| undefined;
		if (optDeps && typeof optDeps === "object") {
			for (const group of Object.values(optDeps)) {
				if (!Array.isArray(group)) continue;
				for (const dep of group) {
					if (typeof dep !== "string") continue;
					const name = parsePep508Name(dep);
					if (!name || SKIP_NAMES.has(name.toLowerCase())) continue;
					const lineIndex = findPep508Line(lines, name);
					if (lineIndex === -1) continue;
					const currentVersion = parsePep508Version(dep);
					addPackage({
						name: normalizeName(name),
						currentVersion,
						lineIndex,
					});
				}
			}
		}

		// ── Poetry: [tool.poetry.dependencies] / [tool.poetry.dev-dependencies] ─
		const tool = parsed.tool as Record<string, unknown> | undefined;
		const poetry = tool?.poetry as Record<string, unknown> | undefined;
		if (poetry) {
			for (const section of ["dependencies", "dev-dependencies"] as const) {
				const deps = poetry[section] as Record<string, unknown> | undefined;
				if (!deps || typeof deps !== "object") continue;
				for (const [name, value] of Object.entries(deps)) {
					if (SKIP_NAMES.has(name.toLowerCase())) continue;
					const currentVersion = extractPoetryVersion(value);
					const lineIndex = findPoetryLine(lines, name);
					if (lineIndex === -1) continue;
					addPackage({
						name: normalizeName(name),
						currentVersion,
						lineIndex,
					});
				}
			}

			// ── Poetry groups: [tool.poetry.group.*.dependencies] ────────────────
			const groups = poetry.group as Record<string, unknown> | undefined;
			if (groups && typeof groups === "object") {
				for (const groupData of Object.values(groups)) {
					const deps = (groupData as Record<string, unknown>)?.dependencies as
						| Record<string, unknown>
						| undefined;
					if (!deps || typeof deps !== "object") continue;
					for (const [name, value] of Object.entries(deps)) {
						if (SKIP_NAMES.has(name.toLowerCase())) continue;
						const currentVersion = extractPoetryVersion(value);
						const lineIndex = findPoetryLine(lines, name);
						if (lineIndex === -1) continue;
						addPackage({
							name: normalizeName(name),
							currentVersion,
							lineIndex,
						});
					}
				}
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
				`https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
			);
			if (!res.ok) {
				log(`pypi fetch failed for ${name}: ${res.status}`);
				return "?";
			}
			const data = (await res.json()) as { info: { version: string } };
			const version = data.info.version;
			cache.set(name, version);
			return version;
		} catch (e) {
			log(`pypi fetch error for ${name}: ${e}`);
			return "?";
		}
	},
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a PyPI package name to its canonical form:
 * lowercase, runs of [-_.] collapsed to a single hyphen.
 */
function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Extract the distribution name from a PEP 508 dependency specifier.
 * e.g. "requests[security]>=2.28.0" → "requests"
 */
function parsePep508Name(dep: string): string | null {
	const match = dep
		.trim()
		.match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/);
	return match ? match[1] : null;
}

/**
 * Extract a bare version number from a PEP 508 dependency specifier.
 * Takes the version number from the first version clause found.
 * e.g. "requests>=2.28.0"  → "2.28.0"
 *      "flask~=2.3.1"      → "2.3.1"
 *      "django>=4.0,<5.0"  → "4.0"
 *      "requests"          → ""
 */
function parsePep508Version(dep: string): string {
	const match = dep.match(/[><=!~]{1,2}(\d[\d.]*)/);
	return match ? match[1] : "";
}

/**
 * Extract a bare version number from a Poetry dependency value.
 * Handles strings ("^2.28", "~=1.0", "*") and inline tables
 * ({ version = "^2.28", extras = ["security"] }).
 */
function extractPoetryVersion(value: unknown): string {
	if (typeof value === "string") {
		return value.replace(/^[^0-9*]*/, "") || "*";
	}
	if (value !== null && typeof value === "object" && "version" in value) {
		return extractPoetryVersion((value as Record<string, unknown>).version);
	}
	return "*";
}

/**
 * Find the line index of a PEP 508 dependency entry.
 * Matches lines that contain the package name inside quotes, e.g.:
 *   "requests>=2.28.0",
 *   'flask~=2.3',
 */
function findPep508Line(lines: string[], pkgName: string): number {
	// Escape the name for regex; also allow PEP 503 normalisation ([-_.])
	const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const normalized = escaped.replace(/[-_.]/g, "[-_.]");
	const pattern = new RegExp(
		`["']${normalized}\\s*(?:[\\[><=!~;@\\s,]|["'])`,
		"i",
	);
	return lines.findIndex((line) => pattern.test(line));
}

/**
 * Find the line index of a Poetry-style key = value dependency entry.
 * Matches lines like:
 *   requests = "^2.28"
 *   "my-pkg" = { version = "^1.0" }
 */
function findPoetryLine(lines: string[], pkgName: string): number {
	const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const normalized = escaped.replace(/[-_.]/g, "[-_.]");
	const pattern = new RegExp(`^\\s*["']?${normalized}["']?\\s*=`, "i");
	return lines.findIndex((line) => pattern.test(line));
}
