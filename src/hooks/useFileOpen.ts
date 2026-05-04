import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { FileMetadata, AppAction } from "../types";

export function useFileOpen(dispatch: React.Dispatch<AppAction>) {
  const openFile = async (tabId: string, forcePath?: string) => {
    let path: string | null = forcePath ?? null;

    if (!path) {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV Files", extensions: ["csv", "tsv", "txt"] }],
      });
      if (!selected || typeof selected !== "string") return;
      path = selected;
    }

    dispatch({
      type: "TAB_ADD",
      payload: {
        id: tabId,
        filePath: path,
        filename: path.split("/").pop() ?? "file.csv",
        metadata: null,
        isLoading: true,
        scrollOffset: 0,
        searchQuery: "",
        searchHits: [],
        searchHitIndex: 0,
      },
    });

    try {
      const metadata = await invoke<FileMetadata>("open_csv_file", { path, tabId });
      dispatch({ type: "TAB_METADATA_LOADED", payload: { tabId, metadata } });
    } catch (err) {
      console.error("Failed to open file:", err);
      dispatch({ type: "TAB_CLOSE", payload: { tabId } });
    }
  };

  return { openFile };
}
