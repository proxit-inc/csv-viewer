import { invoke } from "@tauri-apps/api/core";
import type { IDatasource, IGetRowsParams } from "ag-grid-community";
import type { DataRange } from "../../types";

interface CommandErrorLike {
  code?: string;
  message?: string;
}

export function createDatasource(
  tabId: string,
  generation: number,
  onFetchStatus: (error: string | null) => void,
): IDatasource {
  let latestReqId = 0;

  return {
    getRows: async (params: IGetRowsParams) => {
      const reqId = ++latestReqId;

      try {
        const result = await invoke<DataRange>("get_csv_data_range", {
          tabId,
          startRow: params.startRow,
          endRow: params.endRow,
          generation,
        });

        if (reqId !== latestReqId) return;
        // Silent discard (docs/SEARCH_ARCHITECTURE.md §2-3): the backend
        // always answers from whatever view is current and echoes that
        // view's generation back rather than rejecting a stale request, so
        // a mismatch here is an ordinary race with an apply/clear — not a
        // failure. Calling failCallback would trigger AG-Grid's retry path
        // for what is really just a superseded request; the grid is about
        // to remount anyway once `generation` changes in this datasource's
        // own key.
        if (result.generation !== generation) return;

        onFetchStatus(null);

        const rowData = result.rows.map((row, idx) => ({
          __rowNum: String((result.rowIds?.[idx] ?? params.startRow + idx) + 1),
          ...row.reduce<Record<string, string>>((acc, cell, ci) => {
            acc[`col_${ci}`] = cell;
            return acc;
          }, {}),
        }));

        params.successCallback(rowData, result.totalRows);
      } catch (err) {
        console.error("Datasource error:", err);
        const { code, message } = (err as CommandErrorLike) ?? {};
        // "tabNotFound" is the ordinary close/switch race — the tab is
        // already gone, so flagging a connection error on it is both
        // meaningless and impossible to see.
        if (code !== "tabNotFound") {
          onFetchStatus(message ?? (err instanceof Error ? err.message : String(err)));
        }
        params.failCallback();
      }
    },
  };
}
