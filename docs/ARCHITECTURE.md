# Architecture

CSV Viewer is a macOS desktop app built with Tauri 2 (Rust backend) and React 18 (TypeScript frontend). It is a **read-only** viewer: viewing, text search, column sort, and `where`/`sql` querying — nothing ever writes back to the file. All data processing happens in Rust; the frontend never reads files directly.

> **Which document to read**
>
> | Document | Role |
> |---|---|
> | `docs/ARCHITECTURE.md` (this file) | Concise English overview of the system **as implemented today**. Start here. |
> | [`docs/SEARCH_ARCHITECTURE.md`](SEARCH_ARCHITECTURE.md) | Japanese design document for the view pipeline (`where`/`sql` query modes, `csv_result`, `generation`, the SQL security boundary). Written as a proposal; now implemented. The authority on *why* the query layer is shaped the way it is. |
> | [`docs/IMPLEMENTATION.md`](IMPLEMENTATION.md) | Japanese implementation specification from the initial build (Phase 1). Historical: parts of its component/hook inventory predate later refactors — prefer this file and the code where they disagree. |
> | `CLAUDE.md` (repo root) | Agent-facing guidance. Mirrors this file's content plus build/lint/test commands. |

## System Boundary

```
Frontend (React/TS)  ←→  Tauri IPC (invoke)  ←→  Backend (Rust/DuckDB)
```

## Backend State Model

Each tab owns an independent DuckDB **in-memory** connection plus the view state describing what the grid is currently reading. State lives in `src-tauri/src/state.rs`:

```
DuckDBState {
    tabs: Mutex<HashMap<String, Arc<TabSession>>>
        "tab-1" → Arc<TabSession>  (sales.csv loaded)
        "tab-2" → Arc<TabSession>  (customers.csv loaded)
}
```

`DuckDBState::session()` locks the map, clones the `Arc<TabSession>`, and drops the map lock — so a command can then hold that tab's own connection lock without also holding the (unrelated) tabs-map lock.

`TabSession` holds:

| Field | Purpose |
|---|---|
| `conn: Arc<Mutex<Connection>>` | The tab's DuckDB connection |
| `result: Mutex<Option<ResultView>>` | The materialized `csv_result` table from the last applied `where`/`sql` query (`table`, `total_rows`, `src_row_id_col`). `None` means the grid reads `csv_data` directly |
| `generation: AtomicU64` | Bumped by every `apply_query`/`clear_query`, echoed back in `DataRange` so the frontend can discard responses for a superseded view |
| `base_total_rows` / `base_columns` | Captured at load; used by `clear_query` and by `apply_query`'s post-execution check that the query didn't mutate `csv_data` |

`TabSession::current_view()` returns `(table, generation, source_row_id_column)` — the single source of truth every command uses to know what to read. When a tab closes, its entry is removed, the connection is dropped, and memory is freed immediately.

## IPC Commands

Seven commands, registered in `src-tauri/src/lib.rs`, implemented under `src-tauri/src/commands/`.

| Command | Signature | Purpose |
|---|---|---|
| `open_csv_file` | `(path, tab_id, encoding?) → FileMetadata` | Detect encoding/delimiter (or use the optional `encoding` override — a WHATWG label resolved via `encoding_rs::Encoding::for_label`) → load into DuckDB → lock the connection down (`enable_external_access=false`, `lock_configuration=true`) → return metadata including `encoding_confident` |
| `get_csv_data_range` | `(tab_id, start_row, end_row, generation) → DataRange` | Page the tab's *current view* (`csv_data` or `csv_result`), ordered by that view's ordinal column. Returns rows, the current `generation`, and the original `row_ids` when the view still carries them |
| `search_csv` | `(tab_id, query) → SearchResponse` | Text search over the current view in a single `UNION ALL` statement, capped at 10,000 hits; returns `(row, column)` hits for highlighting |
| `apply_query` | `(tab_id, request) → QueryOutcome` | Run a `where` predicate (+ optional sort) or a `sql` SELECT against the current view, materialize it as `csv_result` via CTAS, bump `generation` |
| `preview_query` | `(tab_id, request, request_id) → QueryPreview` | The same query run read-only (`SELECT … LIMIT 100` inside a rolled-back transaction) to feed the live preview panel |
| `clear_query` | `(tab_id) → QueryOutcome` | Drop `csv_result`, revert the view to `csv_data`, bump `generation` |
| `close_tab` | `(tab_id) → ()` | Drop the `TabSession` (and its connection), free memory |

