const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
	version: string;
	fetchedAt: number;
}

export class VersionCache {
	private readonly cache = new Map<string, CacheEntry>();

	get(key: string): string | null {
		const entry = this.cache.get(key);
		if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
			return entry.version;
		}
		return null;
	}

	set(key: string, version: string): void {
		this.cache.set(key, { version, fetchedAt: Date.now() });
	}
}
