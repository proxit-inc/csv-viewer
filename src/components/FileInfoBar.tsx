import type { FileMetadata } from "../types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function delimLabel(delim: string): string {
  if (delim === ",") return "Comma (,)";
  if (delim === "\t") return "Tab";
  if (delim === ";") return "Semicolon (;)";
  return delim;
}

interface FileInfoBarProps {
  metadata: FileMetadata;
}

export function FileInfoBar({ metadata }: FileInfoBarProps) {
  return (
    <div
      className="flex items-center gap-3 px-3 border-b text-xs overflow-x-auto"
      style={{
        height: "var(--h-fileinfo)",
        background: "var(--col-surface)",
        borderColor: "var(--col-border)",
        color: "var(--col-text2)",
        scrollbarWidth: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: "var(--col-text)" }} className="font-medium">
        {metadata.filename}
      </span>
      <Sep />
      <span>{metadata.totalRows.toLocaleString()} rows</span>
      <Sep />
      <span>{metadata.totalColumns} columns</span>
      <Sep />
      <span>{metadata.encoding}</span>
      <Sep />
      <span>{delimLabel(metadata.delimiter)}</span>
      <Sep />
      <span>{formatBytes(metadata.fileSize)}</span>
    </div>
  );
}

function Sep() {
  return <span style={{ color: "var(--col-border2)" }}>•</span>;
}
