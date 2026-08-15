import { NoticeBar } from "./NoticeBar";

interface LargeFileNoticeProps {
  totalRows: number;
  onClose: () => void;
  onDismiss: () => void;
}

export function LargeFileNotice({ totalRows, onClose, onDismiss }: LargeFileNoticeProps) {
  return (
    <NoticeBar
      tone="warning"
      message={`⚠ ${totalRows.toLocaleString()} rows — large files may scroll and query slowly.`}
      onDismiss={onDismiss}
    >
      <button onClick={onClose} className="underline shrink-0">
        Close file
      </button>
    </NoticeBar>
  );
}
