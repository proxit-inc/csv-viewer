import { useMemo, useEffect, useRef, useCallback } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridReadyEvent, CellClassParams } from "ag-grid-community";
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
  onScrollSave: (tabId: string, offset: number) => void;
}

export function DataGrid({
  headers,
  totalRows,
  tabId,
  searchHits,
  currentHitIndex,
  initialScrollOffset = 0,
  onScrollSave,
}: DataGridProps) {
  const gridRef = useRef<AgGridReact>(null);
  const datasource = useMemo(() => createDatasource(tabId), [tabId]);

  // Always-fresh refs for the unmount cleanup (avoids stale-closure issues).
  const onScrollSaveRef = useRef(onScrollSave);
  const tabIdRef = useRef(tabId);
  useEffect(() => {
    onScrollSaveRef.current = onScrollSave;
    tabIdRef.current = tabId;
  });

  // Track the current first-visible row in a ref only — no state, no re-renders.
  // Initialized to initialScrollOffset so an immediate unmount saves correctly.
  const currentScrollRowRef = useRef(initialScrollOffset);

  // Save once on unmount (tab switch or close). Reading the ref is safe regardless
  // of AG Grid's own cleanup order because the ref lives in DataGrid, not in the grid.
  useEffect(() => {
    return () => {
      onScrollSaveRef.current(tabIdRef.current, currentScrollRowRef.current);
    };
  }, []); // intentional: run cleanup only on unmount

  // Search hit highlighting via refs to avoid recreating columnDefs on every update.
  const searchHitsRef = useRef<SearchHit[]>(searchHits);
  const currentHitIndexRef = useRef<number>(currentHitIndex);

  useEffect(() => {
    searchHitsRef.current = searchHits;
    currentHitIndexRef.current = currentHitIndex;

    const api = gridRef.current?.api;
    if (!api) return;

    api.refreshCells({ force: true });

    if (searchHits.length > 0 && currentHitIndex >= 0) {
      api.ensureIndexVisible(searchHits[currentHitIndex].row, "middle");
    }
  }, [searchHits, currentHitIndex]);

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
        cellStyle: (params: CellClassParams) => {
          const base = { fontFamily: "var(--font-mono)", fontSize: "12px" };
          const rowIdx = params.rowIndex;
          const hits = searchHitsRef.current;
          const curIdx = currentHitIndexRef.current;
          const currentHit = hits[curIdx];

          if (currentHit?.row === rowIdx && currentHit?.column === idx) {
            return { ...base, backgroundColor: "#FDE68A", color: "#92400E" };
          }
          if (hits.some((h) => h.row === rowIdx && h.column === idx)) {
            return { ...base, backgroundColor: "#FEF9C3" };
          }
          return base;
        },
      })),
    ],
    [headers]
  );

  const onGridReady = (params: GridReadyEvent) => {
    params.api.setGridOption("datasource", datasource);
  };

  // Restore scroll position after the first data block has rendered.
  // Using onFirstDataRendered (not onGridReady) ensures the grid can actually
  // scroll — in Infinite Row Model, ensureIndexVisible before data loads is a no-op.
  const onFirstDataRendered = useCallback(() => {
    if (initialScrollOffset > 0 && gridRef.current?.api) {
      gridRef.current.api.ensureIndexVisible(initialScrollOffset, "top");
      // Sync ref so an immediate unmount after restore saves the right row.
      currentScrollRowRef.current = initialScrollOffset;
    }
  }, [initialScrollOffset]);

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
        onFirstDataRendered={onFirstDataRendered}
        onBodyScroll={(e) => {
          // Update ref only — no state dispatch, no debounce.
          // The ref value is flushed to state exactly once on unmount.
          currentScrollRowRef.current = e.api.getFirstDisplayedRowIndex();
        }}
      />
    </div>
  );
}
