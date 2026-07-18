import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSearch } from "./useSearch";
import type { SearchResponse } from "../types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("useSearch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("clears hits without calling search_csv when the query is blank", async () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() => useSearch(dispatch));

    await act(async () => {
      await result.current.search("tab-1", "   ");
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "SEARCH_UPDATE",
      payload: { tabId: "tab-1", query: "", hits: [] },
    });
  });

  it("dispatches SEARCH_UPDATE with the returned hits on success", async () => {
    const response: SearchResponse = {
      hits: [{ row: 0, column: 1 }],
      totalCount: 1,
    };
    invokeMock.mockResolvedValue(response);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useSearch(dispatch));

    await act(async () => {
      await result.current.search("tab-1", "needle");
    });

    expect(invokeMock).toHaveBeenCalledWith("search_csv", { tabId: "tab-1", query: "needle" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SEARCH_UPDATE",
      payload: { tabId: "tab-1", query: "needle", hits: response.hits },
    });
  });

  it("dispatches SET_ERROR when search_csv rejects", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useSearch(dispatch));

    await act(async () => {
      await result.current.search("tab-1", "needle");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_ERROR",
      payload: "Search failed: boom",
    });
  });
});
