# Loupe

A Zed extension that shows the latest available version of your dependencies inline, as inlay hints. Supports multiple package registries across ecosystems.

## What it looks like

Each dependency gets an inlay hint at the end of its line showing whether it's up to date or a newer version is available.

**package.json** (npm):

```json
"dependencies": {
  "vscode-languageserver": "^9.0.1",              ✓ 9.0.1
  "vscode-languageserver-textdocument": "^1.0.11", ⬆ 1.0.12 available
  "typescript": "^5.4.0",                          ⬆ 6.0.2 available
}
```

**composer.json** (Packagist):

```json
"require": {
  "php": "^8.2",
  "laravel/framework": "^11.0",  ✓ 11.0.0
  "league/flysystem": "^3.0",    ⬆ 3.29.0 available
}
```

**pyproject.toml** — PEP 621 (PyPI):

```toml
[project]
dependencies = [
  "requests>=2.28.0",   ⬆ 2.32.3 available
  "flask>=3.0",         ✓ 3.0.3
  "click>=8.1",         ✓ 8.1.7
]
```

**pyproject.toml** — Poetry (PyPI):

```toml
[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.28"  ⬆ 2.32.3 available
flask = "^3.0"      ✓ 3.0.3
```

## Supported ecosystems

| File             | Registry  | Sections scanned                                                                                                                                                    |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`   | npm       | `dependencies`, `devDependencies`, `peerDependencies`                                                                                                               |
| `composer.json`  | Packagist | `require`, `require-dev`                                                                                                                                            |
| `pyproject.toml` | PyPI      | `[project].dependencies`, `[project.optional-dependencies].*`, `[tool.poetry.dependencies]`, `[tool.poetry.dev-dependencies]`, `[tool.poetry.group.*.dependencies]` |

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

Or to limit it to specific file types only:

```json
{
  "languages": {
    "JSON": {
      "inlay_hints": {
        "enabled": true
      }
    },
    "TOML": {
      "inlay_hints": {
        "enabled": true
      }
    }
  }
}
```

## Refreshing hints

Version hints are cached for 5 minutes and automatically refreshed every hour while the extension is running. To force an immediate refresh, simply **save the file** — Loupe detects the save, clears the cache for that file's registry, and fetches the latest versions straight away.

## Custom npm registries

For `package.json` files, Loupe respects your **`~/.npmrc`**, so private or company registries (Verdaccio, Nexus, Artifactory, GitHub Packages, …) work out of the box. The following settings are supported:

- `registry`: the default registry (falls back to `https://registry.npmjs.org/`)
- `@scope:registry`: a registry for a specific scope
- `//host/path/:_authToken`: a bearer token for a registry
- `//host/path/:_auth`, or `username` + `_password`: basic auth for a registry
- `cafile`: a PEM file with one or more additional CA certificates, e.g. for a company root CA
- `ca` / `ca[]`: inline PEM certificates (with `\n` line breaks)
- `strict-ssl=false`: disables certificate verification for all npm lookups (not recommended)
- `${ENV_VAR}` placeholders in values, so you don't have to store tokens in the file

```ini
@mycompany:registry=https://npm.mycompany.com/
//npm.mycompany.com/:_authToken=${NPM_TOKEN}
cafile=/Users/me/.certs/CompanyRoot.pem
```

Certificates from `cafile` and `ca` are trusted **in addition to** the built-in root certificates, so the public npm registry keeps working. Redirects (e.g. from `http://` to `https://`) are followed, and credentials are only sent to hosts that have them configured.

Changes to `~/.npmrc` are picked up the next time you save a `package.json` or on the hourly refresh.

> **Note:** Only the `.npmrc` in your home directory is read for now. Project-level `.npmrc` files, `NPM_CONFIG_*` environment variables, client certificates (`certfile` / `keyfile`) and proxies (`proxy` / `https-proxy`) are not supported yet.

## Requirements

- Zed 0.205 or later
- Network access to the configured registries (results are cached for 5 minutes)

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
    packagist.ts     ← Packagist / composer.json handler
    pypi.ts          ← PyPI / pyproject.toml handler
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

  clearCache(): void {
    // clear the internal version cache (called on manual/auto refresh)
  },
};
```

2. Register it in `lsp/src/registries/index.ts`:

```ts
import { myHandler } from "./my-registry";

export const registries: RegistryHandler[] = [
  npmHandler,
  packagistHandler,
  pypiHandler,
  myHandler, // add here
];
```

3. Add the language name to `extension.toml` if it isn't already listed:

```toml
[language_servers.loupe-lsp]
name = "Loupe LSP"
languages = ["JSON", "TOML", "MyLanguage"]
```

4. Add tests in `lsp/src/registries/my-registry.test.ts`, next to the handler (see `npmrc.test.ts` and `npm.test.ts` for examples).

That's it — `server.ts` requires no changes.

### Dev setup

```bash
git clone https://github.com/stefanbc/loupe-zed
cd loupe-zed/lsp
npm install
npm run watch
```

Run the tests (type check plus [`node:test`](https://nodejs.org/api/test.html)) with:

```bash
npm test
```

Tests live next to the code as `*.test.ts` and are excluded from the build via `tsconfig.build.json`. The TLS tests generate a throwaway CA at runtime and need `openssl` on your `PATH`; they are skipped without it. No test talks to the internet.

Then load the extension as a dev extension in Zed via Extensions → Install Dev Extension.

## License

MIT
