# Architecture

CSV Viewer is a macOS desktop app built with Tauri 2 (Rust backend) and React 18 (TypeScript frontend). All data processing happens in Rust — the frontend never reads files directly.

## System Boundary

```
Frontend (React/TS)  ←→  Tauri IPC (invoke)  ←→  Backend (Rust/DuckDB)
```

## Backend State Model

Each tab owns an independent DuckDB **in-memory** connection. Connections are stored in a `Mutex`-wrapped `HashMap` keyed by tab ID. When a tab closes, its connection is dropped and memory is freed immediately.

```
DuckDBState {
    HashMap<tab_id: String, Connection>
        "tab-1" → Connection  (sales.csv loaded)
        "tab-2" → Connection  (customers.csv loaded)
}
```

## IPC Commands

All commands are defined in `src-tauri/src/commands/`.

| Command | Signature | Purpose |
|---|---|---|
| `open_csv_file` | `(path, tab_id) → FileMetadata` | Detect encoding/delimiter → load into DuckDB → return metadata |
| `get_csv_data_range` | `(tab_id, start_row, end_row) → DataRange` | `SELECT * FROM csv_data LIMIT n OFFSET m` |
| `search_csv` | `(tab_id, query) → SearchResponse` | Full-table text search, returns matching row indices |
| `close_tab` | `(tab_id) → ()` | Drop DuckDB connection, free memory |

`get_csv_data_range` is **synchronous** — DuckDB `Connection` is not `Send`, so async is avoided.

## File Loading Pipeline

```
User selects file
  → chardetng + encoding_rs   detect encoding (UTF-8 / Shift_JIS / EUC-JP)
  → csv crate                 detect delimiter (, / \t / ;)
  → DuckDB read_csv_auto()    load into in-memory table
  → return FileMetadata       (row_count, col_count, headers, encoding, delimiter)
```

## Virtual Scrolling

AG-Grid's **Infinite Row Model** drives all data fetching. `src/components/DataGrid/datasource.ts` implements `IDataSource`, calling `get_csv_data_range` on each scroll event. The frontend never holds the full dataset in memory.

```
User scrolls
  → AG-Grid IDataSource.getRows({ startRow, endRow })
  → invoke("get_csv_data_range", { tabId, startRow, endRow })
  → Rust: SELECT * FROM csv_data LIMIT n OFFSET m
  → AG-Grid renders rows
```

## Frontend State

Global state is managed with `useReducer` (Redux-like) in `src/store/appReducer.ts`. Hooks dispatch actions — no prop drilling.

| Hook | Responsibility |
|---|---|
| `useTabManager` | Open/close/switch tabs |
| `useFileOpen` | Dialog + drag-and-drop file opening |
| `useSearch` | Search bar state, result navigation |
| `useKeyboardShortcuts` | Global keyboard event handling |

## Directory Layout

```
src/                                   # React frontend
├── App.tsx
├── components/
│   ├── TitleBar.tsx                   # macOS traffic lights
│   ├── Toolbar.tsx
│   ├── TabBar/{TabBar,Tab}.tsx
│   ├── FileInfoBar.tsx
│   ├── SearchBar.tsx                  # visible only when ⌘F active
│   ├── DataGrid/{DataGrid,datasource}.ts
│   ├── EmptyState.tsx
│   └── StatusBar.tsx
├── hooks/{useFileOpen,useTabManager,useSearch,useKeyboardShortcuts}.ts
├── store/appReducer.ts
└── types/index.ts

src-tauri/src/                         # Rust backend
├── main.rs / lib.rs
├── state.rs                           # DuckDB connection map (Mutex-wrapped)
├── types.rs                           # FileMetadata, DataRange, SearchHit, …
├── commands/{mod,file,data,search}.rs
└── csv/{mod,encoding,delimiter}.rs
```

## Performance Targets

| Metric | Target |
|---|---|
| File load (100k rows) | < 3 s |
| Initial render | < 1 s |
| Scroll FPS | 60 fps |
| Memory (100k rows) | < 200 MB |
| App startup | < 2 s |
