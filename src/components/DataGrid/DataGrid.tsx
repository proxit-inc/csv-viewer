import { useMemo, useEffect, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridReadyEvent, CellClassParams } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import type { SearchHit } from "../../types";
import { createDatasource } from "./datasource";

// Stable reference: recreating this object on every render makes AG-Grid rebuild
// all columns and discard user-resized widths (issue #7). Defined once at module scope.
const DEFAULT_COL_DEF: ColDef = { resizable: true, sortable: false };

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
  const containerRef = useRef<HTMLDivElement>(null);
  const datasource = useMemo(() => createDatasource(tabId), [tabId]);

  // Always-fresh refs so unmount cleanup never holds stale values.
  const onScrollSaveRef = useRef(onScrollSave);
  const tabIdRef = useRef(tabId);
  useEffect(() => {
    onScrollSaveRef.current = onScrollSave;
    tabIdRef.current = tabId;
  });

  // Stores the current scroll position in PIXELS (not row index) so save/restore
  // is pixel-perfect and unaffected by partial-row rounding in getFirstDisplayedRowIndex().
  const currentScrollPxRef = useRef(initialScrollOffset);

  // Suppress scroll events fired by programmatic restoration for 500 ms.
  const ignoreScrollUntilRef = useRef(0);

  // Save exactly once on unmount (fallback for mid-scroll tab switch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      onScrollSaveRef.current(tabIdRef.current, currentScrollPxRef.current);
    },
    [],
  );

  // Search hit highlighting — refs avoid recreating columnDefs on every update.
  const searchHitsRef = useRef<SearchHit[]>(searchHits);
  const currentHitIndexRef = useRef<number>(currentHitIndex);
  // Set of "row:col" keys, precomputed once per search result so cellStyle can
  // do an O(1) lookup instead of an O(hits) scan per cell per grid refresh
  // (up to 10k hits × every visible cell would otherwise threaten 60fps).
  const hitKeySetRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    searchHitsRef.current = searchHits;
    currentHitIndexRef.current = currentHitIndex;
    hitKeySetRef.current = new Set(searchHits.map((h) => `${h.row}:${h.column}`));

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
          if (hitKeySetRef.current.has(`${rowIdx}:${idx}`)) {
            return { ...base, backgroundColor: "#FEF9C3" };
          }
          return base;
        },
      })),
    ],
    [headers],
  );

  const onGridReady = (params: GridReadyEvent) => {
    params.api.setGridOption("datasource", datasource);
    if (initialScrollOffset > 0) {
      ignoreScrollUntilRef.current = Date.now() + 500;
      currentScrollPxRef.current = initialScrollOffset;
      // Restore by setting scrollTop directly — pixel-perfect, no row-index rounding.
      // requestAnimationFrame ensures the AG Grid viewport element is in the DOM.
      requestAnimationFrame(() => {
        const vp = containerRef.current?.querySelector(".ag-body-viewport") as HTMLElement | null;
        if (vp) vp.scrollTop = initialScrollOffset;
      });
    }
  };

  useEffect(() => {
    gridRef.current?.api?.setGridOption("datasource", datasource);
  }, [datasource]);

  return (
    <div
      ref={containerRef}
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
        defaultColDef={DEFAULT_COL_DEF}
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
        onBodyScroll={(e) => {
          // Keep ref current for the unmount-save fallback (mid-scroll tab switch).
          if (Date.now() <= ignoreScrollUntilRef.current) return;
          currentScrollPxRef.current = e.api.getVerticalPixelRange().top;
        }}
        onBodyScrollEnd={(e) => {
          // Save to state when scrolling settles so the next restoration is exact.
          if (Date.now() <= ignoreScrollUntilRef.current) return;
          const px = e.api.getVerticalPixelRange().top;
          currentScrollPxRef.current = px;
          onScrollSaveRef.current(tabIdRef.current, px);
        }}
      />
    </div>
  );
}
