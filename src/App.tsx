import { useReducer, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuid } from "uuid";
import { appReducer, initialState } from "./store/appReducer";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar/TabBar";
import { FileInfoBar } from "./components/FileInfoBar";
import { SearchBar } from "./components/SearchBar";
import { DataGrid } from "./components/DataGrid/DataGrid";
import { EmptyState } from "./components/EmptyState";
import { StatusBar } from "./components/StatusBar";
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
      tabs.forEach((tab) => invoke("close_tab", { tabId: tab.id }).catch(() => {}));
    };
  }, []); // intentional: cleanup on unmount only

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

  return (
    <div className="app-shell">
      <TitleBar filename={activeTab?.filename ?? null} />

      <Toolbar
        onOpen={() => openFile(uuid())}
        onSearch={() => dispatch({ type: "SEARCH_OPEN" })}
        hasFile={!!activeTab}
      />

      <TabBar
        tabs={state.tabs.map((t) => ({ id: t.id, filename: t.filename }))}
        activeTabId={state.activeTabId}
        onSwitch={(id) => dispatch({ type: "TAB_SWITCH", payload: { tabId: id } })}
        onClose={handleCloseTab}
        onAdd={() => openFile(uuid())}
      />

      {activeTab?.metadata && <FileInfoBar metadata={activeTab.metadata} />}

      {state.isSearchOpen && activeTab && (
        <SearchBar
          tabId={activeTab.id}
          query={activeTab.searchQuery}
          hits={activeTab.searchHits}
          currentIndex={activeTab.searchHitIndex}
          dispatch={dispatch}
          onClose={() => dispatch({ type: "SEARCH_CLOSE" })}
        />
      )}

      {activeTab?.metadata ? (
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
      ) : (
        <EmptyState
          onOpen={() => openFile(uuid())}
          onDrop={(path) => openFile(uuid(), path)}
        />
      )}

      <StatusBar activeTab={activeTab} tabCount={state.tabs.length} />
    </div>
  );
}
