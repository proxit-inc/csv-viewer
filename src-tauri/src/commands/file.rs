use std::sync::Arc;

use duckdb::Connection;

use crate::{
    commands::view,
    csv::{delimiter::detect_delimiter, encoding::detect_encoding},
    state::{DuckDBState, TabSession},
    types::FileMetadata,
};

/// Resolves the encoding to load with: an explicit override wins outright
/// (the user picked it, so it's confident by definition), falling back to
/// automatic detection otherwise. Returns `Err` for a label that doesn't map
/// to any known encoding (`encoding_rs::Encoding::for_label` uses the WHATWG
/// label registry, so this rejects typos/unsupported names up front rather
/// than surfacing a confusing failure later in the load).
fn resolve_encoding(
    raw: &[u8],
    encoding_override: Option<&str>,
) -> Result<(&'static encoding_rs::Encoding, bool), String> {
    match encoding_override {
        Some(label) => encoding_rs::Encoding::for_label(label.as_bytes())
            .map(|enc| (enc, true))
            .ok_or_else(|| format!("Unknown encoding: {}", label)),
        None => {
            let detection = detect_encoding(raw);
            Ok((detection.encoding, detection.confident))
        }
    }
}

const DELIMITER_SAMPLE_BYTES: usize = 8_192;

/// Removes its temp file on drop, regardless of which branch returns early.
struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) fn load_csv(
    path: &str,
    encoding_override: Option<&str>,
) -> Result<(Connection, FileMetadata), String> {
    let path = path.to_string();
    // Reject paths containing null bytes to prevent injection.
    if path.contains('\0') {
        return Err("Invalid file path: contains null byte".into());
    }

    let raw = std::fs::read(&path).map_err(|e| format!("Cannot read file: {}", e))?;

    let (encoding, mut confident) = resolve_encoding(&raw, encoding_override)?;
    let (decoded, _, had_errors) = encoding.decode(&raw);
    // Detection only samples the first ENCODING_SAMPLE_BYTES; `decode` covers
    // the whole file, so a replacement-character substitution past that
    // sample is evidence the guess was wrong even when chardetng itself
    // reported confidence. Doesn't apply to an explicit override — the user
    // chose it deliberately, and had_errors there just means the file
    // genuinely isn't in that encoding (see the temp-file condition below,
    // which still loads the lossily-decoded text rather than erroring).
    if encoding_override.is_none() && had_errors {
        confident = false;
    }

    // Truncate the delimiter sample at a UTF-8 char boundary. `decoded.len()` is a
    // byte length, so a raw `&decoded[..DELIMITER_SAMPLE_BYTES]` slice panics when
    // the 8_192-byte offset lands in the middle of a multibyte character (e.g. a
    // 3-byte Japanese kanji). Walk back to the largest boundary <= the byte cap.
    // (str::floor_char_boundary is still unstable, so do it by hand.)
    let mut sample_len = DELIMITER_SAMPLE_BYTES.min(decoded.len());
    while !decoded.is_char_boundary(sample_len) {
        sample_len -= 1;
    }
    let delimiter = detect_delimiter(&decoded[..sample_len]);

    // DuckDB's read_csv_auto assumes UTF-8. For non-UTF-8 source files, write the
    // already-decoded text to a UTF-8 temp file and load from that instead of the
    // original (raw-encoded) path. Also written when `had_errors` even for a
    // nominally-UTF-8 encoding: this is reachable via an explicit override (e.g.
    // the user manually picks UTF-8 for a file that isn't actually UTF-8) — without
    // this, DuckDB would read the raw, invalid bytes directly and fail with a
    // low-level "Invalid unicode" error instead of loading the lossily-decoded
    // (U+FFFD-substituted) text the user asked to see.
    let temp_file = if encoding != encoding_rs::UTF_8 || had_errors {
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

    // Lock the engine down once loading is complete. `enable_external_access`
    // must be disabled AFTER read_csv_auto has run (disabling it first would
    // break the load itself), and `lock_configuration` must be set LAST:
    // once it's true, every `SET` except `schema`/`search_path` is rejected —
    // including future engine-tuning settings (threads, memory_limit,
    // preserve_insertion_order, ...), so any of those must be added to this
    // batch above the lock line, never after it.
    conn.execute_batch(
        "SET enable_external_access = false; \
         SET lock_configuration = true;",
    )
    .map_err(|e| format!("DuckDB lockdown error: {}", e))?;

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let headers = view::display_columns(&conn, view::BASE_TABLE).map_err(|e| e.to_string())?;

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
            encoding_confident: confident,
            delimiter: delimiter_str,
            headers,
        },
    ))
}

