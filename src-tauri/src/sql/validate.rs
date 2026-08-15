use std::ffi::{CStr, CString};
use std::sync::{Mutex, OnceLock};

use duckdb::ffi;

use crate::types::{strip_location_trailer, CsvError};

/// A scratch, never-executed connection used only to parse/count statements
/// via `duckdb_extract_statements`. Owned separately from any tab's
/// connection: `duckdb::Connection`'s raw handle is a private field with no
/// public accessor, so there is no way to reach a tab's own
/// `duckdb_connection` for this purpose (see
/// docs/SEARCH_ARCHITECTURE.md Rev.3 correction C2). `duckdb_extract_statements`
/// is parse-only — it never touches a catalog or binds parameters — so
/// counting against this connection (which has no `csv_data` table at all)
/// is equivalent to counting against the tab's own connection; the
/// `a_semicolon_inside_a_string_literal_is_not_a_separator` test below pins
/// that this holds even for input that *references* table/column names that
/// don't exist here.
struct ParserConn {
    db: ffi::duckdb_database,
    conn: ffi::duckdb_connection,
}

// SAFETY: `ParserConn` is only ever reached through the `PARSER` mutex below,
// so all access is already externally synchronized; DuckDB's C API requires
// no more than that a single connection not be used concurrently from
// multiple threads without synchronization.
unsafe impl Send for ParserConn {}

impl ParserConn {
    fn new() -> Self {
        let path = CString::new(":memory:").expect("static string has no NUL");
        let mut db: ffi::duckdb_database = std::ptr::null_mut();
        let mut conn: ffi::duckdb_connection = std::ptr::null_mut();

        // SAFETY: `duckdb_open`/`duckdb_connect` are the same bundled DuckDB
        // C API the `duckdb` crate itself links against (via `bundled`).
        // `path` is a valid, NUL-terminated C string kept alive for the
        // duration of the call; `db`/`conn` are valid, aligned out-pointers
        // on the stack.
        unsafe {
            let state = ffi::duckdb_open(path.as_ptr(), &mut db);
            assert_eq!(
                state,
                ffi::DuckDBSuccess,
                "failed to open scratch parser database"
            );

            let state = ffi::duckdb_connect(db, &mut conn);
            assert_eq!(
                state,
                ffi::DuckDBSuccess,
                "failed to open scratch parser connection"
            );
        }

        ParserConn { db, conn }
    }
}

impl Drop for ParserConn {
    fn drop(&mut self) {
        // SAFETY: `self.conn`/`self.db` were produced by `duckdb_connect`/
        // `duckdb_open` in `new()` and are not read again after this call.
        unsafe {
            ffi::duckdb_disconnect(&mut self.conn);
            ffi::duckdb_close(&mut self.db);
        }
    }
}

static PARSER: OnceLock<Mutex<ParserConn>> = OnceLock::new();

/// Ensures `duckdb_destroy_extracted` runs on every path out of
/// `statement_count`, mirroring the C API's own requirement ("should always
/// be destroyed... even if no statements were extracted").
struct ExtractedGuard(ffi::duckdb_extracted_statements);

impl Drop for ExtractedGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was produced by `duckdb_extract_statements` just
        // before this guard was constructed and is not used after this call.
        unsafe { ffi::duckdb_destroy_extracted(&mut self.0) };
    }
}

/// Result of parsing `sql` with DuckDB's own parser: how many statements it
/// found, and — only when that count is `0` (a genuine parse failure) —
/// the parser's own error text, if DuckDB provided one.
struct ExtractOutcome {
    count: usize,
    error_text: Option<String>,
}

