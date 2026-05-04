use crate::{state::DuckDBState, types::DataRange};

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

    let limit = end_row.saturating_sub(start_row).min(500);
    let offset = start_row;

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT * FROM csv_data LIMIT {} OFFSET {}",
            limit, offset
        ))
        .map_err(|e| e.to_string())?;

    let col_count = stmt.column_count();

    let rows: Vec<Vec<String>> = stmt
        .query_map([], |row| {
            let cells: Vec<String> = (0..col_count)
                .map(|i| row.get::<_, Option<String>>(i).ok().flatten().unwrap_or_default())
                .collect();
            Ok(cells)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(DataRange { rows, total_rows })
}
