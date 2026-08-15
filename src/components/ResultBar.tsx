import type { FileMetadata, QueryOutcome } from "../types";

interface ResultBarProps {
  metadata: FileMetadata;
  resultView: QueryOutcome | null;
  onReset: () => void;
}

// Always rendered once a file is loaded (not just after a query is applied)
// so `csv_data` — the table name a user must know to write a sql-mode query
// — is visible on screen from the moment the file opens, per
// docs/SEARCH_ARCHITECTURE.md §3-3's "csv_data (100,000 rows) → filtered
// (1,234 rows)" baseline-to-narrowed design.
export function ResultBar({ metadata, resultView, onReset }: ResultBarProps) {
  return (
    <div
      className="flex items-center justify-between px-3 py-1 text-xs border-b shrink-0"
      style={{
        background: "var(--col-surface2)",
        borderColor: "var(--col-border)",
        color: "var(--col-text2)",
      }}
    >
      {resultView ? (
        <span>
          {metadata.totalRows.toLocaleString()} rows → {resultView.description} (
          {resultView.totalRows.toLocaleString()} rows) · {resultView.elapsedMs}ms
          {resultView.truncated && (
            <span style={{ color: "#B45309" }}>
              {" "}
              · truncated at {resultView.totalRows.toLocaleString()} rows
            </span>
          )}
        </span>
      ) : (
        <span>csv_data ({metadata.totalRows.toLocaleString()} rows)</span>
      )}
      {resultView && (
        <button onClick={onReset} className="underline shrink-0">
          Reset
        </button>
      )}
    </div>
  );
}
