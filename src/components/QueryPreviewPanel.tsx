import type { PreviewState } from "../types";
import { CopyButton } from "./CopyButton";

interface QueryPreviewPanelProps {
  preview: PreviewState | null;
}

export function rowsToTsv(columns: string[], rows: string[][]): string {
  return [columns, ...rows].map((row) => row.join("\t")).join("\n");
}

// Dedicated panel below the editor rather than rewriting the main grid on
// every keystroke: the main grid is an AG-Grid infinite row model whose
// scroll position/block cache is tab-persisted state, and rewriting it
// mid-typing would fight that (see docs/SEARCH_ARCHITECTURE.md §3-3).
export function QueryPreviewPanel({ preview }: QueryPreviewPanelProps) {
  if (!preview) return null;

  return (
    <div
      className="border-t overflow-auto text-xs"
      style={{
        borderColor: "var(--col-border)",
        maxHeight: "180px",
        fontFamily: "var(--font-mono)",
      }}
    >
      {preview.error && (
        <div
          className="flex items-start justify-between gap-2 px-3 py-1"
          style={{ color: "#DC2626", background: "#FEF2F2" }}
        >
          <span className="flex-1">{preview.error}</span>
          <CopyButton text={preview.error} label="Copy error" />
        </div>
      )}
      {preview.busy ? (
        <div className="px-3 py-2" style={{ color: "var(--col-text3)" }}>
          Busy…
        </div>
      ) : preview.rows.length === 0 ? (
        <div className="px-3 py-2" style={{ color: "var(--col-text3)" }}>
          No rows
        </div>
      ) : (
        <>
          <div
            className="flex items-center justify-between px-2 py-0.5 sticky top-0"
            style={{ background: "var(--col-surface)", color: "var(--col-text3)" }}
          >
            <span>{preview.rows.length} rows (preview)</span>
            {/* Copies only the fetched preview page (≤100 rows), not the
                full current view — the view can be up to 1M rows, and this
                button exists for a quick "grab what I'm looking at" action,
                not a bulk export (read-only viewer principle: no
                full-dataset export path). */}
            <CopyButton text={rowsToTsv(preview.columns, preview.rows)} label="Copy as TSV" />
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {preview.columns.map((col) => (
                  <th
                    key={col}
                    className="text-left px-2 py-1 border-b sticky top-5"
                    style={{
                      borderColor: "var(--col-border)",
                      color: "var(--col-text3)",
                      background: "var(--col-surface)",
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="px-2 py-0.5 border-b"
                      style={{ borderColor: "var(--col-cell-border)", color: "var(--col-text)" }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
