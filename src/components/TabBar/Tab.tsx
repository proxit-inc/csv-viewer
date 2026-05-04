import { X } from "lucide-react";

interface TabProps {
  id: string;
  filename: string;
  isActive: boolean;
  onSwitch: () => void;
  onClose: () => void;
}

export function Tab({ filename, isActive, onSwitch, onClose }: TabProps) {
  return (
    <div
      onClick={onSwitch}
      className="group relative flex items-center gap-1 px-3 cursor-pointer select-none shrink-0"
      style={{
        height: isActive ? "var(--h-tab)" : "calc(var(--h-tab) - 2px)",
        maxWidth: 200,
        minWidth: 80,
        background: isActive ? "var(--col-bg)" : "var(--col-surface2)",
        borderLeft: "1px solid var(--col-border)",
        borderRight: "1px solid var(--col-border)",
        borderTop: isActive ? "2px solid var(--col-accent)" : "2px solid transparent",
        marginBottom: isActive ? 0 : 2,
        alignSelf: "flex-end",
      }}
    >
      <span
        className="flex-1 truncate text-xs"
        style={{ color: isActive ? "var(--col-text)" : "var(--col-text2)" }}
      >
        {filename}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="flex items-center justify-center w-4 h-4 rounded hover:bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
        style={{ color: "var(--col-text2)" }}
        title="Close tab"
      >
        <X size={10} />
      </button>
    </div>
  );
}
