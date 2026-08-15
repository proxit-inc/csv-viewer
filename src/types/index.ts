export type QueryMode = "text" | "where" | "sql";

export interface CsvTab {
  id: string;
  filePath: string;
  filename: string;
  metadata: FileMetadata | null;
  isLoading: boolean;
  scrollOffset: number;
  searchQuery: string;
  searchHits: SearchHit[];
  searchHitIndex: number;
  searchTruncated: boolean;
  /// Per-tab now (was global AppState.isSearchOpen) — switching tabs no
  /// longer opens/closes the search bar for whatever tab happens to be
  /// active next.
  isSearchOpen: boolean;
  /// Bumped by the backend on every apply_query/clear_query; 0 means the
  /// grid is reading csv_data directly. Threaded into DataGrid's key so a
  /// view change forces a full grid remount (column defs, cache, and scroll
  /// position all reset together).
  generation: number;
  searchMode: QueryMode;
  /// Kept separate per mode so switching text/where/sql doesn't clobber
  /// whatever the user typed in the other editor.
  queryDrafts: { where: string; sql: string };
  queryStatus: QueryStatus;
  resultView: QueryOutcome | null;
  preview: PreviewState | null;
  /// The last sort the user asked for by clicking a column header. Threaded
  /// back into DataGrid's colDefs (as `sort: "asc" | "desc" | null`) after a
  /// generation-triggered remount, since AG-Grid's own sort indicator would
  /// otherwise reset to unsorted on every apply/clear.
  sort: SortSpec[];
  /// Most-recently-applied predicate/SQL first, capped at 50 entries per
  /// mode. In-memory only — there is no persistence layer in this app (see
  /// docs/SEARCH_ARCHITECTURE.md §9), so history does not survive closing
  /// the tab.
  queryHistory: { where: string[]; sql: string[] };
  /// Set when a per-tab IPC call fails in a way that indicates the tab's
  /// DuckDB session is unusable (docs/IMPLEMENTATION.md §4.5). Drives the ⚠
  /// icon on the tab. Deliberately NOT queryStatus: that one is scoped to
  /// apply/preview and is auto-cleared by QUERY_DRAFT_SET and friends.
  connectionError: string | null;
  /// Non-null once the user has manually chosen an encoding for this tab;
  /// keeps the encoding notice reachable so a wrong manual pick is
  /// recoverable, and changes its wording to reflect the override.
  encodingOverride: string | null;
  dismissedNotices: { encoding: boolean; largeRows: boolean };
}

export const MAX_QUERY_HISTORY = 50;

/// docs/IMPLEMENTATION.md §4.5's "1,000,000 行超" warning threshold.
/// Numerically equal to the backend's sql::MAX_RESULT_ROWS but unrelated to
/// it — that one caps query-result materialization; this one is a UX notice
/// shown for the source file itself.
export const LARGE_FILE_ROW_THRESHOLD = 1_000_000;

/// `label` is the WHATWG label passed to Rust (`encoding_rs::Encoding::for_label`);
/// `name` is what encoding_rs reports back in `FileMetadata.encoding`, so the
/// currently-loaded encoding can be matched without a reverse lookup.
export const ENCODING_OPTIONS = [
  { label: "utf-8", name: "UTF-8", display: "UTF-8" },
  { label: "shift_jis", name: "Shift_JIS", display: "Shift_JIS (CP932)" },
  { label: "euc-jp", name: "EUC-JP", display: "EUC-JP" },
  { label: "iso-2022-jp", name: "ISO-2022-JP", display: "ISO-2022-JP" },
  { label: "utf-16le", name: "UTF-16LE", display: "UTF-16 LE" },
  { label: "utf-16be", name: "UTF-16BE", display: "UTF-16 BE" },
  { label: "windows-1252", name: "windows-1252", display: "Windows-1252 (Latin-1)" },
  { label: "gbk", name: "GBK", display: "GBK (Simplified Chinese)" },
  { label: "big5", name: "Big5", display: "Big5 (Traditional Chinese)" },
  { label: "euc-kr", name: "EUC-KR", display: "EUC-KR (Korean)" },
] as const;

export interface QueryStatus {
  state: "idle" | "running" | "error";
  message?: string;
  position?: number;
}

export interface SortSpec {
  column: string;
  descending: boolean;
}

