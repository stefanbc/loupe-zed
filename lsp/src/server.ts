import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  type InitializeResult,
  TextDocumentSyncKind,
  type InlayHint,
  type InlayHintParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const versionCache = new Map<string, { version: string; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function log(msg: string) {
  process.stderr.write(`[loupe] ${msg}\n`);
}

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

    if (!uri.endsWith("package.json")) {
      log("not a package.json, skipping");
      return [];
    }

    const document = documents.get(uri);
    if (!document) {
      log("document not found in manager");
      return [];
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(document.getText());
    } catch (e) {
      log(`JSON parse error: ${e}`);
      return [];
    }

    const depSections = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ] as const;

    const lines = document.getText().split("\n");

    type HintJob = {
      lineIndex: number;
      pkgName: string;
      currentClean: string;
    };

    const jobs: HintJob[] = [];

    for (const section of depSections) {
      const deps = parsed[section] as Record<string, string> | undefined;
      if (!deps) continue;

      for (const [pkgName, currentRange] of Object.entries(deps)) {
        const lineIndex = findPackageLine(lines, pkgName);
        if (lineIndex === -1) continue;

        const currentClean = String(currentRange).replace(/[\^~>=<]/g, "");
        jobs.push({ lineIndex, pkgName, currentClean });
      }
    }

    log(`fetching ${jobs.length} package versions in parallel`);

    const hints = await Promise.all(
      jobs.map(async ({ lineIndex, pkgName, currentClean }): Promise<InlayHint> => {
        const latestVersion = await fetchLatestNpmVersion(pkgName);
        const isOutdated = latestVersion !== currentClean;

        log(
          `${pkgName}: current=${currentClean}, latest=${latestVersion}, outdated=${isOutdated}`
        );

        // Place the hint at the end of the line (after trailing comma/quote)
        const character = lines[lineIndex].length;

        return {
          position: { line: lineIndex, character },
          label: isOutdated
            ? `⬆ ${latestVersion} available`
            : `✓ ${latestVersion}`,
          paddingLeft: true,
        };
      })
    );

    log(`returning ${hints.length} hints`);
    return hints;
  }
);

function findPackageLine(lines: string[], pkgName: string): number {
  const pattern = new RegExp(
    `"${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`
  );
  return lines.findIndex((line) => pattern.test(line));
}

async function fetchLatestNpmVersion(pkgName: string): Promise<string> {
  const cached = versionCache.get(pkgName);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.version;
  }
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`
    );
    if (!res.ok) {
      log(`npm fetch failed for ${pkgName}: ${res.status}`);
      return "?";
    }
    const data = (await res.json()) as { version: string };
    versionCache.set(pkgName, { version: data.version, fetchedAt: Date.now() });
    return data.version;
  } catch (e) {
    log(`npm fetch error for ${pkgName}: ${e}`);
    return "?";
  }
}

documents.listen(connection);
connection.listen();