import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

// Shared by the query preview panel's "Copy as TSV" button and the
// where/sql error banners' "Copy error" button — same copy+flash-feedback
// behavior, just a different clipboard payload.
export function CopyButton({ text, label = "Copy", className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-black/10 shrink-0 ${className}`}
      title={label}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copied" : label}
    </button>
  );
}
