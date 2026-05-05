import { Plus } from "lucide-react";
import { Tab } from "./Tab";

interface TabItem {
  id: string;
  filename: string;
}

interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string | null;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onAdd }: TabBarProps) {
  return (
    <div
      className="flex items-end overflow-x-auto border-b"
      style={{
        height: "var(--h-tab)",
        background: "var(--col-surface)",
        borderColor: "var(--col-border)",
        scrollbarWidth: "none",
      }}
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          id={tab.id}
          filename={tab.filename}
          isActive={tab.id === activeTabId}
          onSwitch={() => onSwitch(tab.id)}
          onClose={() => onClose(tab.id)}
        />
      ))}

      <button
        onClick={onAdd}
        className="flex items-center justify-center w-8 h-6 shrink-0 rounded hover:bg-black/10 transition-colors self-center ml-1"
        style={{ color: "var(--col-text3)" }}
        title="Open new file"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
