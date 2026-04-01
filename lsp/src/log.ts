export function log(msg: string): void {
	process.stderr.write(`[loupe] ${msg}\n`);
}
