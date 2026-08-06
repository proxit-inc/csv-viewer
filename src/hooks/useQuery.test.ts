import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQuery } from "./useQuery";
import type { QueryOutcome, PreviewState } from "../types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("useQuery", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("applyQuery dispatches QUERY_RUN_START then QUERY_RUN_SUCCESS", async () => {
    const outcome: QueryOutcome = {
      generation: 1,
      columns: ["a"],
      totalRows: 5,
      truncated: false,
      hasSourceRowId: true,
      elapsedMs: 3,
      description: "filtered",
    };
    invokeMock.mockResolvedValue(outcome);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useQuery(dispatch));

    await act(async () => {
      await result.current.applyQuery("tab-1", { mode: "where", predicate: "1=1", sort: [] });
    });

    expect(dispatch).toHaveBeenCalledWith({ type: "QUERY_RUN_START", payload: { tabId: "tab-1" } });
    expect(dispatch).toHaveBeenCalledWith({
      type: "QUERY_RUN_SUCCESS",
      payload: { tabId: "tab-1", outcome },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "HISTORY_PUSH",
      payload: { tabId: "tab-1", mode: "where", entry: "1=1" },
    });
  });

  it("applyQuery skips HISTORY_PUSH when recordHistory is false", async () => {
    const outcome: QueryOutcome = {
      generation: 1,
      columns: ["a"],
      totalRows: 5,
      truncated: false,
      hasSourceRowId: true,
      elapsedMs: 3,
      description: "filtered",
    };
    invokeMock.mockResolvedValue(outcome);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useQuery(dispatch));

    await act(async () => {
      await result.current.applyQuery(
        "tab-1",
        { mode: "where", predicate: "1=1", sort: [] },
        { recordHistory: false },
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "HISTORY_PUSH" }));
  });

  it("applyQuery sends a sql-mode request shape unchanged to the backend", async () => {
    const outcome: QueryOutcome = {
      generation: 1,
      columns: ["city", "n"],
      totalRows: 3,
      truncated: false,
      hasSourceRowId: false,
      elapsedMs: 5,
      description: "sql",
    };
    invokeMock.mockResolvedValue(outcome);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useQuery(dispatch));
    const request = {
      mode: "sql" as const,
      sql: "SELECT city, count(*) AS n FROM csv_data GROUP BY city",
    };

    await act(async () => {
      await result.current.applyQuery("tab-1", request);
    });

    expect(invokeMock).toHaveBeenCalledWith("apply_query", { tabId: "tab-1", request });
  });

  it("applyQuery dispatches QUERY_RUN_ERROR (not SET_ERROR) on failure", async () => {
    invokeMock.mockRejectedValue(new Error("syntax error"));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useQuery(dispatch));

    await act(async () => {
      await result.current.applyQuery("tab-1", { mode: "where", predicate: "bad(", sort: [] });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "QUERY_RUN_ERROR",
      payload: { tabId: "tab-1", message: "syntax error" },
    });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "SET_ERROR" }));
  });

  it("previewQuery drops a stale response that resolves after a newer request", async () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() => useQuery(dispatch));

    let resolveFirst!: (value: PreviewState) => void;
    invokeMock.mockImplementationOnce(
      () => new Promise<PreviewState>((resolve) => (resolveFirst = resolve)),
    );
    const second: PreviewState = {
      requestId: 2,
      columns: ["b"],
      rows: [["2"]],
      elapsedMs: 1,
      busy: false,
      error: null,
    };
    invokeMock.mockImplementationOnce(() => Promise.resolve(second));

    const firstCall = result.current.previewQuery("tab-1", {
      mode: "where",
      predicate: "a",
      sort: [],
    });
    const secondCall = result.current.previewQuery("tab-1", {
      mode: "where",
      predicate: "ab",
      sort: [],
    });

    await act(async () => {
      await secondCall;
      resolveFirst({
        requestId: 1,
        columns: ["a"],
        rows: [["1"]],
        elapsedMs: 1,
        busy: false,
        error: null,
      });
      await firstCall;
    });

    const previewUpdates = dispatch.mock.calls.filter(
      ([action]) => action.type === "QUERY_PREVIEW_UPDATE",
    );
    expect(previewUpdates).toHaveLength(1);
    expect(previewUpdates[0][0].payload.preview.requestId).toBe(2);
  });

  it("clearQuery dispatches QUERY_CLEAR with the returned outcome", async () => {
    const outcome: QueryOutcome = {
      generation: 2,
      columns: ["a", "b"],
      totalRows: 100,
      truncated: false,
      hasSourceRowId: true,
      elapsedMs: 0,
      description: "csv_data",
    };
    invokeMock.mockResolvedValue(outcome);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useQuery(dispatch));

    await act(async () => {
      await result.current.clearQuery("tab-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "QUERY_CLEAR",
      payload: { tabId: "tab-1", outcome },
    });
  });
});
