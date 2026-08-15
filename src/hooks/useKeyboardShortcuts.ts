import { useEffect } from "react";

interface Options {
  onOpen: () => void;
  onSearch: () => void;
  onSearchSql: () => void;
  onSearchClose: () => void;
  onCloseTab: () => void;
  onSwitchTab: (index: number) => void;
}

export function useKeyboardShortcuts(opts: Options) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey;
      const key = e.key.toLowerCase();

      if (meta && key === "o") {
        e.preventDefault();
        opts.onOpen();
      } else if (meta && e.shiftKey && key === "f") {
        // Checked before the plain ⌘F branch, and shiftKey is checked
        // explicitly rather than relying on `e.key`'s case (which varies by
        // keyboard layout) to distinguish ⌘F from ⌘⇧F.
        e.preventDefault();
        opts.onSearchSql();
      } else if (meta && key === "f") {
        e.preventDefault();
        opts.onSearch();
      } else if (e.key === "Escape") {
        opts.onSearchClose();
      } else if (meta && key === "w") {
        e.preventDefault();
        opts.onCloseTab();
      } else if (meta && key >= "1" && key <= "9") {
        e.preventDefault();
        opts.onSwitchTab(parseInt(key, 10) - 1);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [opts]);
}