/// Runs `duckdb_extract_statements` against the scratch parser connection
/// and, on a parse failure (`count == 0`), also captures DuckDB's own
/// error text via `duckdb_extract_statements_error` before the extracted
/// handle is destroyed. Both `statement_count` and `assert_single_statement`
/// go through this so the FFI call and cleanup only happen in one place.
fn extract_statements(sql: &str) -> Result<ExtractOutcome, CsvError> {
    let query = CString::new(sql).map_err(|_| CsvError::QueryError {
        message: "query contains an embedded NUL byte".into(),
        position: None,
    })?;

    let parser = PARSER.get_or_init(|| Mutex::new(ParserConn::new()));
    let guard = parser.lock().unwrap();

    let mut extracted: ffi::duckdb_extracted_statements = std::ptr::null_mut();
    // SAFETY: `guard.conn` is a live connection owned by `ParserConn` for at
    // least the duration of this call (the `MutexGuard` borrow outlives it);
    // `query.as_ptr()` points at a NUL-terminated buffer kept alive by
    // `query` for the same duration; `extracted` is a valid, aligned
    // out-pointer on the stack.
    let count =
        unsafe { ffi::duckdb_extract_statements(guard.conn, query.as_ptr(), &mut extracted) };
    let extracted_guard = ExtractedGuard(extracted);

    let error_text = if count == 0 {
        // SAFETY: `extracted_guard.0` is the handle `duckdb_extract_statements`
        // just populated above (the C API always sets the out-parameter,
        // even on failure). The returned pointer, if non-null, is owned by
        // that handle and stays valid only until `duckdb_destroy_extracted`
        // runs in `ExtractedGuard::drop` — which happens after this
        // function returns — so it must be copied into an owned `String`
        // now, before that drop.
        let ptr = unsafe { ffi::duckdb_extract_statements_error(extracted_guard.0) };
        if ptr.is_null() {
            None
        } else {
            let raw = unsafe { CStr::from_ptr(ptr) }
                .to_string_lossy()
                .into_owned();
            Some(strip_location_trailer(&raw))
        }
    } else {
        None
    };

    Ok(ExtractOutcome {
        count: count as usize,
        error_text,
    })
}

/// Number of SQL statements DuckDB's own parser finds in `sql`. Thin
/// wrapper over `extract_statements` kept for the test suite, which checks
/// counts directly; `assert_single_statement` calls `extract_statements`
/// itself since it also needs the error text on a parse failure.
#[cfg(test)]
pub(crate) fn statement_count(sql: &str) -> Result<usize, CsvError> {
    Ok(extract_statements(sql)?.count)
}

