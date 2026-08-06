import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import type { AppAction, CsvTab, QueryMode } from "../types";
import { useSearch } from "../hooks/useSearch";
import { useQuery } from "../hooks/useQuery";
import { useDebounce } from "../hooks/useDebounce";
import { QueryPreviewPanel } from "./QueryPreviewPanel";

// Dynamically imported: CodeMirror is only worth its ~60-80KB gz cost once
// the user actually opens sql mode (docs/SEARCH_ARCHITECTURE.md §3-1).
const SqlEditor = lazy(() => import("./SqlEditor").then((m) => ({ default: m.SqlEditor })));

interface SearchBarProps {
  tab: CsvTab;
  dispatch: React.Dispatch<AppAction>;
  onClose: () => void;
}

const MODES: { mode: QueryMode; label: string }[] = [
  { mode: "text", label: "Text" },
  { mode: "where", label: "Where" },
  { mode: "sql", label: "SQL" },
];

export function SearchBar({ tab, dispatch, onClose }: SearchBarProps) {
  const {
    id: tabId,
    searchMode: mode,
    searchQuery,
    searchHits: hits,
    searchHitIndex: currentIndex,
    searchTruncated: truncated,
    queryDrafts,
    queryStatus,
    preview,
    metadata,
    resultView,
    queryHistory,
  } = tab;

  const inputRef = useRef<HTMLInputElement>(null);
  const { search } = useSearch(dispatch);
  const { applyQuery, previewQuery } = useQuery(dispatch);

  // Local value updates instantly for responsive typing; the backend call is
  // debounced. Kept per-mode so switching modes doesn't clobber whatever the
  // user typed in the other editor.
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const debouncedSearch = useDebounce(search, 300);

  const [localWhere, setLocalWhere] = useState(queryDrafts.where);
  const debouncedWherePreview = useDebounce(
    (predicate: string) => previewQuery(tabId, { mode: "where", predicate, sort: [] }),
    200,
  );

  // `null` = editing fresh (not browsing history); an index into
  // `queryHistory.where` while cycling back with ↑/↓. A single-line input
  // has no "cursor is at the first/last line" ambiguity the way a multi-line
  // editor would, so arrow keys can always mean "browse history" here.
  const [whereHistoryIndex, setWhereHistoryIndex] = useState<number | null>(null);

  const [localSql, setLocalSql] = useState(queryDrafts.sql);
  const debouncedSqlPreview = useDebounce(
    (sql: string) => previewQuery(tabId, { mode: "sql", sql }),
    200,
  );

  useEffect(() => {
    if (mode !== "sql") inputRef.current?.focus();
  }, [mode]);

  // Sync if the draft/query is reset externally (e.g. tab switch, Reset).
  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    setLocalWhere(queryDrafts.where);
  }, [queryDrafts.where]);

  useEffect(() => {
    setLocalSql(queryDrafts.sql);
  }, [queryDrafts.sql]);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalQuery(e.target.value);
    debouncedSearch(tabId, e.target.value);
  };

  const handleWhereChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLocalWhere(value);
    setWhereHistoryIndex(null);
    dispatch({ type: "QUERY_DRAFT_SET", payload: { tabId, mode: "where", draft: value } });
    if (value.trim()) debouncedWherePreview(value);
  };

  const navigateWhereHistory = (delta: 1 | -1) => {
    const history = queryHistory.where;
    if (history.length === 0) return;
    if (delta === 1) {
      // Older: from fresh editing, start at the most recent entry; from
      // partway through, step further back.
      const next =
        whereHistoryIndex === null ? 0 : Math.min(whereHistoryIndex + 1, history.length - 1);
      setWhereHistoryIndex(next);
      setLocalWhere(history[next]);
    } else if (whereHistoryIndex !== null) {
      // Newer: step forward, or back out to the in-progress draft once past
      // the most recent history entry.
      if (whereHistoryIndex === 0) {
        setWhereHistoryIndex(null);
        setLocalWhere(queryDrafts.where);
      } else {
        const next = whereHistoryIndex - 1;
        setWhereHistoryIndex(next);
        setLocalWhere(history[next]);
      }
    }
  };

  const handleSqlChange = (value: string) => {
    setLocalSql(value);
    dispatch({ type: "QUERY_DRAFT_SET", payload: { tabId, mode: "sql", draft: value } });
    if (value.trim()) debouncedSqlPreview(value);
  };

  const applyWhere = () => {
    if (!localWhere.trim()) return;
    applyQuery(tabId, { mode: "where", predicate: localWhere, sort: [] });
  };

  const applySql = () => {
    if (!localSql.trim()) return;
    applyQuery(tabId, { mode: "sql", sql: localSql });
  };

  const navigate = (delta: number) => {
    if (hits.length === 0) return;
    const next = (currentIndex + delta + hits.length) % hits.length;
    dispatch({ type: "SEARCH_NAVIGATE", payload: { tabId, index: next } });
  };

  const sqlSchema = {
    csv_data: metadata?.headers ?? [],
    csv_result: resultView?.columns ?? [],
  };

  return (
    <div
      className="flex flex-col border-b"
      style={{ background: "var(--col-surface)", borderColor: "var(--col-border)" }}
    >
      <div className="flex items-center gap-2 px-3" style={{ height: "var(--h-searchbar)" }}>
        <div className="flex gap-0.5 shrink-0">
          {MODES.map(({ mode: m, label }) => (
            <button
              key={m}
              onClick={() => dispatch({ type: "SEARCH_MODE_SET", payload: { tabId, mode: m } })}
              className="px-2 py-0.5 text-xs rounded"
              style={{
                background: mode === m ? "var(--col-row-hover)" : "transparent",
                color: "var(--col-text2)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <Search size={14} style={{ color: "var(--col-text3)" }} />

        {mode === "text" && (
          <input
            ref={inputRef}
            type="text"
            value={localQuery}
            onChange={handleTextChange}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") onClose();
            }}
            placeholder="Search..."
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: "var(--col-text)" }}
          />
        )}

        {mode === "where" && (
          <>
            <span className="text-xs shrink-0" style={{ color: "var(--col-text3)" }}>
              WHERE
            </span>
            <input
              ref={inputRef}
              type="text"
              value={localWhere}
              onChange={handleWhereChange}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) applyWhere();
                if (e.key === "Escape") onClose();
                if (e.key === "ArrowUp") {
                  navigateWhereHistory(1);
                  e.preventDefault();
                }
                if (e.key === "ArrowDown") {
                  navigateWhereHistory(-1);
                  e.preventDefault();
                }
              }}
              placeholder="amount > 1000 AND city LIKE '%Tokyo%'"
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: "var(--col-text)", fontFamily: "var(--font-mono)" }}
            />
          </>
        )}

        {mode === "sql" && <span className="flex-1" />}

        {mode === "text" && (
          <span className="text-xs shrink-0" style={{ color: "var(--col-text3)" }}>
            {hits.length > 0
              ? `${currentIndex + 1} / ${hits.length}${truncated ? "+" : ""}`
              : localQuery
                ? "0 results"
                : ""}
          </span>
        )}

        {(mode === "where" || mode === "sql") && (
          <span className="text-xs shrink-0" style={{ color: "var(--col-text3)" }}>
            {queryStatus.state === "running" ? "Applying…" : "⌘Enter to apply"}
          </span>
        )}

        {mode === "text" && (
          <>
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
          </>
        )}

        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-black/10"
          style={{ color: "var(--col-text2)" }}
          title="Close (Esc)"
        >
          <X size={14} />
        </button>
      </div>

      {mode === "sql" && (
        <div className="border-t" style={{ borderColor: "var(--col-border)", height: "80px" }}>
          <Suspense
            fallback={
              <div className="px-3 py-2 text-xs" style={{ color: "var(--col-text3)" }}>
                Loading editor…
              </div>
            }
          >
            <SqlEditor
              value={localSql}
              onChange={handleSqlChange}
              onApply={applySql}
              onClose={onClose}
              schema={sqlSchema}
            />
          </Suspense>
        </div>
      )}

      {(mode === "where" || mode === "sql") && queryStatus.state === "error" && (
        <div className="px-3 pb-1 text-xs" style={{ color: "#DC2626" }}>
          {queryStatus.message}
        </div>
      )}

      {mode === "where" && localWhere.trim() && <QueryPreviewPanel preview={preview} />}
      {mode === "sql" && localSql.trim() && <QueryPreviewPanel preview={preview} />}
    </div>
  );
}
