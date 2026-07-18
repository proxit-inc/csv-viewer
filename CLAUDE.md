# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

macOS desktop app for viewing large CSV files (100k rows) across multiple tabs. Read-only viewer in Phase 1; sort/filter in Phase 2. Built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend).

## Commands

### Development & Build

```bash
pnpm tauri dev                                              # dev server with HMR
pnpm tauri build                                            # native arch (Apple Silicon or Intel)
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
cargo test                   # Rust unit tests (encoding, delimiter detection, IPC commands, queries)
pnpm test                    # frontend unit tests (vitest: appReducer, hooks)
python generate_test_data.py # generate test-data/ CSV fixtures (100k rows UTF-8, Shift_JIS, TSV)
```

## Architecture

### System Boundary

Frontend (React/TS) ↔ Tauri IPC ↔ Backend (Rust/DuckDB)

All data processing happens in Rust. The frontend never reads files directly — it calls `invoke()` and receives typed responses.

### Backend State Model

Each tab owns an independent DuckDB in-memory connection, held as `Mutex<HashMap<String, Arc<Mutex<Connection>>>>` in `src-tauri/src/state.rs` (keyed by `tab_id`; each connection is individually `Arc<Mutex<_>>`-wrapped so a command can clone the handle and drop the outer map lock before running its query). When a tab closes, its entry is removed, the connection is dropped, and memory is freed.

### IPC Commands (`src-tauri/src/commands/`)

| Command | Purpose |
|---|---|
| `open_csv_file(path, tab_id)` | Detect encoding/delimiter → load into DuckDB → return `FileMetadata` |
| `get_csv_data_range(tab_id, start_row, end_row)` | `SELECT * EXCLUDE (__row_id) FROM csv_data ORDER BY __row_id LIMIT n OFFSET m` → return `DataRange` |
| `search_csv(tab_id, query)` | Full-table text search → return `SearchResponse` with hit rows |
| `close_tab(tab_id)` | Drop DuckDB connection, free memory |

### Virtual Scrolling

AG-Grid Infinite Row Model drives all data fetching. `src/components/DataGrid/datasource.ts` implements `IDataSource`, calling `get_csv_data_range` on each scroll event. The frontend never holds the full dataset.

### Frontend State

`src/store/appReducer.ts` uses `useReducer` (Redux-like) for global state (`tabs`, `activeTabId`, `isSearchOpen`, `errorMessage`). Tab lifecycle logic lives in the reducer itself (`TAB_ADD`/`TAB_CLOSE`/`TAB_SWITCH`) wired up in `App.tsx` — there is no `useTabManager` hook. The hooks (`useFileOpen`, `useSearch`, `useKeyboardShortcuts`, `useDebounce`) dispatch actions — no prop drilling. Backend command failures surface via the `SET_ERROR`/`CLEAR_ERROR` actions that set `state.errorMessage`.

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
│   ├── DataGrid/{DataGrid.tsx,datasource.ts}
│   ├── EmptyState.tsx
│   ├── LoadingState.tsx           # shown while a tab's file loads
│   ├── ErrorBoundary.tsx          # catches render errors
│   └── StatusBar.tsx
├── hooks/{useFileOpen,useSearch,useKeyboardShortcuts,useDebounce}.ts
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

- **DuckDB `read_csv_auto`** (from the `duckdb` crate, pinned to 1.x with the `bundled` feature) is used for initial load. Encoding is detected *before* passing to DuckDB — `chardetng`/`encoding_rs` in `csv/encoding.rs` — and the delimiter is chosen by a hand-rolled `detect_delimiter` in `csv/delimiter.rs` (there is no `csv` crate dependency). At load time a `__row_id` ordinal column is materialized so `get_csv_data_range` and `search_csv` share a stable row identity to `ORDER BY`.
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
