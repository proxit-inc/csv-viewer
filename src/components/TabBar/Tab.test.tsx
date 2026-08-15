import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Tab } from "./Tab";

afterEach(cleanup);

describe("Tab", () => {
  it("does not show the error icon when errorMessage is not set", () => {
    render(<Tab id="a" filename="a.csv" isActive={false} onSwitch={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("img", { name: "Connection error" })).not.toBeInTheDocument();
  });

  it("shows the error icon with the message as its tooltip when errorMessage is set", () => {
    render(
      <Tab
        id="a"
        filename="a.csv"
        isActive={false}
        errorMessage="DuckDB error: connection lost"
        onSwitch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const icon = screen.getByRole("img", { name: "Connection error" });
    expect(icon.closest("[title]")).toHaveAttribute("title", "DuckDB error: connection lost");
  });
});
