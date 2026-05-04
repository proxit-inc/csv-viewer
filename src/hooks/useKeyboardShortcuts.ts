import { useEffect } from "react";

interface Options {
  onOpen: () => void;
  onSearch: () => void;
  onSearchClose: () => void;
  onCloseTab: () => void;
  onSwitchTab: (index: number) => void;
}

export function useKeyboardShortcuts(opts: Options) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey;
      const key = e.key;

      if (meta && key === "o") {
        e.preventDefault();
        opts.onOpen();
      } else if (meta && key === "f") {
        e.preventDefault();
        opts.onSearch();
      } else if (key === "Escape") {
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
