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
    if query.is_empty() {
        return Ok(SearchResponse {
            hits: vec![],
            total_count: 0,
        });
    }

    let connections = state.connections.lock().unwrap();
    let conn_arc = connections
        .get(&tab_id)
        .ok_or_else(|| format!("Tab not found: {}", tab_id))?
        .clone();
    drop(connections);

    let conn = conn_arc.lock().unwrap();

    let mut stmt = conn
        .prepare("SELECT column_name FROM (DESCRIBE csv_data)")
        .map_err(|e| e.to_string())?;

    let headers: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let escaped = query
        .replace('\'', "''")
        .replace('%', "\\%")
        .replace('_', "\\_");

    let mut hits: Vec<SearchHit> = Vec::new();

    for (col_idx, col_name) in headers.iter().enumerate() {
        let col_escaped = col_name.replace('"', "\"\"");
        let sql = format!(
            "SELECT (row_number() OVER ()) - 1 AS rn \
             FROM csv_data \
             WHERE CAST(\"{col_escaped}\" AS VARCHAR) LIKE '%{escaped}%' ESCAPE '\\' \
             LIMIT {MAX_SEARCH_HITS}"
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let row_hits: Vec<usize> = stmt
            .query_map([], |r| r.get(0))
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
