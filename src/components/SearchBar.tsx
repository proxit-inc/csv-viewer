import { useEffect, useRef, useState } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import type { SearchHit, AppAction } from "../types";
import { useSearch } from "../hooks/useSearch";
import { useDebounce } from "../hooks/useDebounce";

interface SearchBarProps {
  tabId: string;
  query: string;
  hits: SearchHit[];
  currentIndex: number;
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
}

export function SearchBar({ tabId, query, hits, currentIndex, dispatch, onClose }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { search } = useSearch(dispatch);

  // Local value updates immediately for responsive typing;
  // the actual search is debounced to avoid hammering the backend.
  const [localQuery, setLocalQuery] = useState(query);
  const debouncedSearch = useDebounce(search, 300);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Sync if query is reset externally (e.g. tab switch).
  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalQuery(e.target.value);
    debouncedSearch(tabId, e.target.value);
  };

  const navigate = (delta: number) => {
    if (hits.length === 0) return;
    const next = (currentIndex + delta + hits.length) % hits.length;
    dispatch({ type: "SEARCH_NAVIGATE", payload: { tabId, index: next } });
  };

  return (
    <div
      className="flex items-center gap-2 px-3 border-b"
      style={{
        height: "var(--h-searchbar)",
        background: "var(--col-surface)",
        borderColor: "var(--col-border)",
      }}
    >
      <Search size={14} style={{ color: "var(--col-text3)" }} />

      <input
        ref={inputRef}
        type="text"
        value={localQuery}
        onChange={handleChange}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") onClose();
        }}
        placeholder="Search..."
        className="flex-1 bg-transparent outline-none text-sm"
        style={{ color: "var(--col-text)" }}
      />

      <span className="text-xs shrink-0" style={{ color: "var(--col-text3)" }}>
        {hits.length > 0 ? `${currentIndex + 1} / ${hits.length}` : localQuery ? "0 results" : ""}
      </span>

      <button
        onClick={() => navigate(-1)}
        disabled={hits.length === 0}
        className="p-0.5 rounded hover:bg-black/10 disabled:opacity-40"
        title="Previous (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => navigate(1)}
        disabled={hits.length === 0}
        className="p-0.5 rounded hover:bg-black/10 disabled:opacity-40"
        title="Next (Enter)"
      >
        <ChevronDown size={14} />
      </button>

      <button
        onClick={onClose}
        className="p-0.5 rounded hover:bg-black/10"
        style={{ color: "var(--col-text2)" }}
        title="Close (Esc)"
      >
        <X size={14} />
      </button>
    </div>
  );
}
