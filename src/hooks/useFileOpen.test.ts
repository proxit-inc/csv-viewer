import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFileOpen } from "./useFileOpen";
import type { FileMetadata } from "../types";

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

describe("useFileOpen", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
  });

  it("opens the native dialog when no forcePath is given, and does nothing if it's cancelled", async () => {
    openMock.mockResolvedValue(null);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useFileOpen(dispatch));

    await act(async () => {
      await result.current.openFile("tab-1");
    });

    expect(openMock).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches TAB_ADD then TAB_METADATA_LOADED on success, skipping the dialog when forcePath is given", async () => {
    const metadata: FileMetadata = {
      filename: "data.csv",
      filePath: "/tmp/data.csv",
      fileSize: 1234,
      totalRows: 5,
      totalColumns: 2,
      encoding: "UTF-8",
      delimiter: ",",
      headers: ["id", "name"],
    };
    invokeMock.mockResolvedValue(metadata);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useFileOpen(dispatch));

    await act(async () => {
      await result.current.openFile("tab-1", "/tmp/data.csv");
    });

    expect(openMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "TAB_ADD",
        payload: expect.objectContaining({ id: "tab-1" }),
      }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "TAB_METADATA_LOADED",
      payload: { tabId: "tab-1", metadata },
    });
  });

  it("dispatches TAB_CLOSE then SET_ERROR when open_csv_file rejects", async () => {
    invokeMock.mockRejectedValue(new Error("bad file"));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useFileOpen(dispatch));

    await act(async () => {
      await result.current.openFile("tab-1", "/tmp/bad.csv");
    });

    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "TAB_CLOSE", payload: { tabId: "tab-1" } });
    expect(dispatch).toHaveBeenNthCalledWith(3, {
      type: "SET_ERROR",
      payload: "Failed to open file: bad file",
    });
  });
});
