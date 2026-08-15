use duckdb::{params_from_iter, Connection};

#[cfg(test)]
use crate::commands::view::{BASE_TABLE, ROW_ID};
use crate::{
    commands::view,
    state::DuckDBState,
    types::{CsvError, SearchHit, SearchResponse},
};

const MAX_SEARCH_HITS: usize = 10_000;

#[tauri::command]
pub fn search_csv(
    tab_id: String,
    query: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<SearchResponse, String> {
    let session = state.session(&tab_id)?;
    let conn = session.conn.lock().unwrap();
    // Search the tab's current view (the filtered/queried `csv_result` when
    // one exists, else `csv_data`) so a search after a `where`/`sql` query
    // naturally operates on the narrowed set — see
    // docs/SEARCH_ARCHITECTURE.md §2-5.
    let (table, _generation, _src_row_id) = session.current_view();
    let ordinal = view::ordinal_col(&table);
    search_in(&conn, &table, ordinal, &query).map_err(String::from)
}

/// Searches `csv_data` — a thin shim over `search_in` kept for the existing
/// test suite.
#[cfg(test)]
pub(crate) fn search(conn: &Connection, query: &str) -> Result<SearchResponse, CsvError> {
    search_in(conn, BASE_TABLE, ROW_ID, query)
}

/// Single-round-trip text search over `table`, ordered by `row_id_col` then
/// column. Replaces the old per-column `prepare()`+`query_map()` loop (N
/// round trips for N columns) with one UNION ALL statement sorted and
/// truncated by the engine, which also fixes two bugs the old loop had:
/// truncation wasn't signaled to the frontend, and — because each column's
/// own `LIMIT 10_000` had no `ORDER BY` — the post-truncate result was a
/// nondeterministic subset rather than a stable "first N hits".
pub(crate) fn search_in(
    conn: &Connection,
    table: &str,
    row_id_col: &str,
    query: &str,
) -> Result<SearchResponse, CsvError> {
    if query.is_empty() {
        return Ok(SearchResponse {
            hits: vec![],
            total_count: 0,
            truncated: false,
        });
    }

    let columns = view::display_columns(conn, table)?;
    if columns.is_empty() {
        // e.g. a csv_result materialized from `SELECT count(*) FROM csv_data`
        // has no user-visible columns to search.
        return Ok(SearchResponse {
            hits: vec![],
            total_count: 0,
            truncated: false,
        });
    }

    // Escape LIKE metacharacters in the user's query. Backslash must be
    // escaped first so the escapes added for % and _ aren't themselves
    // reinterpreted as escape sequences.
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");

    // UNION ALL of one SELECT per column, each bound to the same LIKE
    // pattern, with the sort/truncate pushed down to a single outer clause
    // so the engine does one pass instead of N Rust-side sorts. Benchmarked
    // against a parallel-`unnest` ("zip") formulation from an earlier draft
    // on both a 6-column and a synthetic 100-column table: UNION ALL won on
    // the wide table (the unnest explosion scales with rows*cols even before
    // the LIMIT applies) and was within noise on narrow ones, so it's the
    // one candidate kept in production code.
    let branches: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(idx, col)| {
            let quoted = view::quote_ident(col);
            format!(
                "SELECT {row_id_col} AS rn, {idx} AS col FROM {table} \
                 WHERE CAST(\"{quoted}\" AS VARCHAR) LIKE ? ESCAPE '\\'"
            )
        })
        .collect();
    let sql = format!(
        "SELECT rn, col FROM ({}) ORDER BY rn, col LIMIT {}",
        branches.join(" UNION ALL "),
        MAX_SEARCH_HITS + 1
    );

    let mut stmt = conn.prepare(&sql)?;
    let bound_params = std::iter::repeat_n(pattern, columns.len());
    let mut rows: Vec<SearchHit> = stmt
        .query_map(params_from_iter(bound_params), |r| {
            Ok(SearchHit {
                row: r.get(0)?,
                column: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let truncated = rows.len() > MAX_SEARCH_HITS;
    rows.truncate(MAX_SEARCH_HITS);
    let total_count = rows.len();

    Ok(SearchResponse {
        hits: rows,
        total_count,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE csv_data (__row_id INTEGER, name VARCHAR, note VARCHAR); \
             INSERT INTO csv_data VALUES \
                (0, 'alice', 'a\\b'), \
                (1, 'bob', '50%'), \
                (2, 'carol', 'a_b')",
        )
        .unwrap();
        conn
    }

    #[test]
    fn matches_literal_backslash_in_query() {
        let conn = setup();
        let response = search(&conn, "a\\b").expect("search should not error");
        assert_eq!(response.total_count, 1);
        assert_eq!(response.hits[0].row, 0);
    }

    #[test]
    fn lone_backslash_matches_the_row_containing_it_not_the_percent_row() {
        let conn = setup();
        let response = search(&conn, "\\").expect("lone backslash should not error");
        assert_eq!(response.total_count, 1);
        assert_eq!(
            response.hits[0].row, 0,
            "should match alice's 'a\\b' note (row 0), not bob's '50%' note via a \
             mis-escaped pattern"
        );
    }

    #[test]
    fn percent_and_underscore_are_matched_literally() {
        let conn = setup();
        assert_eq!(search(&conn, "50%").unwrap().total_count, 1);
        assert_eq!(search(&conn, "a_b").unwrap().total_count, 1);
    }

    #[test]
    fn empty_query_returns_no_hits_without_querying() {
        let conn = setup();
        let response = search(&conn, "").expect("empty query should not error");
        assert_eq!(response.total_count, 0);
        assert!(response.hits.is_empty());
        assert!(!response.truncated);
    }

    #[test]
    fn no_hits_for_a_term_that_does_not_appear() {
        let conn = setup();
        let response = search(&conn, "nope-not-here").expect("search should not error");
        assert_eq!(response.total_count, 0);
        assert!(!response.truncated);
    }

    #[test]
    fn finds_hits_in_the_correct_column_across_a_real_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, metadata) =
            crate::commands::file::load_csv(path, None).expect("small.csv should load");
        let city_col = metadata
            .headers
            .iter()
            .position(|h| h == "city")
            .expect("small.csv should have a city column");

        let response = search(&conn, "Sapporo").expect("search should not error");
        assert!(
            !response.hits.is_empty(),
            "fixture should contain 'Sapporo'"
        );
        assert!(
            response.hits.iter().all(|h| h.column == city_col),
            "all 'Sapporo' hits should be in the city column, got {:?}",
            response.hits
        );
    }

    #[test]
    fn returns_the_globally_first_hits_and_flags_truncation() {
        // Specification test, not a regression test against the old
        // implementation: the old per-column loop's post-truncate result was
        // nondeterministic (each column's own `LIMIT 10_000` had no `ORDER
        // BY`), not deterministically biased toward low columns — so this
        // pins the *new* contract rather than proving the old one wrong.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE csv_data AS \
             SELECT (row_number() OVER () - 1) AS __row_id, \
                     'x' AS col_a, 'x' AS col_b \
             FROM range(30000)",
        )
        .unwrap();

        let response = search(&conn, "x").expect("search should not error");
        assert_eq!(response.hits.len(), MAX_SEARCH_HITS);
        assert!(response.truncated);

        // First 10_000 hits in (row, col) order means rows 0..4999 across
        // both columns (2 hits per row), col_a (0) before col_b (1).
        assert_eq!(response.hits[0], SearchHit { row: 0, column: 0 });
        assert_eq!(response.hits[1], SearchHit { row: 0, column: 1 });
        let last = response.hits.last().unwrap();
        assert_eq!(
            *last,
            SearchHit {
                row: 4999,
                column: 1
            }
        );
    }

    #[test]
    fn truncated_is_false_below_the_cap() {
        let conn = setup();
        let response = search(&conn, "alice").expect("search should not error");
        assert!(!response.truncated);
    }

    #[test]
    fn returns_no_hits_when_the_table_has_only_internal_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE csv_data (__row_id INTEGER)")
            .unwrap();
        let response = search(&conn, "anything").expect("search should not error");
        assert_eq!(response.total_count, 0);
    }

    // Run with `cargo test bench_ -- --ignored --nocapture` to compare the
    // UNION ALL formulation used in production against a parallel-unnest
    // ("zip") alternative. Not part of the default test run since timing
    // comparisons are noisy in CI and this is a one-time implementation
    // decision, not a regression guard.
    fn bench_setup_wide(cols: usize, rows: usize) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let col_defs: Vec<String> = (0..cols).map(|i| format!("'x' AS c{i}")).collect();
        conn.execute_batch(&format!(
            "CREATE TABLE csv_data AS \
             SELECT (row_number() OVER () - 1) AS __row_id, {} \
             FROM range({rows})",
            col_defs.join(", ")
        ))
        .unwrap();
        conn
    }

    fn union_all_search(conn: &Connection, cols: usize) -> std::time::Duration {
        let start = Instant::now();
        search(conn, "x").unwrap();
        let _ = cols;
        start.elapsed()
    }

    fn unnest_zip_search(conn: &Connection, cols: usize) -> std::time::Duration {
        let col_list: Vec<String> = (0..cols).map(|i| format!("\"c{i}\"")).collect();
        let idx_list: Vec<String> = (0..cols).map(|i| i.to_string()).collect();
        let sql = format!(
            "WITH exploded AS (\
                SELECT __row_id AS rn, unnest([{}]) AS val, unnest([{}]) AS col \
                FROM csv_data\
             ) SELECT rn, col FROM exploded WHERE val LIKE ? ESCAPE '\\' \
               ORDER BY rn, col LIMIT {}",
            col_list.join(", "),
            idx_list.join(", "),
            MAX_SEARCH_HITS + 1
        );
        let start = Instant::now();
        let mut stmt = conn.prepare(&sql).unwrap();
        let _rows: Vec<(i64, i64)> = stmt
            .query_map(duckdb::params!["%x%"], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        start.elapsed()
    }

    #[test]
    #[ignore]
    fn bench_narrow_6_columns() {
        let conn = bench_setup_wide(6, 100_000);
        println!(
            "UNION ALL (6 cols, 100k rows): {:?}",
            union_all_search(&conn, 6)
        );
        println!(
            "unnest zip (6 cols, 100k rows): {:?}",
            unnest_zip_search(&conn, 6)
        );
    }

    #[test]
    #[ignore]
    fn bench_wide_100_columns() {
        let conn = bench_setup_wide(100, 100_000);
        println!(
            "UNION ALL (100 cols, 100k rows): {:?}",
            union_all_search(&conn, 100)
        );
        println!(
            "unnest zip (100 cols, 100k rows): {:?}",
            unnest_zip_search(&conn, 100)
        );
    }
}
