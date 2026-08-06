use duckdb::Connection;

#[cfg(test)]
use crate::commands::view::{BASE_TABLE, ROW_ID};
use crate::{
    commands::view,
    state::{DuckDBState, TabSession},
    types::{CsvError, DataRange},
};

const MAX_ROWS_PER_FETCH: usize = 500;

#[tauri::command]
pub fn get_csv_data_range(
    tab_id: String,
    start_row: usize,
    end_row: usize,
    generation: u64,
    state: tauri::State<'_, DuckDBState>,
) -> Result<DataRange, String> {
    let session = state.session(&tab_id)?;
    // Silent-discard design (docs/SEARCH_ARCHITECTURE.md §2-3): a stale
    // `generation` in the request is not an error — the response always
    // reflects the tab's current view, and the frontend is responsible for
    // discarding a response whose echoed generation doesn't match what it
    // asked for. Returning a hard error here would trigger AG-Grid's
    // failCallback retry path and spurious SET_ERROR dispatches for what is
    // just an ordinary race between scrolling and applying a query.
    let _ = generation;

    get_range_for_session(&session, start_row, end_row).map_err(String::from)
}

/// The command body, taking a `TabSession` directly so tests can exercise it
/// without going through `tauri::State`.
pub(crate) fn get_range_for_session(
    session: &TabSession,
    start_row: usize,
    end_row: usize,
) -> Result<DataRange, CsvError> {
    let conn = session.conn.lock().unwrap();
    let (table, generation, src_row_id_col) = session.current_view();

    let total_rows = match session.result.lock().unwrap().as_ref() {
        Some(view) => view.total_rows,
        None => conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?,
    };

    get_data_range_in(
        &conn,
        &table,
        src_row_id_col.as_deref(),
        total_rows,
        generation,
        start_row,
        end_row,
    )
}

