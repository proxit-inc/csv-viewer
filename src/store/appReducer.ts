import type { AppState, AppAction, CsvTab } from "../types";
import { MAX_QUERY_HISTORY } from "../types";

export const initialState: AppState = {
  tabs: [],
  activeTabId: null,
  errorMessage: null,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "TAB_ADD": {
      const newTab = action.payload;
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      };
    }

    case "TAB_CLOSE": {
      const { tabId } = action.payload;
      const remaining = state.tabs.filter((t) => t.id !== tabId);
      let nextActiveId = state.activeTabId;

      if (state.activeTabId === tabId) {
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        if (remaining.length > 0) {
          nextActiveId = remaining[Math.min(idx, remaining.length - 1)].id;
        } else {
          nextActiveId = null;
        }
      }

      return {
        ...state,
        tabs: remaining,
        activeTabId: nextActiveId,
      };
    }

    case "TAB_SWITCH":
      return { ...state, activeTabId: action.payload.tabId };

    case "TAB_METADATA_LOADED": {
      const { tabId, metadata } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, metadata, isLoading: false } : t,
        ),
      };
    }

    case "TAB_SCROLL_SAVE": {
      const { tabId, offset } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, scrollOffset: offset } : t)),
      };
    }

    case "SEARCH_OPEN": {
      const { tabId } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, isSearchOpen: true } : t)),
      };
    }

    case "SEARCH_CLOSE": {
      const { tabId } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, isSearchOpen: false } : t)),
      };
    }

    case "SEARCH_UPDATE": {
      const { tabId, query, hits, truncated } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId
            ? {
                ...t,
                searchQuery: query,
                searchHits: hits,
                searchHitIndex: 0,
                searchTruncated: truncated,
              }
            : t,
        ),
      };
    }

    case "SEARCH_NAVIGATE": {
      const { tabId, index } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, searchHitIndex: index } : t)),
      };
    }

    case "SEARCH_MODE_SET": {
      const { tabId, mode } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, searchMode: mode } : t)),
      };
    }

    case "QUERY_DRAFT_SET": {
      const { tabId, mode, draft } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId
            ? {
                ...t,
                queryDrafts: { ...t.queryDrafts, [mode]: draft },
                // Editing the predicate/SQL implicitly dismisses whatever
                // error was left over from the last failed apply (queryStatus)
                // or preview (preview.error) — otherwise the message has no
                // way to clear short of a successful re-apply/re-preview (or
                // Reset, which doesn't exist yet on a tab that has never
                // successfully applied). A fresh debounced preview fires
                // ~200ms after this anyway; clearing here just avoids a
                // stale-looking error sitting on screen for that window.
                queryStatus: { state: "idle" },
                preview: t.preview ? { ...t.preview, error: null } : t.preview,
              }
            : t,
        ),
      };
    }

    case "QUERY_STATUS_CLEAR": {
      const { tabId } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, queryStatus: { state: "idle" } } : t,
        ),
      };
    }

    case "QUERY_PREVIEW_UPDATE": {
      const { tabId, preview } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, preview } : t)),
      };
    }

    case "QUERY_PREVIEW_ERROR": {
      const { tabId, message } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId && t.preview ? { ...t, preview: { ...t.preview, error: message } } : t,
        ),
      };
    }

    case "QUERY_RUN_START": {
      const { tabId } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, queryStatus: { state: "running" } } : t,
        ),
      };
    }

    case "QUERY_RUN_SUCCESS": {
      const { tabId, outcome } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId
            ? {
                ...t,
                generation: outcome.generation,
                resultView: outcome,
                queryStatus: { state: "idle" },
                // Hits are cell coordinates into whatever view was active
                // when the search ran — they no longer line up once the
                // view changes underneath them.
                searchHits: [],
                searchQuery: "",
                searchHitIndex: 0,
                searchTruncated: false,
              }
            : t,
        ),
      };
    }

    case "QUERY_RUN_ERROR": {
      const { tabId, message, position } = action.payload;
      // Syntax/query errors are surfaced inline next to the editor, never in
      // the global red banner (docs/SEARCH_ARCHITECTURE.md §4-3) — that stays
      // reserved for IPC-level failures like a vanished tab.
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, queryStatus: { state: "error", message, position } } : t,
        ),
      };
    }

    case "QUERY_CLEAR": {
      const { tabId, outcome } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId
            ? {
                ...t,
                generation: outcome.generation,
                resultView: null,
                queryStatus: { state: "idle" },
                preview: null,
                searchHits: [],
                searchQuery: "",
                searchHitIndex: 0,
                searchTruncated: false,
                sort: [],
              }
            : t,
        ),
      };
    }

    case "SORT_SET": {
      const { tabId, sort } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, sort } : t)),
      };
    }

    case "HISTORY_PUSH": {
      const { tabId, mode, entry } = action.payload;
      if (!entry.trim()) return state;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => {
          if (t.id !== tabId) return t;
          const existing = t.queryHistory[mode];
          // Most-recent-first; re-running the same query moves it to the
          // front instead of appearing twice.
          const deduped = existing.filter((e) => e !== entry);
          const next = [entry, ...deduped].slice(0, MAX_QUERY_HISTORY);
          return { ...t, queryHistory: { ...t.queryHistory, [mode]: next } };
        }),
      };
    }

    case "SET_ERROR":
      return { ...state, errorMessage: action.payload };

    case "CLEAR_ERROR":
      return { ...state, errorMessage: null };

    case "TAB_ERROR_SET": {
      const { tabId, message } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map(
          (t): CsvTab => (t.id === tabId ? { ...t, connectionError: message } : t),
        ),
      };
    }

    case "TAB_ERROR_CLEAR": {
      const { tabId } = action.payload;
      const target = state.tabs.find((t) => t.id === tabId);
      // No-op when already clear — this fires on every successful
      // get_csv_data_range response, so returning a fresh object each time
      // would re-render the whole app on every scroll block.
      if (!target || target.connectionError === null) return state;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab => (t.id === tabId ? { ...t, connectionError: null } : t)),
      };
    }

    case "TAB_RELOAD_START": {
      const { tabId, encoding } = action.payload;
      // The backend creates a brand-new session at generation 0 with no
      // ResultView, so every field derived from the old session must reset
      // too — otherwise datasource.ts's generation check discards every
      // response from the new session and the grid stays permanently blank.
      return {
        ...state,
        tabs: state.tabs.map(
          (t): CsvTab =>
            t.id === tabId
              ? {
                  ...t,
                  isLoading: true,
                  metadata: null,
                  generation: 0,
                  resultView: null,
                  preview: null,
                  queryStatus: { state: "idle" },
                  searchHits: [],
                  searchQuery: "",
                  searchHitIndex: 0,
                  searchTruncated: false,
                  sort: [],
                  scrollOffset: 0,
                  connectionError: null,
                  encodingOverride: encoding,
                  dismissedNotices: { encoding: false, largeRows: false },
                }
              : t,
        ),
      };
    }

    case "NOTICE_DISMISS": {
      const { tabId, notice } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map(
          (t): CsvTab =>
            t.id === tabId
              ? { ...t, dismissedNotices: { ...t.dismissedNotices, [notice]: true } }
              : t,
        ),
      };
    }

    default:
      return state;
  }
}
