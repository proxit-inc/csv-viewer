import { describe, it, expect } from "vitest";
import { appReducer, initialState } from "./appReducer";
import type { AppState, CsvTab, FileMetadata } from "../types";

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
      expect(state.isSearchOpen).toBe(false);
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

  it("SEARCH_OPEN and SEARCH_CLOSE toggle isSearchOpen", () => {
    const opened = appReducer(initialState, { type: "SEARCH_OPEN" });
    expect(opened.isSearchOpen).toBe(true);

    const closed = appReducer(opened, { type: "SEARCH_CLOSE" });
    expect(closed.isSearchOpen).toBe(false);
  });

  it("SEARCH_UPDATE sets query/hits and resets searchHitIndex to 0", () => {
    const tabs = [makeTab("a", { searchHitIndex: 3 })];
    const hits = [
      { row: 1, column: 0 },
      { row: 2, column: 1 },
    ];
    const state = appReducer(stateWithTabs(tabs, "a"), {
      type: "SEARCH_UPDATE",
      payload: { tabId: "a", query: "foo", hits },
    });

    const tabA = state.tabs[0];
    expect(tabA.searchQuery).toBe("foo");
    expect(tabA.searchHits).toEqual(hits);
    expect(tabA.searchHitIndex).toBe(0);
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

  it("SET_ERROR and CLEAR_ERROR manage errorMessage", () => {
    const withError = appReducer(initialState, { type: "SET_ERROR", payload: "boom" });
    expect(withError.errorMessage).toBe("boom");

    const cleared = appReducer(withError, { type: "CLEAR_ERROR" });
    expect(cleared.errorMessage).toBeNull();
  });
});
