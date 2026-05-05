import { FolderOpen, Search, ArrowUpDown, Filter } from "lucide-react";

interface ToolbarProps {
  onOpen: () => void;
  onSearch: () => void;
  hasFile: boolean;
}

export function Toolbar({ onOpen, onSearch, hasFile }: ToolbarProps) {
  return (
    <div
      className="flex items-center gap-1 px-2 border-b"
      style={{
        height: "var(--h-toolbar)",
        background: "var(--col-surface)",
        borderColor: "var(--col-border)",
      }}
    >
      <button
        onClick={onOpen}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium hover:bg-white transition-colors"
        style={{ color: "var(--col-text)" }}
        title="Open file (⌘O)"
      >
        <FolderOpen size={14} />
        Open
      </button>

      <div className="w-px h-5 mx-1" style={{ background: "var(--col-border)" }} />

      <button
        onClick={onSearch}
        disabled={!hasFile}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: "var(--col-text)" }}
        title="Search (⌘F)"
      >
        <Search size={14} />
        Search
      </button>

      <button
        disabled
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm opacity-40 cursor-not-allowed"
        style={{ color: "var(--col-text)" }}
        title="Sort (Phase 2)"
      >
        <ArrowUpDown size={14} />
        Sort
      </button>

      <button
        disabled
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm opacity-40 cursor-not-allowed"
        style={{ color: "var(--col-text)" }}
        title="Filter (Phase 2)"
      >
        <Filter size={14} />
        Filter
      </button>
    </div>
  );
}
