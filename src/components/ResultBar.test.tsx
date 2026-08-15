import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ResultBar } from "./ResultBar";
import type { FileMetadata, QueryOutcome } from "../types";

afterEach(cleanup);

const metadata: FileMetadata = {
  filename: "small.csv",
  filePath: "/tmp/small.csv",
  fileSize: 4109,
  totalRows: 100,
  totalColumns: 6,
  encoding: "UTF-8",
  encodingConfident: true,
  delimiter: ",",
  headers: ["id", "name", "city", "category", "value", "date"],
};

describe("ResultBar", () => {
  it("shows the baseline csv_data description and no Reset button when resultView is null", () => {
    render(<ResultBar metadata={metadata} resultView={null} onReset={vi.fn()} />);

    expect(screen.getByText("csv_data (100 rows)")).toBeInTheDocument();
    expect(screen.queryByText("Reset")).not.toBeInTheDocument();
  });

  it("shows the filtered description and a Reset button when resultView is present", () => {
    const resultView: QueryOutcome = {
      generation: 1,
      columns: ["city"],
      totalRows: 5,
      truncated: false,
      hasSourceRowId: true,
      elapsedMs: 3,
      description: "filtered",
    };
    render(<ResultBar metadata={metadata} resultView={resultView} onReset={vi.fn()} />);

    expect(screen.getByText(/filtered/)).toBeInTheDocument();
    expect(screen.getByText("Reset")).toBeInTheDocument();
    expect(screen.queryByText("csv_data (100 rows)")).not.toBeInTheDocument();
  });

  it("shows the truncation warning when resultView.truncated is true", () => {
    const resultView: QueryOutcome = {
      generation: 1,
      columns: ["city"],
      totalRows: 1_000_000,
      truncated: true,
      hasSourceRowId: true,
      elapsedMs: 3,
      description: "filtered",
    };
    render(<ResultBar metadata={metadata} resultView={resultView} onReset={vi.fn()} />);

    expect(screen.getByText(/truncated at/)).toBeInTheDocument();
  });
});
