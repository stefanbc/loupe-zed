import {
	createConnection,
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

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize((): InitializeResult => {
	log("onInitialize");
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			inlayHintProvider: true,
		},
	};
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

documents.listen(connection);
connection.listen();