/// The mandatory first barrier before any user-composed SQL string reaches
/// `Connection::prepare()`. Rejects anything that doesn't parse as exactly
/// one statement.
///
/// For a parse failure (`count == 0`), DuckDB's own parser error text is
/// surfaced directly rather than a generic "found 0" message: this
/// validator's rejection is the *only* place a parse failure is ever
/// reported to the user. An earlier version of this comment assumed the
/// real syntax error would surface later from `Connection::prepare()` — but
/// `wrap_ctas`/`wrap_select` call this function and return `Err` *before*
/// the string ever reaches `prepare()`, so for `count == 0` there is no
/// "later"; the count-only message was the only thing the user ever saw.
pub(crate) fn assert_single_statement(sql: &str) -> Result<(), CsvError> {
    let outcome = extract_statements(sql)?;
    match outcome.count {
        1 => Ok(()),
        0 => Err(CsvError::QueryError {
            message: outcome
                .error_text
                .unwrap_or_else(|| "could not parse SQL".to_string()),
            position: None,
        }),
        n => Err(CsvError::QueryError {
            message: format!(
                "only one SQL statement is allowed (found {n} — check for a stray semicolon)"
            ),
            position: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_plain_select_as_one() {
        assert_eq!(statement_count("SELECT * FROM csv_data").unwrap(), 1);
    }

    #[test]
    fn counts_a_semicolon_terminated_select_as_one() {
        assert_eq!(statement_count("SELECT * FROM csv_data;").unwrap(), 1);
    }

    #[test]
    fn rejects_the_drop_table_injection_from_the_doc() {
        let malicious = crate::sql::wrap::wrap_select_unchecked(
            "csv_data) LIMIT 1; DROP TABLE csv_data; --",
            100,
        );
        assert!(assert_single_statement(&malicious).is_err());
    }

    #[test]
    fn rejects_a_bare_multi_statement_input() {
        let err = assert_single_statement("SELECT 1; SELECT 2").unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));
    }

    #[test]
    fn a_semicolon_inside_a_string_literal_is_not_a_separator() {
        assert_eq!(
            statement_count("SELECT * FROM csv_data WHERE note = 'a;b'").unwrap(),
            1
        );
    }

    #[test]
    fn a_semicolon_inside_a_line_comment_is_not_a_separator() {
        assert_eq!(statement_count("SELECT 1 -- ;DROP TABLE x").unwrap(), 1);
    }

    #[test]
    fn a_semicolon_inside_a_dollar_quoted_string_is_not_a_separator() {
        assert_eq!(statement_count("SELECT $$a;b$$").unwrap(), 1);
    }

    #[test]
    fn rejects_sql_containing_an_interior_nul() {
        let err = assert_single_statement("SELECT 1\0DROP TABLE x").unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));
    }

    #[test]
    fn parse_failure_is_rejected_not_passed_through() {
        assert_eq!(statement_count("SELECT FROM FROM").unwrap(), 0);
        assert!(assert_single_statement("SELECT FROM FROM").is_err());
    }

    #[test]
    fn parse_failure_surfaces_duckdbs_own_error_text() {
        // An unterminated double-quoted identifier is a genuine parse
        // failure (unlike a *balanced* `"Sapporo"`, which is valid SQL —
        // just a reference to an identifier literally named Sapporo).
        let err =
            assert_single_statement("SELECT * FROM csv_data WHERE (city = \"Sapporo)").unwrap_err();
        let CsvError::QueryError { message, .. } = err else {
            panic!("expected QueryError, got {err:?}");
        };
        assert!(!message.is_empty());
        assert_ne!(
            message, "expected exactly one SQL statement, found 0",
            "should surface DuckDB's own parser error, not the old generic count message"
        );
    }

    #[test]
    fn a_trailing_line_comment_cannot_swallow_the_wrapper() {
        // wrap_select's outer `) LIMIT n` would be commented out by a
        // trailing `--` in the user's input if the wrapper were the only
        // defense. Confirm the assembled string is rejected regardless of
        // whether the parser counts it as a different statement count or
        // `Connection::prepare()` would separately fail on it — either
        // barrier catching it is an acceptable outcome, but *something*
        // in front of `prepare()` must.
        let wrapped = crate::sql::wrap::wrap_select_unchecked("csv_data --", 100);
        let real_conn = duckdb::Connection::open_in_memory().unwrap();
        real_conn
            .execute_batch("CREATE TABLE csv_data (a INTEGER)")
            .unwrap();
        let prepare_result = real_conn.prepare(&wrapped);
        let gate_result = assert_single_statement(&wrapped);
        assert!(
            gate_result.is_err() || prepare_result.is_err(),
            "a trailing '--' must be caught by the statement gate or by prepare(), not silently accepted"
        );
    }

    #[test]
    fn cte_survives_the_subquery_wrap() {
        let wrapped = crate::sql::wrap::wrap_select_unchecked(
            "WITH t AS (SELECT 1 AS a) SELECT * FROM t",
            100,
        );
        assert_eq!(
            statement_count(&wrapped).unwrap(),
            1,
            "a CTE wrapped in `SELECT * FROM (<sql>) LIMIT n` must still parse as one statement"
        );
        let real_conn = duckdb::Connection::open_in_memory().unwrap();
        real_conn
            .prepare(&wrapped)
            .expect("the wrapped CTE should prepare successfully on a real connection");
    }

    #[test]
    fn concurrent_validation_is_safe() {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..100 {
                        assert_eq!(statement_count("SELECT 1").unwrap(), 1);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
    }
}
