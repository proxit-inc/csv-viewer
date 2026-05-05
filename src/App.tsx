import { useReducer, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { v4 as uuid } from "uuid";
import { appReducer, initialState } from "./store/appReducer";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar/TabBar";
import { FileInfoBar } from "./components/FileInfoBar";
import { SearchBar } from "./components/SearchBar";
import { DataGrid } from "./components/DataGrid/DataGrid";
import { EmptyState } from "./components/EmptyState";
import { LoadingState } from "./components/LoadingState";
import { StatusBar } from "./components/StatusBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useFileOpen } from "./hooks/useFileOpen";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { openFile } = useFileOpen(dispatch);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  const handleCloseTab = useCallback(
    (tabId: string) => {
      dispatch({ type: "TAB_CLOSE", payload: { tabId } });
      invoke("close_tab", { tabId }).catch(console.error);
    },
    [dispatch]
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
  useEffect(() => { openFileRef.current = openFile; }, [openFile]);

  useEffect(() => {
    const CSV_EXTS = ["csv", "tsv", "txt"];
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        event.payload.paths.forEach((path) => {
          const ext = path.split(".").pop()?.toLowerCase() ?? "";
          if (CSV_EXTS.includes(ext)) openFileRef.current(uuid(), path);
        });
      })
      .then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []); // single registration for the lifetime of the app

  useKeyboardShortcuts({
    onOpen: () => openFile(uuid()),
    onSearch: () => dispatch({ type: "SEARCH_OPEN" }),
    onSearchClose: () => dispatch({ type: "SEARCH_CLOSE" }),
    onCloseTab: () => activeTab && handleCloseTab(activeTab.id),
    onSwitchTab: (index) => {
      const tab = state.tabs[index];
      if (tab) dispatch({ type: "TAB_SWITCH", payload: { tabId: tab.id } });
    },
  });

  const renderContent = () => {
    if (!activeTab) {
      return (
        <EmptyState onOpen={() => openFile(uuid())} />
      );
    }
    if (activeTab.isLoading || !activeTab.metadata) {
      return <LoadingState filename={activeTab.filename} />;
    }
    return (
      <DataGrid
        key={activeTab.id}
        headers={activeTab.metadata.headers}
        totalRows={activeTab.metadata.totalRows}
        tabId={activeTab.id}
        searchHits={activeTab.searchHits}
        currentHitIndex={activeTab.searchHitIndex}
        initialScrollOffset={activeTab.scrollOffset}
        onScrollSave={(offset) =>
          dispatch({ type: "TAB_SCROLL_SAVE", payload: { tabId: activeTab.id, offset } })
        }
      />
    );
  };

  return (
    <div className="app-shell">
      <TitleBar filename={activeTab?.filename ?? null} />

      <Toolbar
        onOpen={() => openFile(uuid())}
        onSearch={() => dispatch({ type: "SEARCH_OPEN" })}
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

      {state.isSearchOpen && activeTab?.metadata && (
        <SearchBar
          tabId={activeTab.id}
          query={activeTab.searchQuery}
          hits={activeTab.searchHits}
          currentIndex={activeTab.searchHitIndex}
          dispatch={dispatch}
          onClose={() => dispatch({ type: "SEARCH_CLOSE" })}
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
