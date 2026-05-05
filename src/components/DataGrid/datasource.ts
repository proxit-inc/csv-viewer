import { invoke } from "@tauri-apps/api/core";
import type { IDatasource, IGetRowsParams } from "ag-grid-community";
import type { DataRange } from "../../types";

export function createDatasource(tabId: string): IDatasource {
  let latestReqId = 0;

  return {
    getRows: async (params: IGetRowsParams) => {
      const reqId = ++latestReqId;

      try {
        const result = await invoke<DataRange>("get_csv_data_range", {
          tabId,
          startRow: params.startRow,
          endRow: params.endRow,
        });

        if (reqId !== latestReqId) return;

        const rowData = result.rows.map((row, idx) => ({
          __rowNum: String(params.startRow + idx + 1),
          ...row.reduce<Record<string, string>>((acc, cell, ci) => {
            acc[`col_${ci}`] = cell;
            return acc;
          }, {}),
        }));

        params.successCallback(rowData, result.totalRows);
      } catch (err) {
        console.error("Datasource error:", err);
        params.failCallback();
      }
    },
  };
}
