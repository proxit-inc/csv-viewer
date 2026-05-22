# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

macOS desktop app for viewing large CSV files (100k rows) across multiple tabs. Read-only viewer in Phase 1; sort/filter in Phase 2. Built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend).

## Commands

### Development & Build

```bash
pnpm tauri dev                                              # dev server with HMR
pnpm tauri build -- --target aarch64-apple-darwin          # Apple Silicon (local dev)
pnpm tauri build -- --target x86_64-apple-darwin           # Intel only
# Universal Binary (arm64 + x86_64) cannot be built locally via CLI due to a Tauri limitation.
# Push a version tag (e.g. v0.1.0) to trigger the release CI, which uses tauri-action to produce the Universal Binary.
```

### Lint & Format

```bash
pnpm lint           # oxlint (JS/TS linter)
pnpm lint:fix       # oxlint --fix
pnpm fmt            # oxfmt (JS/TS formatter)
pnpm fmt:check      # oxfmt --check
cargo fmt           # Rust formatter
cargo clippy        # Rust linter
```

### Testing

```bash
cargo test                   # Rust unit tests (encoding, delimiter detection, queries)
python generate_test_data.py # generate test-data/ CSV fixtures (100k rows UTF-8, Shift_JIS, TSV)
```

## Architecture

### System Boundary

Frontend (React/TS) ↔ Tauri IPC ↔ Backend (Rust/DuckDB)

All data processing happens in Rust. The frontend never reads files directly — it calls `invoke()` and receives typed responses.

### Backend State Model

Each tab owns an independent DuckDB in-memory connection (`HashMap<tab_id, Connection>` in `src-tauri/src/state.rs`). When a tab closes, its connection is dropped and memory is freed.

### IPC Commands (`src-tauri/src/commands/`)

| Command | Purpose |
|---|---|
| `open_csv_file(path, tab_id)` | Detect encoding/delimiter → load into DuckDB → return `FileMetadata` |
| `get_csv_data_range(tab_id, start_row, end_row)` | `SELECT * FROM csv_data LIMIT n OFFSET m` → return `DataRange` |
| `search_csv(tab_id, query)` | Full-table text search → return `SearchResponse` with hit rows |
| `close_tab(tab_id)` | Drop DuckDB connection, free memory |

### Virtual Scrolling

AG-Grid Infinite Row Model drives all data fetching. `src/components/DataGrid/datasource.ts` implements `IDataSource`, calling `get_csv_data_range` on each scroll event. The frontend never holds the full dataset.

### Frontend State

`src/store/appReducer.ts` uses `useReducer` (Redux-like) for global state. Each hook (`useTabManager`, `useFileOpen`, `useSearch`, `useKeyboardShortcuts`) dispatches actions — no prop drilling.

### Frontend Directory Layout

```
src/
├── App.tsx                        # root, global state wiring
├── components/
│   ├── TitleBar.tsx               # macOS traffic lights
│   ├── Toolbar.tsx
│   ├── TabBar/{TabBar,Tab}.tsx
│   ├── FileInfoBar.tsx
│   ├── SearchBar.tsx              # shown only when ⌘F active
│   ├── DataGrid/{DataGrid,datasource}.ts
│   ├── EmptyState.tsx
│   └── StatusBar.tsx
├── hooks/{useFileOpen,useTabManager,useSearch,useKeyboardShortcuts}.ts
├── store/appReducer.ts
└── types/index.ts
```

### Backend Directory Layout

```
src-tauri/src/
├── main.rs / lib.rs
├── state.rs         # DuckDB connection map (Mutex-wrapped)
├── types.rs         # FileMetadata, DataRange, SearchHit, etc.
├── commands/{mod,file,data,search}.rs
└── csv/{mod,encoding,delimiter}.rs
```

## Key Technical Decisions

- **DuckDB `read_csv_auto`** is used for initial load — it handles delimiter inference natively. The Rust `csv` crate and `chardetng`/`encoding_rs` handle encoding detection *before* passing to DuckDB.
- **Reference implementation**: [Duckling](https://github.com/l1xnan/duckling) is the primary reference for Tauri + DuckDB IPC patterns. Strip out Parquet, DB connections, SQL console, and schema browser — keep DuckDB connection management, `read_csv_auto` usage, encoding detection, and the AG-Grid datasource pattern.
- **Phase 2 hooks**: Sort/filter UI buttons are rendered but `disabled` in Phase 1. The DuckDB columnar store makes adding `ORDER BY` / `WHERE` to `get_csv_data_range` straightforward later.
- **Tauri v2 import paths**: `invoke` is from `@tauri-apps/api/core`, `open` dialog is from `@tauri-apps/plugin-dialog` (different from v1).
- **`DataGrid` key prop**: `key={activeTab.id}` forces AG-Grid instance recreation on tab switch.
- **`get_csv_data_range` is sync**: DuckDB `Connection` is not `Send`, so avoid `async`.

## Performance Targets

| Metric | Target |
|---|---|
| File load (100k rows) | < 3 s |
| Initial render | < 1 s |
| Scroll FPS | 60 fps |
| Memory (100k rows) | < 200 MB |
| App startup | < 2 s |

macOS 11 (Big Sur)+, Universal Binary (x86_64 + arm64), no network calls.
