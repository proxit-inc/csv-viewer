import { useState } from "react";
import { NoticeBar } from "./NoticeBar";
import { ENCODING_OPTIONS } from "../types";

interface EncodingNoticeProps {
  currentEncoding: string;
  wasOverridden: boolean;
  onReload: (label: string) => void;
  onDismiss: () => void;
}

export function EncodingNotice({
  currentEncoding,
  wasOverridden,
  onReload,
  onDismiss,
}: EncodingNoticeProps) {
  const initial = ENCODING_OPTIONS.find((o) => o.name === currentEncoding)?.label ?? "utf-8";
  const [selected, setSelected] = useState<string>(initial);

  const message = wasOverridden
    ? `⚠ Reading this file as ${currentEncoding} (manually selected) — if this still looks wrong, try another encoding below.`
    : `⚠ Encoding detection was uncertain — reading this file as ${currentEncoding}.`;

  return (
    <NoticeBar tone="warning" message={message} onDismiss={onDismiss}>
      <span>Reopen as</span>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="text-xs px-1 py-0.5 border rounded"
        style={{ background: "var(--col-bg)", borderColor: "var(--col-border)" }}
      >
        {ENCODING_OPTIONS.map((opt) => (
          <option key={opt.label} value={opt.label}>
            {opt.display}
          </option>
        ))}
      </select>
      <button onClick={() => onReload(selected)} className="underline shrink-0">
        Reload
      </button>
    </NoticeBar>
  );
}
