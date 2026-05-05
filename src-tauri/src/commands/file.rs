use std::sync::{Arc, Mutex};

use duckdb::Connection;

use crate::{
    csv::{delimiter::detect_delimiter, encoding::detect_encoding},
    state::DuckDBState,
    types::FileMetadata,
};

const DELIMITER_SAMPLE_BYTES: usize = 8_192;

#[tauri::command]
pub fn open_csv_file(
    path: String,
    tab_id: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<FileMetadata, String> {
    // Reject paths containing null bytes to prevent injection.
    if path.contains('\0') {
        return Err("Invalid file path: contains null byte".into());
    }

    let raw = std::fs::read(&path).map_err(|e| format!("Cannot read file: {}", e))?;

    let encoding = detect_encoding(&raw);
    let (decoded, _, _) = encoding.decode(&raw);

    let sample_len = decoded.len().min(DELIMITER_SAMPLE_BYTES);
    let delimiter = detect_delimiter(&decoded[..sample_len]);

    let conn = Connection::open_in_memory().map_err(|e| format!("DuckDB init error: {}", e))?;

    let delim_str = match delimiter {
        '\t' => "\\t".to_string(),
        c => c.to_string(),
    };

    // Escape single quotes in path to prevent SQL injection via the file path.
    let escaped_path = path.replace('\'', "''");
    conn.execute_batch(&format!(
        "CREATE TABLE csv_data AS \
         SELECT * FROM read_csv_auto('{}', delim='{}', header=true, ignore_errors=true, all_varchar=true)",
        escaped_path, delim_str
    ))
    .map_err(|e| format!("DuckDB load error: {}", e))?;

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT column_name FROM (DESCRIBE csv_data)")
        .map_err(|e| e.to_string())?;

    let headers: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let total_columns = headers.len();
    let file_size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.csv")
        .to_string();

    let delimiter_str = match delimiter {
        '\t' => "\t".to_string(),
        c => c.to_string(),
    };

    state
        .connections
        .lock()
        .unwrap()
        .insert(tab_id, Arc::new(Mutex::new(conn)));

    Ok(FileMetadata {
        filename,
        file_path: path,
        file_size,
        total_rows,
        total_columns,
        encoding: encoding.name().to_string(),
        delimiter: delimiter_str,
        headers,
    })
}

#[tauri::command]
pub fn close_tab(tab_id: String, state: tauri::State<'_, DuckDBState>) -> Result<(), String> {
    state.connections.lock().unwrap().remove(&tab_id);
    Ok(())
}
