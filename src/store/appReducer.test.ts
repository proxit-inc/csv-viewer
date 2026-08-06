import { describe, it, expect } from "vitest";
import { appReducer, initialState } from "./appReducer";
import type { AppState, CsvTab, FileMetadata, QueryOutcome } from "../types";

function makeTab(id: string, overrides: Partial<CsvTab> = {}): CsvTab {
  return {
    id,
    filePath: `/tmp/${id}.csv`,
    filename: `${id}.csv`,
    metadata: null,
    isLoading: true,
    scrollOffset: 0,
    searchQuery: "",
    searchHits: [],
    searchHitIndex: 0,
    searchTruncated: false,
    isSearchOpen: false,
    generation: 0,
    searchMode: "text",
    queryDrafts: { where: "", sql: "" },
    queryStatus: { state: "idle" },
    resultView: null,
    preview: null,
    sort: [],
    queryHistory: { where: [], sql: [] },
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<QueryOutcome> = {}): QueryOutcome {
  return {
    generation: 1,
    columns: ["a", "b"],
    totalRows: 5,
    truncated: false,
    hasSourceRowId: true,
    elapsedMs: 3,
    description: "filtered",
    ...overrides,
  };
}

function stateWithTabs(tabs: CsvTab[], activeTabId: string | null): AppState {
  return { ...initialState, tabs, activeTabId };
}

describe("appReducer", () => {
  it("TAB_ADD appends the tab and makes it active", () => {
    const tabA = makeTab("a");
    const tabB = makeTab("b");
    const state = appReducer(stateWithTabs([tabA], "a"), { type: "TAB_ADD", payload: tabB });

    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.activeTabId).toBe("b");
  });

  describe("TAB_CLOSE", () => {
    it("selects the next tab to the right when closing the active tab", () => {
      const tabs = [makeTab("a"), makeTab("b"), makeTab("c")];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "TAB_CLOSE",
        payload: { tabId: "a" },
      });

      expect(state.tabs.map((t) => t.id)).toEqual(["b", "c"]);
      expect(state.activeTabId).toBe("b");
    });

    it("selects the previous tab when closing the active last tab", () => {
      const tabs = [makeTab("a"), makeTab("b"), makeTab("c")];
      const state = appReducer(stateWithTabs(tabs, "c"), {
        type: "TAB_CLOSE",
        payload: { tabId: "c" },
      });

      expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
      expect(state.activeTabId).toBe("b");
    });

    it("sets activeTabId to null when closing the only tab", () => {
      const tabs = [makeTab("a")];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "TAB_CLOSE",
        payload: { tabId: "a" },
      });

      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
    });

    it("leaves the active tab unchanged when closing a non-active tab", () => {
      const tabs = [makeTab("a"), makeTab("b")];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "TAB_CLOSE",
        payload: { tabId: "b" },
      });

      expect(state.tabs.map((t) => t.id)).toEqual(["a"]);
      expect(state.activeTabId).toBe("a");
    });
  });

  it("TAB_SWITCH changes the active tab", () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "TAB_SWITCH",
      payload: { tabId: "b" },
    });

    expect(state.activeTabId).toBe("b");
  });

  it("TAB_METADATA_LOADED attaches metadata and clears isLoading for the matching tab only", () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const metadata: FileMetadata = {
      filename: "a.csv",
      filePath: "/tmp/a.csv",
      fileSize: 100,
      totalRows: 10,
      totalColumns: 2,
      encoding: "UTF-8",
      delimiter: ",",
      headers: ["id", "name"],
    };
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "TAB_METADATA_LOADED",
      payload: { tabId: "a", metadata },
    });

    const tabA = state.tabs.find((t) => t.id === "a")!;
    const tabB = state.tabs.find((t) => t.id === "b")!;
    expect(tabA.metadata).toEqual(metadata);
    expect(tabA.isLoading).toBe(false);
    expect(tabB.metadata).toBeNull();
    expect(tabB.isLoading).toBe(true);
  });

  it("TAB_SCROLL_SAVE stores the scroll offset for the matching tab only", () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "TAB_SCROLL_SAVE",
      payload: { tabId: "a", offset: 42 },
    });

    expect(state.tabs.find((t) => t.id === "a")!.scrollOffset).toBe(42);
    expect(state.tabs.find((t) => t.id === "b")!.scrollOffset).toBe(0);
  });

  it("SEARCH_OPEN and SEARCH_CLOSE toggle isSearchOpen for the target tab only", () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const opened = appReducer(stateWithTabs(tabs, "a"), {
      type: "SEARCH_OPEN",
      payload: { tabId: "a" },
    });
    expect(opened.tabs.find((t) => t.id === "a")!.isSearchOpen).toBe(true);
    expect(opened.tabs.find((t) => t.id === "b")!.isSearchOpen).toBe(false);

    const closed = appReducer(opened, { type: "SEARCH_CLOSE", payload: { tabId: "a" } });
    expect(closed.tabs.find((t) => t.id === "a")!.isSearchOpen).toBe(false);
  });

  it("SEARCH_UPDATE sets query/hits/truncated and resets searchHitIndex to 0", () => {
    const tabs = [makeTab("a", { searchHitIndex: 3 })];
    const hits = [
      { row: 1, column: 0 },
      { row: 2, column: 1 },
    ];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "SEARCH_UPDATE",
      payload: { tabId: "a", query: "foo", hits, truncated: true },
    });

    const tabA = state.tabs[0];
    expect(tabA.searchQuery).toBe("foo");
    expect(tabA.searchHits).toEqual(hits);
    expect(tabA.searchHitIndex).toBe(0);
    expect(tabA.searchTruncated).toBe(true);
  });

  it("SEARCH_NAVIGATE updates searchHitIndex for the matching tab only", () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "SEARCH_NAVIGATE",
      payload: { tabId: "a", index: 5 },
    });

    expect(state.tabs.find((t) => t.id === "a")!.searchHitIndex).toBe(5);
    expect(state.tabs.find((t) => t.id === "b")!.searchHitIndex).toBe(0);
  });

  it("QUERY_RUN_SUCCESS sets generation/resultView and clears stale search hits", () => {
    const tabs = [
      makeTab("a", { searchQuery: "foo", searchHits: [{ row: 0, column: 0 }], searchHitIndex: 1 }),
    ];
    const outcome = makeOutcome({ generation: 3 });
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "QUERY_RUN_SUCCESS",
      payload: { tabId: "a", outcome },
    });

    const tabA = state.tabs[0];
    expect(tabA.generation).toBe(3);
    expect(tabA.resultView).toEqual(outcome);
    expect(tabA.queryStatus).toEqual({ state: "idle" });
    expect(tabA.searchHits).toEqual([]);
    expect(tabA.searchQuery).toBe("");
    expect(tabA.searchHitIndex).toBe(0);
  });

  it("QUERY_RUN_ERROR sets queryStatus without touching the global errorMessage", () => {
    const tabs = [makeTab("a")];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "QUERY_RUN_ERROR",
      payload: { tabId: "a", message: "syntax error", position: 4 },
    });

    expect(state.tabs[0].queryStatus).toEqual({
      state: "error",
      message: "syntax error",
      position: 4,
    });
    expect(state.errorMessage).toBeNull();
  });

  it("QUERY_PREVIEW_ERROR overlays an error while keeping the previous preview rows", () => {
    const tabs = [
      makeTab("a", {
        preview: {
          requestId: 1,
          columns: ["a"],
          rows: [["1"]],
          elapsedMs: 2,
          busy: false,
          error: null,
        },
      }),
    ];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "QUERY_PREVIEW_ERROR",
      payload: { tabId: "a", message: "bad predicate" },
    });

    expect(state.tabs[0].preview).toEqual({
      requestId: 1,
      columns: ["a"],
      rows: [["1"]],
      elapsedMs: 2,
      busy: false,
      error: "bad predicate",
    });
  });

  it("QUERY_CLEAR reverts generation/resultView, drops the preview, and clears sort", () => {
    const tabs = [
      makeTab("a", {
        generation: 2,
        resultView: makeOutcome({ generation: 2 }),
        preview: { requestId: 1, columns: [], rows: [], elapsedMs: 0, busy: false, error: null },
        sort: [{ column: "value", descending: true }],
      }),
    ];
    const outcome = makeOutcome({ generation: 3, description: "csv_data" });
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "QUERY_CLEAR",
      payload: { tabId: "a", outcome },
    });

    const tabA = state.tabs[0];
    expect(tabA.generation).toBe(3);
    expect(tabA.resultView).toBeNull();
    expect(tabA.preview).toBeNull();
    expect(tabA.sort).toEqual([]);
  });

  it("SORT_SET stores the sort spec for the matching tab only", () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const sort = [{ column: "value", descending: false }];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "SORT_SET",
      payload: { tabId: "a", sort },
    });

    expect(state.tabs.find((t) => t.id === "a")!.sort).toEqual(sort);
    expect(state.tabs.find((t) => t.id === "b")!.sort).toEqual([]);
  });

  describe("HISTORY_PUSH", () => {
    it("prepends the entry to the given mode's history only", () => {
      const tabs = [makeTab("a")];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "HISTORY_PUSH",
        payload: { tabId: "a", mode: "where", entry: "city = 'Tokyo'" },
      });

      expect(state.tabs[0].queryHistory.where).toEqual(["city = 'Tokyo'"]);
      expect(state.tabs[0].queryHistory.sql).toEqual([]);
    });

    it("moves a re-run entry to the front instead of duplicating it", () => {
      const tabs = [makeTab("a", { queryHistory: { where: ["b", "a"], sql: [] } })];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "HISTORY_PUSH",
        payload: { tabId: "a", mode: "where", entry: "a" },
      });

      expect(state.tabs[0].queryHistory.where).toEqual(["a", "b"]);
    });

    it("caps history at MAX_QUERY_HISTORY entries", () => {
      const existing = Array.from({ length: 50 }, (_, i) => `q${i}`);
      const tabs = [makeTab("a", { queryHistory: { where: existing, sql: [] } })];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "HISTORY_PUSH",
        payload: { tabId: "a", mode: "where", entry: "newest" },
      });

      expect(state.tabs[0].queryHistory.where).toHaveLength(50);
      expect(state.tabs[0].queryHistory.where[0]).toBe("newest");
      expect(state.tabs[0].queryHistory.where).not.toContain("q49");
    });

    it("ignores a blank entry", () => {
      const tabs = [makeTab("a")];
      const state = appReducer(stateWithTabs(tabs, "a"), {
        type: "HISTORY_PUSH",
        payload: { tabId: "a", mode: "sql", entry: "   " },
      });

      expect(state.tabs[0].queryHistory.sql).toEqual([]);
    });
  });

  it("TAB_CLOSE no longer touches any global search flag", () => {
    const tabs = [makeTab("a", { isSearchOpen: true }), makeTab("b")];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "TAB_CLOSE",
      payload: { tabId: "a" },
    });

    // The remaining tab's own isSearchOpen is untouched by closing a
    // different tab — there is no global flag left to reset.
    expect(state.tabs.find((t) => t.id === "b")!.isSearchOpen).toBe(false);
  });

  it("SET_ERROR and CLEAR_ERROR manage errorMessage", () => {
    const withError = appReducer(initialState, { type: "SET_ERROR", payload: "boom" });
    expect(withError.errorMessage).toBe("boom");

    const cleared = appReducer(withError, { type: "CLEAR_ERROR" });
    expect(cleared.errorMessage).toBeNull();
  });
});
