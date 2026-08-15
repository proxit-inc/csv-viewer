import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { LargeFileNotice } from "./LargeFileNotice";

afterEach(cleanup);

describe("LargeFileNotice", () => {
  it("renders the formatted row count", () => {
    render(<LargeFileNotice totalRows={1_234_567} onClose={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(/1,234,567 rows/)).toBeInTheDocument();
  });

  it("fires onClose when Close file is clicked", () => {
    const onClose = vi.fn();
    render(<LargeFileNotice totalRows={2_000_000} onClose={onClose} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByText("Close file"));
    expect(onClose).toHaveBeenCalled();
  });

  it("fires onDismiss when Dismiss is clicked", () => {
    const onDismiss = vi.fn();
    render(<LargeFileNotice totalRows={2_000_000} onClose={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
