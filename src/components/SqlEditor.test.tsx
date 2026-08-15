import { describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { SqlEditor } from "./SqlEditor";

afterEach(cleanup);

describe("SqlEditor", () => {
  it("renders without crashing and shows the initial value", () => {
    const { container } = render(
      <SqlEditor
        value="SELECT * FROM csv_data"
        onChange={vi.fn()}
        onApply={vi.fn()}
        onClose={vi.fn()}
        schema={{ csv_data: ["a", "b"], csv_result: [] }}
      />,
    );

    expect(container.textContent).toContain("SELECT * FROM csv_data");
  });
});
