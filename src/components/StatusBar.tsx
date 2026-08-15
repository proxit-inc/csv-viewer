import type { CsvTab } from "../types";

interface StatusBarProps {
  activeTab: CsvTab | null;
  tabCount: number;
  appVersion: string;
}

export function StatusBar({ activeTab, tabCount, appVersion }: StatusBarProps) {
  const status = activeTab?.isLoading ? "Loading..." : activeTab?.metadata ? "Ready" : "No file";

  const rowInfo = activeTab?.metadata
    ? `${activeTab.metadata.totalRows.toLocaleString()} rows total`
    : "";

  return (
    <div
      className="flex items-center justify-between px-3 border-t text-xs shrink-0"
      style={{
        height: "var(--h-statusbar)",
        background: "var(--col-surface2)",
        borderColor: "var(--col-border)",
        color: "var(--col-text3)",
      }}
    >
      <div className="flex items-center gap-3">
        <span>{status}</span>
        {rowInfo && <span>{rowInfo}</span>}
      </div>
      <div className="flex items-center gap-3">
        <span>{tabCount > 0 ? `${tabCount} tab${tabCount > 1 ? "s" : ""}` : ""}</span>
        {appVersion && <span>v{appVersion}</span>}
      </div>
    </div>
  );
}
