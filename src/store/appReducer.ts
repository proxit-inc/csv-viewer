import type { AppState, AppAction, CsvTab } from "../types";

export const initialState: AppState = {
  tabs: [],
  activeTabId: null,
  isSearchOpen: false,
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
        isSearchOpen: remaining.length === 0 ? false : state.isSearchOpen,
      };
    }

    case "TAB_SWITCH":
      return { ...state, activeTabId: action.payload.tabId };

    case "TAB_METADATA_LOADED": {
      const { tabId, metadata } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, metadata, isLoading: false } : t
        ),
      };
    }

    case "TAB_SCROLL_SAVE": {
      const { tabId, offset } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, scrollOffset: offset } : t
        ),
      };
    }

    case "SEARCH_OPEN":
      return { ...state, isSearchOpen: true };

    case "SEARCH_CLOSE":
      return { ...state, isSearchOpen: false };

    case "SEARCH_UPDATE": {
      const { tabId, query, hits } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId
            ? { ...t, searchQuery: query, searchHits: hits, searchHitIndex: 0 }
            : t
        ),
      };
    }

    case "SEARCH_NAVIGATE": {
      const { tabId, index } = action.payload;
      return {
        ...state,
        tabs: state.tabs.map((t): CsvTab =>
          t.id === tabId ? { ...t, searchHitIndex: index } : t
        ),
      };
    }

    default:
      return state;
  }
}
