use std::sync::{Arc, Mutex};

use duckdb::Connection;

use crate::{
    csv::{delimiter::detect_delimiter, encoding::detect_encoding},
    state::DuckDBState,
    types::FileMetadata,
};

const DELIMITER_SAMPLE_BYTES: usize = 8_192;

/// Removes its temp file on drop, regardless of which branch returns early.
struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) fn load_csv(path: &str) -> Result<(Connection, FileMetadata), String> {
    let path = path.to_string();
    // Reject paths containing null bytes to prevent injection.
    if path.contains('\0') {
        return Err("Invalid file path: contains null byte".into());
    }

    let raw = std::fs::read(&path).map_err(|e| format!("Cannot read file: {}", e))?;

    let encoding = detect_encoding(&raw);
    let (decoded, _, _) = encoding.decode(&raw);

    let sample_len = decoded.len().min(DELIMITER_SAMPLE_BYTES);
    let delimiter = detect_delimiter(&decoded[..sample_len]);

    // DuckDB's read_csv_auto assumes UTF-8. For non-UTF-8 source files, write the
    // already-decoded text to a UTF-8 temp file and load from that instead of the
    // original (raw-encoded) path.
    let temp_file = if encoding != encoding_rs::UTF_8 {
        let temp_path =
            std::env::temp_dir().join(format!("csv-viewer-{}.csv", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, decoded.as_bytes())
            .map_err(|e| format!("Cannot write temp file: {}", e))?;
        Some(TempFile(temp_path))
    } else {
        None
    };
    let load_path = temp_file
        .as_ref()
        .map(|t| t.0.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let conn = Connection::open_in_memory().map_err(|e| format!("DuckDB init error: {}", e))?;

    let delim_str = match delimiter {
        '\t' => "\\t".to_string(),
        c => c.to_string(),
    };

    // Escape single quotes in path to prevent SQL injection via the file path.
    let escaped_path = load_path.replace('\'', "''");
    // __row_id is a stable ordinal materialized once at load time, giving
    // get_csv_data_range and search_csv a shared row identity to ORDER BY.
    // Without it, DuckDB doesn't guarantee scan order stays consistent
    // across separate queries on the same table, so a row index from one
    // command could point at a different row when read by the other.
    conn.execute_batch(&format!(
        "CREATE TABLE csv_data AS \
         SELECT (row_number() OVER () - 1) AS __row_id, * \
         FROM read_csv_auto('{}', delim='{}', header=true, ignore_errors=true, all_varchar=true)",
        escaped_path, delim_str
    ))
    .map_err(|e| format!("DuckDB load error: {}", e))?;

    drop(temp_file);

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT column_name FROM (DESCRIBE csv_data)")
        .map_err(|e| e.to_string())?;

    // Skip __row_id (always the first column, see above) — it's an internal
    // ordering aid, not a data column the frontend should see.
    let headers: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .skip(1)
        .collect();

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

    Ok((
        conn,
        FileMetadata {
            filename,
            file_path: path,
            file_size,
            total_rows,
            total_columns,
            encoding: encoding.name().to_string(),
            delimiter: delimiter_str,
            headers,
        },
    ))
}

#[tauri::command]
pub fn open_csv_file(
    path: String,
    tab_id: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<FileMetadata, String> {
    let (conn, metadata) = load_csv(&path)?;

    state
        .connections
        .lock()
        .unwrap()
        .insert(tab_id, Arc::new(Mutex::new(conn)));

    Ok(metadata)
}

#[tauri::command]
pub fn close_tab(tab_id: String, state: tauri::State<'_, DuckDBState>) -> Result<(), String> {
    state.connections.lock().unwrap().remove(&tab_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_shift_jis_file_without_corrupting_multibyte_text() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/sjis_sample.csv");
        let (conn, metadata) = load_csv(path).expect("shift_jis file should load");

        assert_eq!(metadata.encoding, "Shift_JIS");
        assert_eq!(metadata.total_rows, 10_000);

        let city: String = conn
            .query_row("SELECT city FROM csv_data LIMIT 1", [], |r| r.get(0))
            .expect("should read decoded city column");

        assert!(
            ["東京", "大阪", "名古屋", "福岡", "札幌"].contains(&city.as_str()),
            "expected a decoded Japanese city name, got {:?}",
            city
        );
    }
}
