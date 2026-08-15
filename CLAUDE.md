# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

macOS desktop app for viewing large CSV files (100k rows) across multiple tabs. Read-only: viewing, text search, column sort, and `where`/`sql` querying — nothing ever writes back to the file. Built with Tauri 2 (Rust backend) + React 18 (TypeScript frontend).

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
cargo test -- --ignored      # opt-in timing checks: the 100k-row load budget + search micro-benches
```

Timing-sensitive tests are `#[ignore]`d so a noisy CI runner can't flake the
default suite; run them explicitly (before a release, or when touching the load
path). `loads_100k_rows_within_the_performance_budget` in `commands/file.rs`
asserts the "File load (100k rows) < 3 s" target below.

## Architecture

### System Boundary

Frontend (React/TS) ↔ Tauri IPC ↔ Backend (Rust/DuckDB)

All data processing happens in Rust. The frontend never reads files directly — it calls `invoke()` and receives typed responses.

### Backend State Model

Each tab owns an independent DuckDB in-memory connection plus its current view state, held in `src-tauri/src/state.rs` as `DuckDBState { tabs: Mutex<HashMap<String, Arc<TabSession>>> }` (keyed by `tab_id`). `DuckDBState::session()` locks the map, clones the `Arc<TabSession>`, and drops the map lock so a command can hold the tab's own connection lock without holding the (unrelated) map lock.

`TabSession` holds:
- `conn: Arc<Mutex<Connection>>`
- `result: Mutex<Option<ResultView>>` — the materialized `csv_result` table from the last applied `where`/`sql` query (`table`, `total_rows`, `src_row_id_col`); `None` means the grid reads `csv_data` directly
- `generation: AtomicU64` — bumped by every `apply_query`/`clear_query`; echoed in `DataRange` so the frontend can discard responses for a superseded view
- `base_total_rows` / `base_columns` — captured at load, used by `clear_query` and by `apply_query`'s post-execution check that the query didn't mutate `csv_data`

`TabSession::current_view()` returns `(table, generation, source_row_id_column)` — the single source of truth every command uses to know what to read. When a tab closes, its entry is removed, the connection is dropped, and memory is freed.

### IPC Commands (`src-tauri/src/commands/`)

| Command | Purpose |
|---|---|
| `open_csv_file(path, tab_id, encoding?)` | Detect encoding/delimiter (or use the optional `encoding` override — a WHATWG label resolved via `encoding_rs::Encoding::for_label`) → load into DuckDB → lock the connection down (`enable_external_access=false`, `lock_configuration=true`) → return `FileMetadata` (including `encoding_confident`) |
| `get_csv_data_range(tab_id, start_row, end_row, generation)` | Page the tab's *current view* (`csv_data` or `csv_result`) ordered by its ordinal column → return `DataRange` (rows, `generation`, original `row_ids` when the view still carries them). A stale request `generation` is ignored, not an error — the frontend discards mismatched responses. The only command whose error crosses IPC as a discriminated `CommandError { code, message }` rather than a bare string — `code` is `tabNotFound` (an ordinary close/switch race, not shown to the user) or `connection`/`internal` (drives the tab's ⚠ icon) |
| `search_csv(tab_id, query)` | Text search over the current view (capped at 10,000 hits) → return `SearchResponse` |
| `apply_query(tab_id, request)` | Run a `where` predicate (+ optional sort) or a `sql` SELECT against the current view, materialize it as `csv_result` via CTAS, bump `generation` → return `QueryOutcome` |
| `preview_query(tab_id, request, request_id)` | Same query, run read-only (`SELECT … LIMIT 100` inside a rolled-back transaction) for the live preview panel → return `QueryPreview` |
| `clear_query(tab_id)` | Drop `csv_result`, revert the view to `csv_data`, bump `generation` |
| `close_tab(tab_id)` | Drop the `TabSession` (and its connection), free memory |

`apply_query`/`preview_query` are `async` and run the blocking DB work on `spawn_blocking` with a watchdog that calls `InterruptHandle::interrupt()` on timeout (10 s apply / 2 s preview). Every user-authored SQL string must pass through `sql::validate::assert_single_statement` + `sql::wrap_ctas`/`wrap_select` — `Connection::prepare()` alone is *not* a security boundary (it executes all but the last statement of a multi-statement input).

### Virtual Scrolling

AG-Grid Infinite Row Model drives all data fetching. `src/components/DataGrid/datasource.ts` implements `IDataSource`, calling `get_csv_data_range` on each scroll event. The frontend never holds the full dataset.

### Frontend State

`src/store/appReducer.ts` uses `useReducer` (Redux-like). Global `AppState` is only `tabs`, `activeTabId`, `errorMessage` — everything search/query related is **per tab** on `CsvTab` (`isSearchOpen`, `searchMode`, `queryDrafts.{where,sql}`, `queryStatus`, `resultView`, `preview`, `sort`, `queryHistory`, `generation`), so switching tabs never leaks one tab's search state onto another. Tab lifecycle logic lives in the reducer itself (`TAB_ADD`/`TAB_CLOSE`/`TAB_SWITCH`) wired up in `App.tsx` — there is no `useTabManager` hook. The hooks (`useFileOpen`, `useSearch`, `useQuery`, `useKeyboardShortcuts`, `useDebounce`) dispatch actions — no prop drilling. Backend command failures surface via the `SET_ERROR`/`CLEAR_ERROR` actions that set `state.errorMessage`; query failures instead land in the active tab's `queryStatus` (cleared automatically on the next `QUERY_DRAFT_SET`).

