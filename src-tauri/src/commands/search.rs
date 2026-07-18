use duckdb::{params, Connection};

use crate::{
    state::DuckDBState,
    types::{SearchHit, SearchResponse},
};

const MAX_SEARCH_HITS: usize = 10_000;

#[tauri::command]
pub fn search_csv(
    tab_id: String,
    query: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<SearchResponse, String> {
    let connections = state.connections.lock().unwrap();
    let conn_arc = connections
        .get(&tab_id)
        .ok_or_else(|| format!("Tab not found: {}", tab_id))?
        .clone();
    drop(connections);

    let conn = conn_arc.lock().unwrap();
    search(&conn, &query)
}

pub(crate) fn search(conn: &Connection, query: &str) -> Result<SearchResponse, String> {
    if query.is_empty() {
        return Ok(SearchResponse {
            hits: vec![],
            total_count: 0,
        });
    }

    let mut stmt = conn
        .prepare("SELECT column_name FROM (DESCRIBE csv_data)")
        .map_err(|e| e.to_string())?;

    // Skip __row_id (always the first column, see file::load_csv) — it's an
    // internal ordering aid, not a data column the frontend should see.
    let headers: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .skip(1)
        .collect();

    // Escape LIKE metacharacters in the user's query. Backslash must be
    // escaped first so the escapes added for % and _ aren't themselves
    // reinterpreted as escape sequences.
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");

    let mut hits: Vec<SearchHit> = Vec::new();

    for (col_idx, col_name) in headers.iter().enumerate() {
        let col_escaped = col_name.replace('"', "\"\"");
        // __row_id is a stable ordinal materialized once at load time (see
        // file::load_csv), so it can be selected directly as each matched
        // row's position instead of recomputing row_number() OVER () here —
        // which DuckDB doesn't guarantee stays consistent with the row
        // numbering get_csv_data_range sees on a separate query.
        // The search pattern is bound as a parameter (not interpolated)
        // so it can't be misinterpreted as SQL or break the ESCAPE clause.
        let sql = format!(
            "SELECT __row_id AS rn FROM csv_data \
            WHERE CAST(\"{col_escaped}\" AS VARCHAR) LIKE ? ESCAPE '\\' \
            LIMIT {MAX_SEARCH_HITS}"
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let row_hits: Vec<usize> = stmt
            .query_map(params![pattern], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        for row in row_hits {
            hits.push(SearchHit {
                row,
                column: col_idx,
            });
        }
    }

    // Sort by row then column so frontend can navigate in order.
    // Keep all per-cell hits so the frontend can highlight individual cells.
    hits.sort_by_key(|h| (h.row, h.column));
    hits.truncate(MAX_SEARCH_HITS);

    let total_count = hits.len();
    Ok(SearchResponse { hits, total_count })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn no_hits_for_a_term_that_does_not_appear() {
        let conn = setup();
        let response = search(&conn, "nope-not-here").expect("search should not error");
        assert_eq!(response.total_count, 0);
    }

    #[test]
    fn finds_hits_in_the_correct_column_across_a_real_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, metadata) =
            crate::commands::file::load_csv(path).expect("small.csv should load");
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
}
