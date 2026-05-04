import { useMemo, useEffect, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridReadyEvent } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import type { SearchHit } from "../../types";
import { createDatasource } from "./datasource";

interface DataGridProps {
  headers: string[];
  totalRows: number;
  tabId: string;
  searchHits: SearchHit[];
  currentHitIndex: number;
  initialScrollOffset?: number;
  onScrollSave: (offset: number) => void;
}

export function DataGrid({
  headers,
  totalRows,
  tabId,
  initialScrollOffset = 0,
  onScrollSave,
}: DataGridProps) {
  const gridRef = useRef<AgGridReact>(null);
  const datasource = useMemo(() => createDatasource(tabId), [tabId]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        headerName: "#",
        field: "__rowNum",
        width: 52,
        pinned: "left" as const,
        resizable: false,
        sortable: false,
        cellStyle: {
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          color: "var(--col-text3)",
          backgroundColor: "var(--col-row-num)",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingRight: "10px",
        },
      },
      ...headers.map((header, idx) => ({
        headerName: header,
        field: `col_${idx}`,
        width: 150,
        resizable: true,
        sortable: false,
        filter: false,
        cellStyle: {
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
        },
      })),
    ],
    [headers]
  );

  const onGridReady = (params: GridReadyEvent) => {
    params.api.setGridOption("datasource", datasource);
    if (initialScrollOffset > 0) {
      params.api.ensureIndexVisible(initialScrollOffset);
    }
  };

  useEffect(() => {
    gridRef.current?.api?.setGridOption("datasource", datasource);
  }, [datasource]);

  return (
    <div
      className="ag-theme-alpine flex-1"
      style={
        {
          "--ag-header-background-color": "var(--col-header-bg)",
          "--ag-background-color": "var(--col-row-even)",
          "--ag-odd-row-background-color": "var(--col-row-odd)",
          "--ag-row-hover-color": "var(--col-row-hover)",
          "--ag-border-color": "var(--col-cell-border)",
          "--ag-header-column-separator-color": "var(--col-border)",
          "--ag-font-size": "12px",
          "--ag-row-height": "var(--h-data-row)",
          "--ag-header-height": "var(--h-header-row)",
          "--ag-cell-horizontal-padding": "8px",
          height: "100%",
        } as React.CSSProperties
      }
    >
      <AgGridReact
        ref={gridRef}
        rowModelType="infinite"
        datasource={datasource}
        columnDefs={columnDefs}
        defaultColDef={{ resizable: true, sortable: false }}
        cacheBlockSize={200}
        cacheOverflowSize={2}
        maxConcurrentDatasourceRequests={1}
        infiniteInitialRowCount={totalRows}
        maxBlocksInCache={20}
        rowHeight={28}
        headerHeight={34}
        suppressCellFocus={true}
        enableCellTextSelection={true}
        onGridReady={onGridReady}
        onBodyScroll={(e) => onScrollSave(e.api.getFirstDisplayedRowIndex())}
      />
    </div>
  );
}
