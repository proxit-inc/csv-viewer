import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppAction, PreviewState, QueryOutcome, QueryRequest } from "../types";

export function useQuery(dispatch: React.Dispatch<AppAction>) {
  // Persisted across renders (unlike a plain closure variable) so a preview
  // response arriving after a newer one was requested can still be detected
  // as stale — the same "drop stale responses" pattern datasource.ts uses
  // for latestReqId.
  const latestRequestIdRef = useRef(0);

  const applyQuery = async (
    tabId: string,
    request: QueryRequest,
    options: { recordHistory?: boolean } = {},
  ) => {
    dispatch({ type: "QUERY_RUN_START", payload: { tabId } });
    try {
      const outcome = await invoke<QueryOutcome>("apply_query", { tabId, request });
      dispatch({ type: "QUERY_RUN_SUCCESS", payload: { tabId, outcome } });
      // Sort-only re-applies (see App.tsx's handleSortChange) pass
      // recordHistory: false — clicking a column header shouldn't push a
      // "1=1" placeholder predicate into the where history.
      if (options.recordHistory !== false) {
        const entry = request.mode === "where" ? request.predicate : request.sql;
        dispatch({ type: "HISTORY_PUSH", payload: { tabId, mode: request.mode, entry } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "QUERY_RUN_ERROR", payload: { tabId, message: msg } });
    }
  };

  const previewQuery = async (tabId: string, request: QueryRequest) => {
    const requestId = ++latestRequestIdRef.current;
    try {
      const preview = await invoke<PreviewState>("preview_query", { tabId, request, requestId });
      if (requestId !== latestRequestIdRef.current) return;
      dispatch({
        type: "QUERY_PREVIEW_UPDATE",
        payload: { tabId, preview: { ...preview, error: null } },
      });
    } catch (err) {
      if (requestId !== latestRequestIdRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "QUERY_PREVIEW_ERROR", payload: { tabId, message: msg } });
    }
  };

  const clearQuery = async (tabId: string) => {
    try {
      const outcome = await invoke<QueryOutcome>("clear_query", { tabId });
      dispatch({ type: "QUERY_CLEAR", payload: { tabId, outcome } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_ERROR", payload: `Clear failed: ${msg}` });
    }
  };

  return { applyQuery, previewQuery, clearQuery };
}
