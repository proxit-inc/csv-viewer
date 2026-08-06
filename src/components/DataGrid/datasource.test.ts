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

    const datasource = createDatasource("tab-1", 5);
    const params = makeParams();
    await datasource.getRows(params);

    expect(params.successCallback).not.toHaveBeenCalled();
    expect(params.failCallback).not.toHaveBeenCalled();
  });

  it("accepts a response whose generation matches", async () => {
    const range: DataRange = { rows: [["x"]], totalRows: 1, generation: 5, rowIds: null };
    invokeMock.mockResolvedValue(range);

    const datasource = createDatasource("tab-1", 5);
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

    const datasource = createDatasource("tab-1", 7);
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

    const datasource = createDatasource("tab-1", 1);
    const params = makeParams();
    await datasource.getRows(params);

    expect(params.successCallback).toHaveBeenCalledWith(
      [expect.objectContaining({ __rowNum: "41" }), expect.objectContaining({ __rowNum: "42" })],
      2,
    );
  });
});