### Frontend Directory Layout

```
src/
├── App.tsx                        # root, global state wiring
├── components/
│   ├── TitleBar.tsx               # macOS traffic lights
│   ├── Toolbar.tsx
│   ├── TabBar/{TabBar,Tab}.tsx
│   ├── FileInfoBar.tsx
│   ├── SearchBar.tsx              # text/where/sql mode switch, shown only when ⌘F active
│   ├── SqlEditor.tsx              # CodeMirror 6, lazy-loaded on first sql-mode open
│   ├── QueryPreviewPanel.tsx      # ≤100-row live preview under the editor
│   ├── ResultBar.tsx              # "csv_data (100,000 rows)" → "… → filtered (n rows)" + Reset
│   ├── CopyButton.tsx
│   ├── DataGrid/{DataGrid.tsx,datasource.ts}
│   ├── EmptyState.tsx
│   ├── LoadingState.tsx           # shown while a tab's file loads
│   ├── ErrorBoundary.tsx          # catches render errors
│   └── StatusBar.tsx
├── hooks/{useFileOpen,useSearch,useQuery,useKeyboardShortcuts,useDebounce}.ts
├── store/appReducer.ts
└── types/index.ts
```

### Backend Directory Layout

```
src-tauri/src/
├── main.rs / lib.rs
├── state.rs         # DuckDBState → per-tab TabSession (conn, ResultView, generation)
├── types.rs         # FileMetadata, DataRange, QueryRequest/Outcome, CsvError, etc.
├── commands/
│   ├── {mod,file,data,search}.rs
│   ├── query.rs     # apply_query / preview_query / clear_query + timeout watchdog
│   └── view.rs      # csv_data / csv_result table + internal column-name rules
├── sql/{mod,validate,wrap}.rs   # single-statement gate + CTAS/SELECT wrapping
└── csv/{mod,encoding,delimiter}.rs
```

## Key Technical Decisions

- **DuckDB `read_csv_auto`** (from the `duckdb` crate, pinned to 1.x with the `bundled` feature) is used for initial load. Encoding is detected *before* passing to DuckDB — `chardetng`/`encoding_rs` in `csv/encoding.rs` — and the delimiter is chosen by a hand-rolled `detect_delimiter` in `csv/delimiter.rs` (there is no `csv` crate dependency). At load time a `__row_id` ordinal column is materialized so `get_csv_data_range` and `search_csv` share a stable row identity to `ORDER BY`.
- **Reference implementation**: [Duckling](https://github.com/l1xnan/duckling) is the primary reference for Tauri + DuckDB IPC patterns. Strip out Parquet, DB connections, and the schema browser (the search bar's `sql` mode already covers that need) — keep DuckDB connection management, `read_csv_auto` usage, encoding detection, and the AG-Grid datasource pattern.
- **View pipeline**: `where`/`sql` queries are not appended to `get_csv_data_range`'s SQL — `apply_query` materializes `csv_result` (`CREATE OR REPLACE TABLE`, capped at `sql::MAX_RESULT_ROWS` = 1M) and every subsequent read goes through `TabSession::current_view()`. A `where` apply is rewritten against the *current* view, so filters chain automatically; a `sql` apply passes the user's statement through verbatim, so it chains only if it names `csv_result` itself. `clear_query` drops back to `csv_data`. See `docs/SEARCH_ARCHITECTURE.md` for the full design.
- **Sort**: header clicks dispatch `SORT_SET` and re-`apply_query` the tab's current predicate (or `1=1`) with the new sort, so sorting composes with an active filter instead of resetting it. All columns are `VARCHAR` (`all_varchar=true` at load), so a column whose values all parse as numbers is ordered by `TRY_CAST(... AS DOUBLE) … NULLS LAST` rather than lexicographically. The toolbar's Sort button only *clears* the sort; Filter opens the search bar in `where` mode.
- **Tauri v2 import paths**: `invoke` is from `@tauri-apps/api/core`, `open` dialog is from `@tauri-apps/plugin-dialog` (different from v1).
- **`DataGrid` key prop**: keyed on `` `${activeTab.id}:${activeTab.generation}` `` — forces AG-Grid instance recreation on tab switch *and* on every view change (apply/clear), so column defs, the block cache, and scroll position all reset together.
- **`get_csv_data_range` is sync**: it's a fast, bounded paging query (≤500 rows) that isn't worth a thread hop — not a `Send` restriction. DuckDB's `Connection` *is* `Send` (it is `!Sync`, which the `Arc<Mutex<_>>` already handles); this is what lets `apply_query`/`preview_query` move a `TabSession` onto `spawn_blocking`.

## Performance Targets

| Metric | Target |
|---|---|
| File load (100k rows) | < 3 s |
| Initial render | < 1 s |
| Scroll FPS | 60 fps |
| Memory (100k rows) | < 200 MB |
| App startup | < 2 s |

macOS 11 (Big Sur)+, Universal Binary (x86_64 + arm64), no network calls.
