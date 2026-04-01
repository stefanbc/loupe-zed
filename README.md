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

Contributions are welcome. If you'd like to add support for another ecosystem, the pattern is straightforward — each file type needs a parser and a registry fetch function in `lsp/src/server.ts`. See the existing handler for reference.

```bash
git clone https://github.com/stefanbc/loupe-zed
cd loupe-zed/lsp
npm install
npm run watch
```

Then load the extension as a dev extension in Zed via Extensions → Install Dev Extension.

## License

MIT