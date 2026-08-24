/**
 * Render smoke test for the real <DataGrid> component (issue #104).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `datasource.test.ts` unit-tests `getRows` in isolation and never mounts
 * <AgGridReact>, so it cannot see the grid failing to render at all. That gap
 * is not hypothetical: an ag-grid v31 -> v36 upgrade makes module registration
 * mandatory (`ModuleRegistry.registerModules([...])`), and without it the grid
 * draws ZERO pixels at runtime while `tsc --noEmit`, `vite build` and every
 * existing unit test stay green.
 *
 * These tests mount the actual component in jsdom and assert that AG-Grid
 * really produced its DOM, that the header cells match the `columns` prop, that
 * rows fetched through the datasource reach the grid, that nothing is logged to
 * console.error (AG-Grid reports "Failed to create grid." there when a required
 * module is missing), and that the sort callback fires.
 *
 * Notes for whoever upgrades ag-grid:
 *   - The `.ag-*` selectors below are AG-Grid's rendered class names, not ours.
 *     If an upgrade renames them, update them HERE deliberately after checking
 *     the grid still renders — do not delete the assertions.
 *   - jsdom has no ResizeObserver. ag-grid v31 mounts fine without one, so
 *     `src/test/setup.ts` carries no polyfill. If a future version starts
 *     requiring it, add the stub there (globally) rather than per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { DataGrid } from "./DataGrid";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

/**
 * The exact selector `DataGrid.tsx` uses internally (via
 * `containerRef.current?.querySelector(...)`) to find the scrollable viewport
 * for scroll-position save/restore. Pinned here on purpose: it is a private
 * AG-Grid DOM detail, so a version upgrade can silently turn that lookup into
 * `null` and break scroll restoration without any type or build error.
 * Keep this string identical to the one in `DataGrid.tsx`'s `onGridReady`.
 *
 * Was `.ag-body-viewport` up to ag-grid v31; v36 renamed it. The right element
 * is the one AG-Grid itself assigns `scrollTop` to (`eGridViewport` in its
 * source) — NOT the similarly named `.ag-grid-scrolling-container`, which is
 * the inner row container and would resolve non-null here while silently
 * ignoring the `scrollTop` write.
 */
const SCROLL_VIEWPORT_SELECTOR = ".ag-grid-viewport";

const COLUMNS = ["alpha", "beta"];

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({
    rows: [
      ["a1", "b1"],
      ["a2", "b2"],
    ],
    totalRows: 2,
    generation: 0,
    rowIds: null,
  });
  // Spy without replacing the implementation: anything AG-Grid or React logs is
  // still printed, and the call count stays assertable.
  consoleErrorSpy = vi.spyOn(console, "error");
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
});

function renderGrid(overrides: Partial<Parameters<typeof DataGrid>[0]> = {}) {
  const onSortChange = vi.fn();
  const onScrollSave = vi.fn();
  const onFetchStatus = vi.fn();
  const utils = render(
    <DataGrid
      columns={COLUMNS}
      totalRows={2}
      tabId="tab-1"
      generation={0}
      searchHits={[]}
      currentHitIndex={-1}
      onScrollSave={onScrollSave}
      sort={[]}
      onSortChange={onSortChange}
      onFetchStatus={onFetchStatus}
      {...overrides}
    />,
  );
  return { ...utils, onSortChange, onScrollSave, onFetchStatus };
}

function headerTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".ag-header-cell-text")).map(
    (el) => el.textContent ?? "",
  );
}

/** Waits until AG-Grid has actually painted its header row. */
async function waitForGrid(container: HTMLElement) {
  await waitFor(() => {
    expect(container.querySelectorAll(".ag-header-cell").length).toBeGreaterThan(0);
  });
}

