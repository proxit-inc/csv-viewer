import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { EncodingNotice } from "./EncodingNotice";
import { ENCODING_OPTIONS } from "../types";

afterEach(cleanup);

describe("EncodingNotice", () => {
  it("renders one option per ENCODING_OPTIONS entry", () => {
    render(
      <EncodingNotice
        currentEncoding="UTF-8"
        wasOverridden={false}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(ENCODING_OPTIONS.length);
  });

  it("preselects the option matching currentEncoding", () => {
    render(
      <EncodingNotice
        currentEncoding="Shift_JIS"
        wasOverridden={false}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("shift_jis");
  });

  it("calls onReload with the selected label, not the display name", () => {
    const onReload = vi.fn();
    render(
      <EncodingNotice
        currentEncoding="UTF-8"
        wasOverridden={false}
        onReload={onReload}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "windows-1252" } });
    fireEvent.click(screen.getByText("Reload"));
    expect(onReload).toHaveBeenCalledWith("windows-1252");
  });

  it("switches the message wording when wasOverridden is true", () => {
    render(
      <EncodingNotice
        currentEncoding="Shift_JIS"
        wasOverridden={true}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/manually selected/)).toBeInTheDocument();
  });

  it("uses the uncertain-detection wording when wasOverridden is false", () => {
    render(
      <EncodingNotice
        currentEncoding="UTF-8"
        wasOverridden={false}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/detection was uncertain/)).toBeInTheDocument();
  });
});
