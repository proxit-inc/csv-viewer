import { FileSpreadsheet } from "lucide-react";

interface EmptyStateProps {
  onOpen: () => void;
}

export function EmptyState({ onOpen }: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center flex-1 gap-4"
      style={{ color: "var(--col-text3)" }}
    >
      <FileSpreadsheet size={48} strokeWidth={1} />
      <div className="text-center">
        <p className="text-sm font-medium" style={{ color: "var(--col-text2)" }}>
          No file open
        </p>
        <p className="text-xs mt-1">Drag & drop a CSV file here, or click Open</p>
      </div>
      <button
        onClick={onOpen}
        className="px-4 py-2 rounded text-sm font-medium text-white transition-colors"
        style={{ background: "var(--col-accent)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--col-accent-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--col-accent)")}
      >
        Open file (⌘O)
      </button>
    </div>
  );
}
