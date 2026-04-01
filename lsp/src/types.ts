export interface PackageInfo {
	name: string;
	currentVersion: string;
	lineIndex: number;
}

export interface RegistryHandler {
	/** Returns true if this handler should process the given file URI. */
	matches(uri: string): boolean;

	/** Extracts all dependency entries from the document text. */
	extractPackages(text: string, lines: string[]): PackageInfo[];

	/** Fetches the latest published version of the given package. */
	fetchLatestVersion(name: string): Promise<string>;

	/** Clears the internal version cache, forcing fresh fetches on the next request. */
	clearCache?(): void;
}
