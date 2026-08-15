import { useReducer, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { v4 as uuid } from "uuid";
import type { SortSpec } from "./types";
import { appReducer, initialState } from "./store/appReducer";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar/TabBar";
import { FileInfoBar } from "./components/FileInfoBar";
import { SearchBar } from "./components/SearchBar";
import { ResultBar } from "./components/ResultBar";
import { DataGrid } from "./components/DataGrid/DataGrid";
import { EmptyState } from "./components/EmptyState";
import { LoadingState } from "./components/LoadingState";
import { StatusBar } from "./components/StatusBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useFileOpen } from "./hooks/useFileOpen";
import { useQuery } from "./hooks/useQuery";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { openFile } = useFileOpen(dispatch);
  const { applyQuery, clearQuery } = useQuery(dispatch);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  const handleSortChange = useCallback(
    (sort: SortSpec[]) => {
      if (!activeTab) return;
      dispatch({ type: "SORT_SET", payload: { tabId: activeTab.id, sort } });
      // Re-applies the tab's current predicate (or a no-op filter if none is
      // active) together with the new sort — apply_query always runs
      // against the tab's current view, so this composes with whatever
      // where/sql result is already showing rather than resetting it (see
      // docs/SEARCH_ARCHITECTURE.md §3-5).
      applyQuery(
        activeTab.id,
        {
          mode: "where",
          predicate: activeTab.queryDrafts.where.trim() || "1=1",
          sort,
        },
        { recordHistory: false },
      );
    },
    [activeTab, dispatch, applyQuery],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      dispatch({ type: "TAB_CLOSE", payload: { tabId } });
      invoke("close_tab", { tabId }).catch(console.error);
    },
    [dispatch],
  );

  const handleScrollSave = useCallback(
    (tabId: string, offset: number) =>
      dispatch({ type: "TAB_SCROLL_SAVE", payload: { tabId, offset } }),
    [dispatch],
  );

  useEffect(() => {
    const tabs = state.tabs;
    return () => {
      tabs.forEach((tab) => invoke("close_tab", { tabId: tab.id }).catch(console.error));
    };
  }, []); // intentional: cleanup on unmount only

  // Global drag-and-drop: register once so listener never accumulates.
  // openFileRef lets the closure always call the latest openFile without
  // re-registering the listener on every render.
  const openFileRef = useRef(openFile);
  useEffect(() => {
    openFileRef.current = openFile;
  }, [openFile]);

  useEffect(() => {
    const CSV_EXTS = ["csv", "tsv", "txt"];
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        event.payload.paths.forEach((path) => {
          const ext = path.split(".").pop()?.toLowerCase() ?? "";
          if (CSV_EXTS.includes(ext)) openFileRef.current(uuid(), path);
        });
      })
      .then((fn) => {
        // If cleanup already ran before .then() resolved, unlisten immediately.
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []); // single registration for the lifetime of the app

  useKeyboardShortcuts({
    onOpen: () => openFile(uuid()),
    onSearch: () =>
      activeTab && dispatch({ type: "SEARCH_OPEN", payload: { tabId: activeTab.id } }),
    onSearchSql: () => {
      if (!activeTab) return;
      dispatch({ type: "SEARCH_OPEN", payload: { tabId: activeTab.id } });
      dispatch({ type: "SEARCH_MODE_SET", payload: { tabId: activeTab.id, mode: "sql" } });
    },
    onSearchClose: () =>
      activeTab && dispatch({ type: "SEARCH_CLOSE", payload: { tabId: activeTab.id } }),
    onCloseTab: () => activeTab && handleCloseTab(activeTab.id),
    onSwitchTab: (index) => {
      const tab = state.tabs[index];
      if (tab) dispatch({ type: "TAB_SWITCH", payload: { tabId: tab.id } });
    },
  });

  const renderContent = () => {
    if (!activeTab) {
      return <EmptyState onOpen={() => openFile(uuid())} />;
    }
    if (activeTab.isLoading || !activeTab.metadata) {
      return <LoadingState filename={activeTab.filename} />;
    }
    return (
      <DataGrid
        key={`${activeTab.id}:${activeTab.generation}`}
        columns={activeTab.resultView?.columns ?? activeTab.metadata.headers}
        totalRows={activeTab.resultView?.totalRows ?? activeTab.metadata.totalRows}
        tabId={activeTab.id}
        generation={activeTab.generation}
        searchHits={activeTab.searchHits}
        currentHitIndex={activeTab.searchHitIndex}
        initialScrollOffset={activeTab.scrollOffset}
        onScrollSave={handleScrollSave}
        sort={activeTab.sort}
        onSortChange={handleSortChange}
      />
    );
  };

  return (
    <div className="app-shell">
      <TitleBar filename={activeTab?.filename ?? null} />

      <Toolbar
        onOpen={() => openFile(uuid())}
        onSearch={() =>
          activeTab && dispatch({ type: "SEARCH_OPEN", payload: { tabId: activeTab.id } })
        }
        onFilter={() => {
          if (!activeTab) return;
          dispatch({ type: "SEARCH_OPEN", payload: { tabId: activeTab.id } });
          dispatch({ type: "SEARCH_MODE_SET", payload: { tabId: activeTab.id, mode: "where" } });
        }}
        onClearSort={() => handleSortChange([])}
        hasSort={!!activeTab?.sort.length}
        hasFile={!!activeTab?.metadata}
      />

      <TabBar
        tabs={state.tabs.map((t) => ({ id: t.id, filename: t.filename }))}
        activeTabId={state.activeTabId}
        onSwitch={(id) => dispatch({ type: "TAB_SWITCH", payload: { tabId: id } })}
        onClose={handleCloseTab}
        onAdd={() => openFile(uuid())}
      />

      {activeTab?.metadata && <FileInfoBar metadata={activeTab.metadata} />}

      {activeTab?.isSearchOpen && activeTab.metadata && (
        <SearchBar
          tab={activeTab}
          dispatch={dispatch}
          onClose={() => dispatch({ type: "SEARCH_CLOSE", payload: { tabId: activeTab.id } })}
        />
      )}

      {activeTab?.metadata && (
        <ResultBar
          metadata={activeTab.metadata}
          resultView={activeTab.resultView}
          onReset={() => clearQuery(activeTab.id)}
        />
      )}

      {state.errorMessage && (
        <div
          className="flex items-center justify-between px-3 py-2 text-xs border-b shrink-0"
          style={{ background: "#FEF2F2", borderColor: "#FECACA", color: "#991B1B" }}
        >
          <span>{state.errorMessage}</span>
          <button
            onClick={() => dispatch({ type: "CLEAR_ERROR" })}
            className="ml-4 underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <ErrorBoundary>{renderContent()}</ErrorBoundary>

      <StatusBar activeTab={activeTab} tabCount={state.tabs.length} />
    </div>
  );
}
