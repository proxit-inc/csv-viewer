import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDatasource } from "./datasource";
import type { DataRange } from "../../types";
import type { IGetRowsParams } from "ag-grid-community";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function makeParams(overrides: Partial<IGetRowsParams> = {}): IGetRowsParams {
  return {
    startRow: 0,
    endRow: 10,
    successCallback: vi.fn(),
    failCallback: vi.fn(),
    sortModel: [],
    filterModel: {},
    context: {},
    ...overrides,
  } as unknown as IGetRowsParams;
}

describe("createDatasource", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("discards a response whose generation does not match the datasource's own", async () => {
    const range: DataRange = { rows: [["x"]], totalRows: 1, generation: 999, rowIds: null };
    invokeMock.mockResolvedValue(range);
    const onFetchStatus = vi.fn();

    const datasource = createDatasource("tab-1", 5, onFetchStatus);
    const params = makeParams();
    await datasource.getRows(params);

    expect(params.successCallback).not.toHaveBeenCalled();
    expect(params.failCallback).not.toHaveBeenCalled();
    expect(onFetchStatus).not.toHaveBeenCalled();
  });

  it("accepts a response whose generation matches", async () => {
    const range: DataRange = { rows: [["x"]], totalRows: 1, generation: 5, rowIds: null };
    invokeMock.mockResolvedValue(range);

    const datasource = createDatasource("tab-1", 5, vi.fn());
    const params = makeParams();
    await datasource.getRows(params);

    expect(params.successCallback).toHaveBeenCalledWith(
      [expect.objectContaining({ col_0: "x" })],
      1,
    );
  });

  it("passes the datasource's generation to get_csv_data_range", async () => {
    const range: DataRange = { rows: [], totalRows: 0, generation: 7, rowIds: null };
    invokeMock.mockResolvedValue(range);

    const datasource = createDatasource("tab-1", 7, vi.fn());
    await datasource.getRows(makeParams());

    expect(invokeMock).toHaveBeenCalledWith("get_csv_data_range", {
      tabId: "tab-1",
      startRow: 0,
      endRow: 10,
      generation: 7,
    });
  });

  it("uses rowIds for the row number display when present", async () => {
    const range: DataRange = {
      rows: [["x"], ["y"]],
      totalRows: 2,
      generation: 1,
      rowIds: [40, 41],
    };
    invokeMock.mockResolvedValue(range);

    const datasource = createDatasource("tab-1", 1, vi.fn());
    const params = makeParams();
    await datasource.getRows(params);

    expect(params.successCallback).toHaveBeenCalledWith(
      [expect.objectContaining({ __rowNum: "41" }), expect.objectContaining({ __rowNum: "42" })],
      2,
    );
  });

  it("clears a previous error on a successful fetch", async () => {
    const range: DataRange = { rows: [["x"]], totalRows: 1, generation: 1, rowIds: null };
    invokeMock.mockResolvedValue(range);
    const onFetchStatus = vi.fn();

    const datasource = createDatasource("tab-1", 1, onFetchStatus);
    await datasource.getRows(makeParams());

    expect(onFetchStatus).toHaveBeenCalledWith(null);
  });

  it("does not touch fetch status when the response's generation is stale", async () => {
    const range: DataRange = { rows: [["x"]], totalRows: 1, generation: 999, rowIds: null };
    invokeMock.mockResolvedValue(range);
    const onFetchStatus = vi.fn();

    const datasource = createDatasource("tab-1", 1, onFetchStatus);
    await datasource.getRows(makeParams());

    expect(onFetchStatus).not.toHaveBeenCalled();
  });

  it("reports a connection-code rejection and still fails the request", async () => {
    invokeMock.mockRejectedValue({ code: "connection", message: "DuckDB error: boom" });
    const onFetchStatus = vi.fn();
    const params = makeParams();

    const datasource = createDatasource("tab-1", 1, onFetchStatus);
    await datasource.getRows(params);

    expect(onFetchStatus).toHaveBeenCalledWith("DuckDB error: boom");
    expect(params.failCallback).toHaveBeenCalled();
  });

  it("does not report a tabNotFound rejection (an ordinary close race) but still fails the request", async () => {
    invokeMock.mockRejectedValue({ code: "tabNotFound", message: "Tab not found: tab-1" });
    const onFetchStatus = vi.fn();
    const params = makeParams();

    const datasource = createDatasource("tab-1", 1, onFetchStatus);
    await datasource.getRows(params);

    expect(onFetchStatus).not.toHaveBeenCalled();
    expect(params.failCallback).toHaveBeenCalled();
  });
});
