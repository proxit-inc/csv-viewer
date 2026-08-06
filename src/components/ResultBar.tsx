import type { FileMetadata, QueryOutcome } from "../types";

interface ResultBarProps {
  metadata: FileMetadata;
  resultView: QueryOutcome;
  onReset: () => void;
}

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
      <button onClick={onReset} className="underline shrink-0">
        Reset
      </button>
    </div>
  );
}
