import {
	createConnection,
	type InitializeParams,
	type InitializeResult,
	type InlayHint,
	type InlayHintParams,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { log } from "./log";
import { registries } from "./registries/index";

const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let clientSupportsRefresh = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
	log("onInitialize");

	clientSupportsRefresh =
		params.capabilities.workspace?.inlayHint?.refreshSupport === true;

	log(`clientSupportsRefresh: ${clientSupportsRefresh}`);

	return {
		capabilities: {
			// Object form is required so the client sends save notifications.
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Incremental,
				save: { includeText: false },
			},
			inlayHintProvider: { resolveProvider: false },
		},
	};
});

connection.onInitialized(() => {
	log("onInitialized — starting auto-refresh timer");

	const timer = setInterval(() => {
		const hasHandledDoc = [...documents.all()].some((doc) =>
			registries.some((r) => r.matches(doc.uri)),
		);

		if (!hasHandledDoc) return;

		log("auto-refresh: clearing caches and requesting inlay hint refresh");
		clearAllCaches();
		sendRefresh();
	}, AUTO_REFRESH_INTERVAL_MS);

	// Don't let the timer prevent a clean process exit.
	timer.unref();
});

// On save: clear only the relevant registry's cache so the very next
// inlay-hint request fetches fresh versions from the registry API.
documents.onDidSave((event) => {
	const uri = event.document.uri;
	const handler = registries.find((r) => r.matches(uri));
	if (!handler) return;

	log(`save detected on handled file: ${uri} — clearing cache`);
	handler.clearCache?.();
	sendRefresh();
});

connection.languages.inlayHint.on(
	async (params: InlayHintParams): Promise<InlayHint[]> => {
		const uri = params.textDocument.uri;
		log(`onInlayHint: ${uri}`);

		const handler = registries.find((r) => r.matches(uri));
		if (!handler) {
			log("no handler for this file");
			return [];
		}

		const document = documents.get(uri);
		if (!document) {
			log("document not found in manager");
			return [];
		}

		const text = document.getText();
		const lines = text.split("\n");
		const packages = handler.extractPackages(text, lines);

		log(`fetching ${packages.length} package versions in parallel`);

		const hints = await Promise.all(
			packages.map(
				async ({ name, currentVersion, lineIndex }): Promise<InlayHint> => {
					const latestVersion = await handler.fetchLatestVersion(name);
					const isOutdated = latestVersion !== currentVersion;

					log(
						`${name}: current=${currentVersion}, latest=${latestVersion}, outdated=${isOutdated}`,
					);

					return {
						position: { line: lineIndex, character: lines[lineIndex].length },
						label: isOutdated
							? `⬆ ${latestVersion} available`
							: `✓ ${latestVersion}`,
						paddingLeft: true,
					};
				},
			),
		);

		log(`returning ${hints.length} hints`);
		return hints;
	},
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function clearAllCaches(): void {
	for (const r of registries) {
		r.clearCache?.();
	}
}

function sendRefresh(): void {
	if (!clientSupportsRefresh) {
		log("client does not support inlayHint refresh — skipping");
		return;
	}

	connection.languages.inlayHint.refresh().catch((e: unknown) => {
		log(`inlayHint refresh error: ${e}`);
	});
}

documents.listen(connection);
connection.listen();