/// Searches/fetches `table`, ordered by its own stable ordinal column
/// (`view::ordinal_col`). `src_row_id_col`, when present, is read alongside
/// the display columns to populate `row_ids` — the original file row number
/// to show in the `#` column, which otherwise falls back to the in-view
/// ordinal.
fn get_data_range_in(
    conn: &Connection,
    table: &str,
    src_row_id_col: Option<&str>,
    total_rows: usize,
    generation: u64,
    start_row: usize,
    end_row: usize,
) -> Result<DataRange, CsvError> {
    let limit = end_row.saturating_sub(start_row).min(MAX_ROWS_PER_FETCH);
    let offset = start_row;
    let ordinal = view::ordinal_col(table);

    let columns = view::display_columns(conn, table)?;
    let col_count = columns.len();

    // The source-row-id column, when present, is excluded from the `*`
    // expansion (so it doesn't show up twice among the display columns) and
    // then re-selected explicitly as the last column, so its value can be
    // read positionally at `col_count` below. For `csv_data`, `ordinal` and
    // `src_row_id_col` are the very same column (`__row_id` doubling as
    // both) — DuckDB's EXCLUDE list rejects a repeated name, so this only
    // adds `src_row_id_col` to the exclude list when it differs from
    // `ordinal`, rather than always listing both.
    let extra_exclude = match src_row_id_col {
        Some(c) if c != ordinal => format!(", \"{}\"", view::quote_ident(c)),
        _ => String::new(),
    };
    let src_fragment = src_row_id_col
        .map(|c| format!(", \"{}\"", view::quote_ident(c)))
        .unwrap_or_default();

    // `COLUMNS(* EXCLUDE (...))::VARCHAR` casts every display column to text
    // — needed because a `sql`-mode result can carry non-VARCHAR columns
    // (e.g. `count(*)` is BIGINT), and `row.get::<_, Option<String>>` below
    // only succeeds for columns DuckDB already reports as text (verified
    // against duckdb-rs's `impl FromSql for String`, which does not
    // stringify other types). The cast is scoped to the EXCLUDE'd star only,
    // so `src_fragment`'s own column — appended after, untouched — keeps its
    // native integer type for the `i64` read further down.
    let sql = format!(
        "SELECT COLUMNS(* EXCLUDE (\"{}\"{extra_exclude}))::VARCHAR{src_fragment} FROM {table} \
         ORDER BY {ordinal} LIMIT {limit} OFFSET {offset}",
        view::quote_ident(ordinal)
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut row_ids: Vec<usize> = Vec::new();
    let rows: Vec<Vec<String>> = stmt
        .query_map([], |row| {
            let cells: Vec<String> = (0..col_count)
                .map(|i| {
                    row.get::<_, Option<String>>(i)
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                })
                .collect();
            if src_row_id_col.is_some() {
                let rid: i64 = row.get(col_count)?;
                Ok((cells, Some(rid as usize)))
            } else {
                Ok((cells, None))
            }
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(cells, rid)| {
            if let Some(rid) = rid {
                row_ids.push(rid);
            }
            cells
        })
        .collect();

    Ok(DataRange {
        rows,
        total_rows,
        generation,
        row_ids: src_row_id_col.map(|_| row_ids),
    })
}

/// Fetches from `csv_data` directly — a thin shim over `get_data_range_in`
/// kept for the existing test suite (generation 0, `csv_data`'s own
/// `__row_id` doubling as the source-row-id column since there's no view
/// pipeline narrowing anything).
#[cfg(test)]
fn get_data_range(
    conn: &Connection,
    start_row: usize,
    end_row: usize,
) -> Result<DataRange, CsvError> {
    let total_rows: usize =
        conn.query_row(&format!("SELECT COUNT(*) FROM {BASE_TABLE}"), [], |r| {
            r.get(0)
        })?;
    get_data_range_in(
        conn,
        BASE_TABLE,
        Some(ROW_ID),
        total_rows,
        0,
        start_row,
        end_row,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{file::load_csv, search::search};

    #[test]
    fn search_hit_row_is_the_same_row_get_data_range_returns() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, _metadata) = load_csv(path).expect("small.csv should load");

        let response = search(&conn, "Sapporo").expect("search should not error");
        assert!(
            !response.hits.is_empty(),
            "fixture should contain 'Sapporo'"
        );

        for hit in &response.hits {
            let range = get_data_range(&conn, hit.row, hit.row + 1)
                .expect("range fetch for a hit row should not error");
            let cell = &range.rows[0][hit.column];
            assert!(
                cell.contains("Sapporo"),
                "row {} col {} from search_csv should match the same cell via \
                 get_csv_data_range, got {:?} — row indices desynced",
                hit.row,
                hit.column,
                cell
            );
        }
    }

    #[test]
    fn fetches_the_requested_row_range_in_order() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, metadata) = load_csv(path).expect("small.csv should load");

        let range = get_data_range(&conn, 0, 5).expect("range fetch should not error");

        assert_eq!(range.total_rows, 100);
        assert_eq!(range.rows.len(), 5);
        assert_eq!(range.rows[0].len(), metadata.total_columns);
        // small.csv's id column is 1, 2, 3, ... in file order.
        assert_eq!(range.rows[0][0], "1");
        assert_eq!(range.rows[4][0], "5");
    }

    #[test]
    fn caps_the_fetch_at_max_rows_per_fetch() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-data/tab_delimited.tsv"
        );
        let (conn, _metadata) = load_csv(path).expect("tab_delimited.tsv should load");

        let range = get_data_range(&conn, 0, 10_000).expect("range fetch should not error");

        assert_eq!(range.rows.len(), MAX_ROWS_PER_FETCH);
        assert_eq!(range.total_rows, 10_000);
    }

    #[test]
    fn returns_fewer_rows_near_the_end_of_the_table() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, _metadata) = load_csv(path).expect("small.csv should load");

        // Only 5 rows remain (indices 95..99) though the requested window asks for 10.
        let range = get_data_range(&conn, 95, 105).expect("range fetch should not error");

        assert_eq!(range.rows.len(), 5);
        assert_eq!(range.rows[4][0], "100");
    }

    #[test]
    fn row_ids_are_populated_from_the_source_row_id_column() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, _metadata) = load_csv(path).expect("small.csv should load");

        let range = get_data_range(&conn, 0, 5).expect("range fetch should not error");
        assert_eq!(range.row_ids, Some(vec![0, 1, 2, 3, 4]));
    }

    #[test]
    fn generation_is_echoed_back_on_the_range() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, _metadata) = load_csv(path).expect("small.csv should load");

        let range = get_data_range_in(&conn, BASE_TABLE, Some(ROW_ID), 100, 7, 0, 5)
            .expect("range fetch should not error");
        assert_eq!(range.generation, 7);
    }
}
