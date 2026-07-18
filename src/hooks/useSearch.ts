import { invoke } from "@tauri-apps/api/core";
import type { SearchResponse, AppAction } from "../types";

export function useSearch(dispatch: React.Dispatch<AppAction>) {
  const search = async (tabId: string, query: string) => {
    if (!query.trim()) {
      dispatch({ type: "SEARCH_UPDATE", payload: { tabId, query: "", hits: [] } });
      return;
    }

    try {
      const result = await invoke<SearchResponse>("search_csv", { tabId, query });
      dispatch({
        type: "SEARCH_UPDATE",
        payload: { tabId, query, hits: result.hits },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Search failed:", msg);
      dispatch({ type: "SET_ERROR", payload: `Search failed: ${msg}` });
    }
  };

  return { search };
}
