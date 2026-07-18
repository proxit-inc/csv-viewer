use duckdb::Connection;

use crate::{state::DuckDBState, types::DataRange};

const MAX_ROWS_PER_FETCH: usize = 500;

#[tauri::command]
pub fn get_csv_data_range(
    tab_id: String,
    start_row: usize,
    end_row: usize,
    state: tauri::State<'_, DuckDBState>,
) -> Result<DataRange, String> {
    let connections = state.connections.lock().unwrap();
    let conn_arc = connections
        .get(&tab_id)
        .ok_or_else(|| format!("Tab not found: {}", tab_id))?
        .clone();
    drop(connections);

    let conn = conn_arc.lock().unwrap();
    get_data_range(&conn, start_row, end_row)
}

fn get_data_range(
    conn: &Connection,
    start_row: usize,
    end_row: usize,
) -> Result<DataRange, String> {
    let limit = end_row.saturating_sub(start_row).min(MAX_ROWS_PER_FETCH);
    let offset = start_row;

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    // -1 excludes the internal __row_id ordinal column (see file::load_csv),
    // which is also excluded from the row data queried below.
    let col_count: usize = conn
        .query_row("SELECT COUNT(*) FROM (DESCRIBE csv_data)", [], |r| {
            r.get::<_, usize>(0)
        })
        .map_err(|e| e.to_string())?
        - 1;

    // ORDER BY __row_id keeps row order stable and in sync with search_csv,
    // which reads the same column — see file::load_csv for why this is needed.
    let mut stmt = conn
        .prepare(&format!(
            "SELECT * EXCLUDE (__row_id) FROM csv_data ORDER BY __row_id LIMIT {} OFFSET {}",
            limit, offset
        ))
        .map_err(|e| e.to_string())?;

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
            Ok(cells)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(DataRange { rows, total_rows })
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
}