#[tauri::command]
pub fn open_csv_file(
    path: String,
    tab_id: String,
    encoding: Option<String>,
    state: tauri::State<'_, DuckDBState>,
) -> Result<FileMetadata, String> {
    let (conn, metadata) = load_csv(&path, encoding.as_deref())?;

    let session = TabSession::new(conn, metadata.total_rows, metadata.headers.clone());
    state.tabs.lock().unwrap().insert(tab_id, Arc::new(session));

    Ok(metadata)
}

#[tauri::command]
pub fn close_tab(tab_id: String, state: tauri::State<'_, DuckDBState>) -> Result<(), String> {
    close(&state, &tab_id)
}

fn close(state: &DuckDBState, tab_id: &str) -> Result<(), String> {
    state.tabs.lock().unwrap().remove(tab_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_encoding_override_wins_over_detection() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/sjis_sample.csv");
        let (conn, metadata) = load_csv(path, Some("shift_jis"))
            .expect("override with the correct encoding should load");

        assert_eq!(metadata.encoding, "Shift_JIS");
        assert!(metadata.encoding_confident);

        let city: String = conn
            .query_row("SELECT city FROM csv_data LIMIT 1", [], |r| r.get(0))
            .expect("should read decoded city column");
        assert!(["東京", "大阪", "名古屋", "福岡", "札幌"].contains(&city.as_str()));
    }

    #[test]
    fn a_wrong_override_still_loads_instead_of_erroring() {
        // Regression for the had_errors temp-file fix: without it, DuckDB
        // would be handed the raw Shift_JIS bytes directly (no temp file is
        // written for a nominal UTF-8 encoding) and fail with a low-level
        // "Invalid unicode" error instead of loading lossily-decoded text.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/sjis_sample.csv");
        let (_conn, metadata) =
            load_csv(path, Some("utf-8")).expect("a wrong override should still load, not error");
        assert_eq!(metadata.encoding, "UTF-8");
    }

    #[test]
    fn an_unknown_encoding_label_is_rejected() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let err = load_csv(path, Some("not-a-real-encoding")).expect_err("should error");
        assert!(err.contains("not-a-real-encoding"), "got: {err}");
    }

    #[test]
    fn loads_shift_jis_file_without_corrupting_multibyte_text() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/sjis_sample.csv");
        let (conn, metadata) = load_csv(path, None).expect("shift_jis file should load");

        assert_eq!(metadata.encoding, "Shift_JIS");
        assert_eq!(metadata.total_rows, 10_000);
        assert!(metadata.encoding_confident);

        let city: String = conn
            .query_row("SELECT city FROM csv_data LIMIT 1", [], |r| r.get(0))
            .expect("should read decoded city column");

        assert!(
            ["東京", "大阪", "名古屋", "福岡", "札幌"].contains(&city.as_str()),
            "expected a decoded Japanese city name, got {:?}",
            city
        );
    }

    #[test]
    fn loads_utf8_file_with_multibyte_char_straddling_delimiter_sample_boundary() {
        // Regression for #6: a raw `&decoded[..DELIMITER_SAMPLE_BYTES]` slice panics
        // when byte 8_192 lands inside a multibyte character. Build a UTF-8 CSV whose
        // second column pads each row with 3-byte kanji so that the byte at offset
        // DELIMITER_SAMPLE_BYTES is not a char boundary, then confirm the load
        // succeeds instead of aborting.
        // Fixed-width rows keep the byte layout deterministic. Header is 8 bytes
        // ("id,text\n"); each row is 18 bytes ("x,あああああ\n" = 2 + 5*3 + 1), which
        // places byte 8_192 inside a 3-byte kanji rather than on a boundary.
        let header = "id,text\n";
        let mut body = String::from(header);
        let mut row = 0;
        while body.len() < DELIMITER_SAMPLE_BYTES + 64 {
            body.push_str("x,あああああ\n");
            row += 1;
        }
        assert!(
            !body.is_char_boundary(DELIMITER_SAMPLE_BYTES),
            "test fixture must straddle the boundary, adjust padding"
        );

        let temp_path =
            std::env::temp_dir().join(format!("csv-viewer-test-{}.csv", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, &body).expect("write temp fixture");
        let _cleanup = TempFile(temp_path.clone());

        let (_conn, metadata) =
            load_csv(temp_path.to_str().unwrap(), None).expect("should load without panicking");
        assert_eq!(metadata.encoding, "UTF-8");
        assert_eq!(metadata.delimiter, ",");
        assert_eq!(metadata.total_rows, row);
    }

    #[test]
    fn loads_utf8_csv_with_correct_metadata() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (_conn, metadata) = load_csv(path, None).expect("small.csv should load");

        assert_eq!(metadata.encoding, "UTF-8");
        assert!(metadata.encoding_confident);
        assert_eq!(metadata.delimiter, ",");
        assert_eq!(metadata.total_rows, 100);
        assert_eq!(metadata.total_columns, 6);
        assert_eq!(
            metadata.headers,
            vec!["id", "name", "city", "category", "value", "date"]
        );
    }

    #[test]
    fn loads_tab_delimited_file_and_detects_tab_delimiter() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-data/tab_delimited.tsv"
        );
        let (_conn, metadata) = load_csv(path, None).expect("tab_delimited.tsv should load");

        assert_eq!(metadata.delimiter, "\t");
        assert_eq!(metadata.total_rows, 10_000);
        assert_eq!(metadata.total_columns, 6);
    }

    #[test]
    fn errors_on_missing_file() {
        let err = load_csv("/no/such/path/does-not-exist.csv", None).expect_err("should error");
        assert!(err.contains("Cannot read file"), "got: {err}");
    }

    #[test]
    fn rejects_path_containing_a_null_byte() {
        let err = load_csv("/tmp/evil\0.csv", None).expect_err("should error");
        assert!(err.contains("null byte"), "got: {err}");
    }

    #[test]
    fn close_removes_the_tabs_connection() {
        let state = DuckDBState::new();
        let conn = Connection::open_in_memory().unwrap();
        let session = TabSession::new(conn, 0, vec![]);
        state
            .tabs
            .lock()
            .unwrap()
            .insert("tab-1".to_string(), Arc::new(session));
        assert!(state.tabs.lock().unwrap().contains_key("tab-1"));

        close(&state, "tab-1").expect("close should not error");

        assert!(!state.tabs.lock().unwrap().contains_key("tab-1"));
    }

    #[test]
    fn close_on_an_unknown_tab_id_is_a_no_op() {
        let state = DuckDBState::new();
        close(&state, "does-not-exist").expect("close on unknown tab should not error");
    }

    #[test]
    fn external_access_is_disabled_after_load() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, _metadata) = load_csv(path, None).expect("small.csv should load");

        let err = conn
            .execute_batch("SELECT * FROM read_csv_auto('/etc/passwd')")
            .expect_err("external file access should be blocked after lockdown");
        assert!(
            err.to_string().to_lowercase().contains("disabled")
                || err.to_string().to_lowercase().contains("external"),
            "expected an external-access error, got: {err}"
        );
    }

    #[test]
    fn configuration_is_locked_after_load() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let (conn, _metadata) = load_csv(path, None).expect("small.csv should load");

        let err = conn
            .execute_batch("SET enable_external_access = true")
            .expect_err("re-enabling a locked setting should be rejected");
        assert!(
            err.to_string().to_lowercase().contains("lock"),
            "expected a configuration-locked error, got: {err}"
        );
    }
}
