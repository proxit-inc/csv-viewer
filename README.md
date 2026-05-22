# CSV Viewer

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](https://github.com/proxit-inc/csv-viewer/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey)](https://github.com/proxit-inc/csv-viewer/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A fast, local CSV file viewer for macOS. View large files (100k+ rows) across multiple tabs with instant search — no data ever leaves your machine.

Built with **Tauri 2** + **React 18** + **TypeScript** + **DuckDB**.

---

## Features

- **Multi-tab viewing** — open multiple CSV/TSV files simultaneously, each with its own independent in-memory DuckDB connection
- **Large file support** — 100,000 rows load in under 3 seconds; virtual scrolling keeps memory under 200 MB
- **Auto-detection** — delimiter (`,` / `\t` / `;`) and encoding (UTF-8, Shift_JIS, EUC-JP) detected automatically
- **Full-text search** — `⌘F` opens an inline search bar with result count and keyboard navigation
- **Column resizing** — drag headers to resize, double-click to auto-fit
- **Offline & private** — no network calls, no telemetry, no cloud

---

## Requirements

- macOS 11 (Big Sur) or later
- Intel or Apple Silicon (Universal Binary)

---

## Download

Download the latest `.dmg` from the [Releases](https://github.com/proxit-inc/csv-viewer/releases) page.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘O` | Open file |
| `⌘F` | Open / focus search bar |
| `ESC` | Close search bar |
| `Enter` | Next search result |
| `Shift+Enter` | Previous search result |
| `⌘W` | Close active tab |
| `⌘1`–`⌘9` | Switch to tab N |
| `⌘Q` | Quit |

---

## Build from Source

**Prerequisites**

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 8+

```bash
git clone https://github.com/proxit-inc/csv-viewer.git
cd csv-viewer
pnpm install
pnpm tauri build -- --target universal-apple-darwin
```

The `.dmg` will be output to `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`.

---

## Development

```bash
pnpm tauri dev          # dev server with hot-module reload

pnpm lint               # JS/TS linter (oxlint)
pnpm lint:fix           # auto-fix lint issues
pnpm fmt                # formatter (oxfmt)
cargo fmt               # Rust formatter
cargo clippy            # Rust linter
cargo test              # Rust unit tests
```

For architecture details see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).  
For the full Japanese implementation specification see [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

---

## License

[MIT](LICENSE) © PROXIT, Inc.
