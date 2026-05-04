interface TitleBarProps {
  filename: string | null;
}

export function TitleBar({ filename }: TitleBarProps) {
  return (
    <div
      className="flex items-center"
      data-tauri-drag-region
      style={{ height: "var(--h-titlebar)", background: "var(--col-surface)" }}
    >
      <div style={{ width: 72 }} />
      <span
        className="flex-1 text-center text-xs truncate"
        style={{ color: "var(--col-text2)" }}
        data-tauri-drag-region
      >
        {filename ? `${filename} — CSV Viewer` : "CSV Viewer"}
      </span>
    </div>
  );
}
