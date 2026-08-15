import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { NoticeBar } from "./NoticeBar";

afterEach(cleanup);

describe("NoticeBar", () => {
  it("renders the message", () => {
    render(<NoticeBar tone="warning" message="something to notice" />);
    expect(screen.getByText("something to notice")).toBeInTheDocument();
  });

  it("renders children alongside the message", () => {
    render(
      <NoticeBar tone="warning" message="msg">
        <button>Action</button>
      </NoticeBar>,
    );
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });

  it("omits the Dismiss button when onDismiss is not given", () => {
    render(<NoticeBar tone="error" message="msg" />);
    expect(screen.queryByText("Dismiss")).not.toBeInTheDocument();
  });

  it("fires onDismiss when Dismiss is clicked", () => {
    const onDismiss = vi.fn();
    render(<NoticeBar tone="error" message="msg" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
