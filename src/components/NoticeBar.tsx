import type { ReactNode } from "react";

interface NoticeBarProps {
  tone: "warning" | "error";
  message: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
}

const TONE_STYLES: Record<
  NoticeBarProps["tone"],
  { background: string; borderColor: string; color: string }
> = {
  warning: { background: "#FFFBEB", borderColor: "#FDE68A", color: "#92400E" },
  error: { background: "#FEF2F2", borderColor: "#FECACA", color: "#991B1B" },
};

export function NoticeBar({ tone, message, children, onDismiss }: NoticeBarProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2 text-xs border-b shrink-0"
      style={TONE_STYLES[tone]}
    >
      <span className="flex items-center gap-2 flex-wrap">
        <span>{message}</span>
        {children}
      </span>
      {onDismiss && (
        <button onClick={onDismiss} className="ml-4 underline shrink-0">
          Dismiss
        </button>
      )}
    </div>
  );
}