describe("DataGrid render smoke test", () => {
  it("mounts AG-Grid and puts its root wrapper in the DOM", async () => {
    const { container } = renderGrid();
    await waitForGrid(container);

    // `.ag-root-wrapper` is the outermost element AG-Grid itself creates. If
    // grid construction fails (e.g. unregistered modules), our own
    // `.ag-theme-alpine` container still renders but this stays null.
    const rootWrapper = container.querySelector(".ag-root-wrapper");
    expect(rootWrapper).not.toBeNull();
    expect(rootWrapper).toBeInTheDocument();
    expect(container.querySelector(".ag-root")).not.toBeNull();
  });

  it("generates a header cell per column, plus the pinned row-number column", async () => {
    const { container } = renderGrid();
    await waitForGrid(container);

    // "#" is the pinned row-number column DataGrid prepends to `columns`.
    expect(headerTexts(container)).toEqual(["#", ...COLUMNS]);
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(COLUMNS.length + 1);
  });

  it("rebuilds the header when the columns prop changes", async () => {
    const { container, rerender } = renderGrid();
    await waitForGrid(container);

    rerender(
      <DataGrid
        columns={["one", "two", "three"]}
        totalRows={2}
        tabId="tab-1"
        generation={0}
        searchHits={[]}
        currentHitIndex={-1}
        onScrollSave={vi.fn()}
        sort={[]}
        onSortChange={vi.fn()}
        onFetchStatus={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(headerTexts(container)).toEqual(["#", "one", "two", "three"]);
    });
  });

  it("wires the datasource into the grid so fetched rows are rendered", async () => {
    const { container } = renderGrid();
    await waitForGrid(container);

    // Proves `setGridOption("datasource", ...)` actually took effect: the grid
    // asked for a block, and the values came back out as rendered cells.
    await waitFor(() => {
      expect(
        Array.from(container.querySelectorAll(".ag-cell")).map((el) => el.textContent),
      ).toEqual(expect.arrayContaining(["a1", "b1"]));
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "get_csv_data_range",
      expect.objectContaining({ tabId: "tab-1", generation: 0 }),
    );
  });

  it(`keeps the ${SCROLL_VIEWPORT_SELECTOR} scroll container resolvable`, async () => {
    // DataGrid.tsx restores a saved scroll offset by querying this exact
    // selector inside its own container. If an ag-grid upgrade renames or
    // restructures it, the query returns null and scroll restoration silently
    // stops working — nothing else in the suite would notice.
    const { container } = renderGrid();
    await waitForGrid(container);

    const viewport = container.querySelector(SCROLL_VIEWPORT_SELECTOR);
    expect(
      viewport,
      `DataGrid.tsx looks up "${SCROLL_VIEWPORT_SELECTOR}" for scroll save/restore; ag-grid no longer renders it`,
    ).not.toBeNull();
    expect(viewport).toBeInstanceOf(HTMLElement);

    // Guards against pointing at an inner row container instead of the real
    // scroller: the scrollable viewport must sit inside AG-Grid's root and wrap
    // the rendered rows. (jsdom does no layout, so `overflow`/`scrollTop`
    // themselves are not observable here — a real scroll check stays manual.)
    expect(container.querySelector(".ag-root")?.contains(viewport!)).toBe(true);
    await waitFor(() => {
      expect(viewport!.querySelector(".ag-row")).not.toBeNull();
    });
  });

  it("applies the search-hit cell highlight", async () => {
    // Exercises the whole search-highlight path in one go, which is the only
    // place three separately registered AG-Grid modules are used:
    //   CellStyleModule — honours the `cellStyle` callback at all
    //   RenderApiModule — `api.refreshCells()` re-runs it when hits change
    //   ScrollApiModule — `api.ensureIndexVisible()` jumps to the current hit
    // Unregister any of them and the styling never lands, with no type or
    // build error to show for it.
    const { container, rerender } = renderGrid();
    await waitForGrid(container);
    await waitFor(() => {
      expect(container.querySelectorAll(".ag-cell").length).toBeGreaterThan(0);
    });

    rerender(
      <DataGrid
        columns={COLUMNS}
        totalRows={2}
        tabId="tab-1"
        generation={0}
        searchHits={[{ row: 1, column: 0 }]}
        currentHitIndex={0}
        onScrollSave={vi.fn()}
        sort={[]}
        onSortChange={vi.fn()}
        onFetchStatus={vi.fn()}
      />,
    );

    // "#FDE68A" is the current-hit background from DataGrid.tsx's cellStyle.
    await waitFor(() => {
      const highlighted = Array.from(container.querySelectorAll<HTMLElement>(".ag-cell")).filter(
        (el) => el.style.backgroundColor === "rgb(253, 230, 138)",
      );
      expect(highlighted.map((el) => el.textContent)).toEqual(["a2"]);
    });
  });

  it("calls onSortChange when a sortable column header is clicked", async () => {
    const { container, onSortChange } = renderGrid();
    await waitForGrid(container);

    const alphaHeader = headerCellByText(container, "alpha");
    fireEvent.click(alphaHeader);
    await waitFor(() => expect(onSortChange).toHaveBeenCalledTimes(1));
    expect(onSortChange).toHaveBeenLastCalledWith([{ column: "alpha", descending: false }]);

    // Second click flips to descending — confirms the handler reads AG-Grid's
    // live column state rather than a hardcoded direction.
    fireEvent.click(alphaHeader);
    await waitFor(() => expect(onSortChange).toHaveBeenCalledTimes(2));
    expect(onSortChange).toHaveBeenLastCalledWith([{ column: "alpha", descending: true }]);
  });

  it("logs nothing to console.error while mounting, loading rows and sorting", async () => {
    const { container } = renderGrid();
    await waitForGrid(container);
    await waitFor(() => {
      expect(container.querySelectorAll(".ag-cell").length).toBeGreaterThan(0);
    });

    fireEvent.click(headerCellByText(container, "beta"));
    await waitFor(() => {
      expect(container.querySelector(".ag-header-cell-sorted-asc, [aria-sort]")).not.toBeNull();
    });

    // AG-Grid reports fatal setup problems ("AG Grid: Failed to create grid.",
    // missing-module errors) through console.error, so zero is the only
    // acceptable count here. Do not relax this to `toBeLessThan(n)`.
    expect(
      consoleErrorSpy,
      `console.error was called: ${JSON.stringify(
        consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])),
      )}`,
    ).not.toHaveBeenCalled();
  });
});

/** Finds a rendered header cell by its visible label text. */
function headerCellByText(container: HTMLElement, text: string): HTMLElement {
  const label = Array.from(container.querySelectorAll(".ag-header-cell-text")).find(
    (el) => el.textContent === text,
  );
  if (!label) {
    throw new Error(
      `No header cell labelled "${text}". Rendered headers: ${JSON.stringify(headerTexts(container))}`,
    );
  }
  return label as HTMLElement;
}