**Sync vs. async.** `get_csv_data_range` is **synchronous** because it is a fast, bounded paging query (≤ 500 rows) not worth a thread hop — *not* because of a `Send` restriction. DuckDB's `Connection` **is** `Send` (it is `!Sync`, which the `Arc<Mutex<_>>` already handles). That is exactly what lets `apply_query`/`preview_query` be `async` and move a `TabSession` onto `spawn_blocking`, guarded by a `std::thread` + `Condvar` watchdog that calls `InterruptHandle::interrupt()` on timeout (10 s apply / 2 s preview).

**Stale generations are not errors.** A request carrying an outdated `generation` is served normally; the response always reflects the tab's current view and the frontend silently discards a mismatch. Returning an error here would trigger AG-Grid's retry path for what is just an ordinary scroll-vs-apply race.

**Error shapes.** `get_csv_data_range` is the only command whose error crosses IPC as a discriminated `CommandError { code, message }` — `code` is `tabNotFound` (an ordinary close/switch race, never shown to the user) or `connection`/`internal` (drives the tab's ⚠ icon). Every other command returns a bare `String`, because their frontend handlers render `err.message` directly.

**SQL safety.** Every user-authored SQL string must pass through `sql::validate::assert_single_statement` plus `sql::wrap_ctas`/`wrap_select`. `Connection::prepare()` alone is *not* a security boundary: it executes all but the last statement of a multi-statement input. See [`SEARCH_ARCHITECTURE.md`](SEARCH_ARCHITECTURE.md) §4.

## File Loading Pipeline

```
User selects file (dialog or drag-and-drop)
  → chardetng + encoding_rs      detect encoding (UTF-8 / Shift_JIS / EUC-JP; BOM short-circuits),
                                 or use the user's explicit encoding override
  → detect_delimiter()           hand-rolled scoring over the first 8 KB (, / \t / ;).
                                 No `csv` crate is used — see csv/delimiter.rs
  → UTF-8 temp file              only when the source is not UTF-8: DuckDB's reader assumes UTF-8,
                                 so the decoded text is written out and loaded from there
  → DuckDB read_csv_auto()       CREATE TABLE csv_data AS SELECT (row_number() OVER () - 1)
                                 AS __row_id, * FROM read_csv_auto(…, all_varchar=true)
  → connection lockdown          SET enable_external_access=false; SET lock_configuration=true;
  → return FileMetadata          (row_count, col_count, headers, encoding, encoding_confident, delimiter)
```

`__row_id` is a stable ordinal materialized once at load time, giving `get_csv_data_range` and `search_csv` a shared row identity to `ORDER BY` — DuckDB does not guarantee scan order is consistent across separate queries.

## View Pipeline

`where`/`sql` queries are **not** appended to `get_csv_data_range`'s SQL. Instead:

```
apply_query  → CREATE OR REPLACE TABLE csv_result AS <wrapped user query>  (capped at 1M rows)
             → TabSession.result = Some(ResultView), generation += 1
every read   → TabSession::current_view() → csv_result
clear_query  → drop csv_result, result = None, generation += 1 → back to csv_data
```

- A `where` apply is rewritten against the *current* view, so filters chain automatically.
- A `sql` apply passes the user's statement through verbatim, so it chains only if it names `csv_result` itself.
- Each table carries its own ordinal column (`__row_id` for `csv_data`, `__view_row_id` for `csv_result`, plus `__src_row_id` when the original file row number survives the query), so the `#` column keeps showing real file row numbers whenever the view preserves row identity.
- Text search (⌘F) does not go through this pipeline — it highlights hits within whatever view is current.

**Sort** composes with the pipeline rather than bypassing it: a header click dispatches `SORT_SET` and re-runs `apply_query` with the tab's current predicate (or `1=1`) plus the new sort. Because every column is loaded as `VARCHAR` (`all_varchar=true`), a column whose values all parse as numbers is ordered by `TRY_CAST(… AS DOUBLE) … NULLS LAST` rather than lexicographically.

## Virtual Scrolling

AG-Grid's **Infinite Row Model** drives all data fetching. `src/components/DataGrid/datasource.ts` implements `IDataSource`, calling `get_csv_data_range` on each scroll event. The frontend never holds the full dataset in memory.

```
User scrolls
  → AG-Grid IDataSource.getRows({ startRow, endRow })
  → invoke("get_csv_data_range", { tabId, startRow, endRow, generation })
  → Rust: read the tab's current view, ORDER BY its ordinal column, LIMIT n OFFSET m
  → response's generation matches? render : discard
```

`DataGrid` is keyed on `` `${activeTab.id}:${activeTab.generation}` ``, so the grid instance is recreated on a tab switch *and* on every view change (apply/clear) — column defs, block cache, and scroll position all reset together.

## Frontend State

Global state is managed with `useReducer` (Redux-like) in `src/store/appReducer.ts`. Hooks dispatch actions — no prop drilling.

Global `AppState` is deliberately small — `tabs`, `activeTabId`, `errorMessage`. Everything search/query related is **per tab** on `CsvTab` (`isSearchOpen`, `searchMode`, `queryDrafts.{where,sql}`, `queryStatus`, `resultView`, `preview`, `sort`, `queryHistory`, `generation`, `connectionError`, `encodingOverride`, `dismissedNotices`), so switching tabs never leaks one tab's search state onto another.

Tab lifecycle logic lives **in the reducer itself** (`TAB_ADD` / `TAB_CLOSE` / `TAB_SWITCH`), wired up in `App.tsx`. There is no `useTabManager` hook.

| Hook | Responsibility |
|---|---|
| `useFileOpen` | Dialog + drag-and-drop file opening, encoding-override reload |
| `useSearch` | Text-search state and result navigation |
| `useQuery` | `apply_query` / `preview_query` / `clear_query` orchestration |
| `useKeyboardShortcuts` | Global keyboard event handling (⌘O, ⌘F, ⌘⇧F, ⌘W, ⌘1–9) |
| `useDebounce` | Shared debounce used by search and live preview |

Error routing: backend command failures surface via `SET_ERROR`/`CLEAR_ERROR` (a dismissible banner). Query failures instead land in the active tab's `queryStatus`, cleared automatically on the next `QUERY_DRAFT_SET`. A failure indicating the tab's DuckDB session is unusable sets `connectionError`, which drives the ⚠ icon on the tab.

## Directory Layout

```
src/                                   # React frontend
├── App.tsx                            # root, global state wiring
├── components/
│   ├── Toolbar.tsx                    # Open / Search / Filter / Clear-sort
│   ├── TabBar/{TabBar,Tab}.tsx
│   ├── FileInfoBar.tsx
│   ├── NoticeBar.tsx                  # shared notice-strip shell
│   ├── EncodingNotice.tsx             # manual encoding re-load when detection was unsure
│   ├── LargeFileNotice.tsx            # > 1M rows warning
│   ├── SearchBar.tsx                  # text/where/sql mode switch, shown only when ⌘F active
│   ├── SqlEditor.tsx                  # CodeMirror 6, lazy-loaded on first sql-mode open
│   ├── QueryPreviewPanel.tsx          # ≤100-row live preview under the editor
│   ├── ResultBar.tsx                  # "csv_data (100,000 rows)" → "… → filtered (n rows)" + Reset
│   ├── CopyButton.tsx
│   ├── DataGrid/{DataGrid.tsx,datasource.ts}
│   ├── EmptyState.tsx
│   ├── LoadingState.tsx               # shown while a tab's file loads
│   ├── ErrorBoundary.tsx              # catches render errors
│   └── StatusBar.tsx
├── hooks/{useFileOpen,useSearch,useQuery,useKeyboardShortcuts,useDebounce}.ts
├── store/appReducer.ts
└── types/index.ts

src-tauri/src/                         # Rust backend
├── main.rs / lib.rs                   # command registration
├── state.rs                           # DuckDBState → per-tab TabSession (conn, ResultView, generation)
├── types.rs                           # FileMetadata, DataRange, QueryRequest/Outcome, CsvError, CommandError
├── commands/
│   ├── {mod,file,data,search}.rs
│   ├── query.rs                       # apply_query / preview_query / clear_query + timeout watchdog
│   └── view.rs                        # csv_data / csv_result table + internal column-name rules
├── sql/{mod,validate,wrap}.rs         # single-statement gate + CTAS/SELECT wrapping
└── csv/{mod,encoding,delimiter}.rs
```

There is no `TitleBar` component: the window uses macOS's `titleBarStyle: "Transparent"` (set in `src-tauri/tauri.conf.json`), so the system draws the traffic lights over the app's own chrome.

## Key Dependencies & Constraints

- **DuckDB** via the `duckdb` crate, pinned to 1.x with the `bundled` feature. `read_csv_auto` handles the initial load; every column is `VARCHAR`.
- **Encoding detection** with `chardetng` + `encoding_rs`, run *before* handing anything to DuckDB.
- **No `csv` crate** — delimiter detection is a hand-rolled scorer in `csv/delimiter.rs`.
- **Tauri v2 import paths**: `invoke` from `@tauri-apps/api/core`, `open` dialog from `@tauri-apps/plugin-dialog` (both differ from v1).
- **Reference implementation**: [Duckling](https://github.com/l1xnan/duckling) for Tauri + DuckDB IPC patterns (Parquet, DB connections, and the schema browser are deliberately omitted).

## Performance Targets

| Metric | Target |
|---|---|
| File load (100k rows) | < 3 s |
| Initial render | < 1 s |
| Scroll FPS | 60 fps |
| Memory (100k rows) | < 200 MB |
| App startup | < 2 s |

macOS 11 (Big Sur)+, Universal Binary (x86_64 + arm64), no network calls.