export type QueryRequest =
  | { mode: "where"; predicate: string; sort: SortSpec[] }
  | { mode: "sql"; sql: string };

export interface QueryOutcome {
  generation: number;
  columns: string[];
  totalRows: number;
  truncated: boolean;
  hasSourceRowId: boolean;
  elapsedMs: number;
  description: string;
}

export interface PreviewState {
  requestId: number;
  columns: string[];
  rows: string[][];
  elapsedMs: number;
  busy: boolean;
  /// Set by a failed preview_query call; the rest of the fields keep
  /// whatever the last *successful* preview returned, per
  /// docs/SEARCH_ARCHITECTURE.md §3-3's "don't blank the panel on every
  /// keystroke error" requirement.
  error: string | null;
}

export interface FileMetadata {
  filename: string;
  filePath: string;
  fileSize: number;
  totalRows: number;
  totalColumns: number;
  encoding: string;
  /// False when encoding detection was uncertain (or fell back to UTF-8
  /// without real evidence); drives the manual-encoding notice. Always true
  /// when the encoding was explicitly chosen by the user.
  encodingConfident: boolean;
  delimiter: string;
  headers: string[];
}

export interface DataRange {
  rows: string[][];
  totalRows: number;
  /// Echoed back from the request; a response whose generation doesn't
  /// match the generation the caller asked for should be silently discarded
  /// (see docs/SEARCH_ARCHITECTURE.md §2-3 — not an error, just a stale
  /// scroll/apply race).
  generation: number;
  /// Original file row number per returned row, when the current view still
  /// carries one; `null` for e.g. an aggregation result.
  rowIds: number[] | null;
}

export interface SearchHit {
  row: number;
  column: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  totalCount: number;
  truncated: boolean;
}

export interface AppState {
  tabs: CsvTab[];
  activeTabId: string | null;
  errorMessage: string | null;
}

export type AppAction =
  | { type: "TAB_ADD"; payload: CsvTab }
  | { type: "TAB_CLOSE"; payload: { tabId: string } }
  | { type: "TAB_SWITCH"; payload: { tabId: string } }
  | { type: "TAB_METADATA_LOADED"; payload: { tabId: string; metadata: FileMetadata } }
  | { type: "TAB_SCROLL_SAVE"; payload: { tabId: string; offset: number } }
  | { type: "SEARCH_OPEN"; payload: { tabId: string } }
  | { type: "SEARCH_CLOSE"; payload: { tabId: string } }
  | {
      type: "SEARCH_UPDATE";
      payload: { tabId: string; query: string; hits: SearchHit[]; truncated: boolean };
    }
  | { type: "SEARCH_NAVIGATE"; payload: { tabId: string; index: number } }
  | { type: "SEARCH_MODE_SET"; payload: { tabId: string; mode: QueryMode } }
  | {
      type: "QUERY_DRAFT_SET";
      payload: { tabId: string; mode: "where" | "sql"; draft: string };
    }
  | { type: "QUERY_PREVIEW_UPDATE"; payload: { tabId: string; preview: PreviewState } }
  | { type: "QUERY_PREVIEW_ERROR"; payload: { tabId: string; message: string } }
  | { type: "QUERY_RUN_START"; payload: { tabId: string } }
  | { type: "QUERY_RUN_SUCCESS"; payload: { tabId: string; outcome: QueryOutcome } }
  | { type: "QUERY_RUN_ERROR"; payload: { tabId: string; message: string; position?: number } }
  | { type: "QUERY_CLEAR"; payload: { tabId: string; outcome: QueryOutcome } }
  | { type: "SORT_SET"; payload: { tabId: string; sort: SortSpec[] } }
  | { type: "QUERY_STATUS_CLEAR"; payload: { tabId: string } }
  | { type: "HISTORY_PUSH"; payload: { tabId: string; mode: "where" | "sql"; entry: string } }
  | { type: "SET_ERROR"; payload: string }
  | { type: "CLEAR_ERROR" }
  | { type: "TAB_ERROR_SET"; payload: { tabId: string; message: string } }
  | { type: "TAB_ERROR_CLEAR"; payload: { tabId: string } }
  | { type: "TAB_RELOAD_START"; payload: { tabId: string; encoding: string | null } }
  | { type: "NOTICE_DISMISS"; payload: { tabId: string; notice: "encoding" | "largeRows" } };
