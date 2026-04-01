# Loupe

A Zed extension that shows the latest available version of your npm dependencies inline, as inlay hints.

## What it looks like

Each dependency gets an inlay hint at the end of its line:

```json
"dependencies": {
  "vscode-languageserver": "^9.0.1",              ✓ 9.0.1
  "vscode-languageserver-textdocument": "^1.0.11", ⬆ 1.0.12 available
  "typescript": "^5.4.0",                          ⬆ 6.0.2 available
}
```

## Supported ecosystems

| File | Registry |
|---|---|
| `package.json` | npm |

## Installation

Open the Extensions panel in Zed (`cmd+shift+x`), search for **Loupe**, and click Install.

## Setup

Inlay hints are disabled in Zed by default. Enable them in your Zed settings (`cmd+,`):

```json
{
  "inlay_hints": {
    "enabled": true
  }
}
```

Or to limit it to JSON files only:

```json
{
  "languages": {
    "JSON": {
      "inlay_hints": {
        "enabled": true
      }
    }
  }
}
```

## Requirements

- Zed 0.205 or later
- An internet connection for registry lookups (results are cached for 5 minutes)

## Contributing

Contributions are welcome. The LSP server is modular — each package registry is a self-contained handler.

### Adding a new registry

The source is structured as follows:

```
lsp/src/
  server.ts          ← LSP wiring, never needs to change
  types.ts           ← RegistryHandler interface + PackageInfo type
  cache.ts           ← reusable TTL version cache
  log.ts             ← shared logger
  registries/
    index.ts         ← list of active handlers (add yours here)
    npm.ts           ← npm / package.json handler (use as reference)
```

To add support for a new registry:

1. Create `lsp/src/registries/<name>.ts` and implement the `RegistryHandler` interface:

```ts
import type { PackageInfo, RegistryHandler } from "../types";

export const myHandler: RegistryHandler = {
  matches(uri: string): boolean {
    // return true for the file(s) this handler covers
  },

  extractPackages(text: string, lines: string[]): PackageInfo[] {
    // parse the file and return a PackageInfo for each dependency
  },

  async fetchLatestVersion(name: string): Promise<string> {
    // fetch from your registry and return the latest version string
  },
};
```

2. Register it in `lsp/src/registries/index.ts`:

```ts
import { myHandler } from "./my-registry";

export const registries: RegistryHandler[] = [
  npmHandler,
  myHandler, // add here
];
```

That's it — `server.ts` requires no changes.

### Dev setup

```bash
git clone https://github.com/stefanbc/loupe-zed
cd loupe-zed/lsp
npm install
npm run watch
```

Then load the extension as a dev extension in Zed via Extensions → Install Dev Extension.

## License

MIT