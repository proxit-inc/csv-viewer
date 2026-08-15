use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use duckdb::{Connection, InterruptHandle};

use crate::{
    commands::view::{self, BASE_TABLE, RESULT_TABLE, SRC_ROW_ID},
    sql,
    state::{DuckDBState, ResultView, TabSession},
    types::{CsvError, QueryOutcome, QueryPreview, QueryRequest},
};

/// Row count returned by a preview — small, since it's only ever rendered in
/// a panel under the editor (see docs/SEARCH_ARCHITECTURE.md §3-3/§3-4).
const PREVIEW_ROWS: usize = 100;

const PREVIEW_TIMEOUT_MS: u64 = 2_000;
const APPLY_TIMEOUT_MS: u64 = 10_000;

#[tauri::command]
pub async fn apply_query(
    tab_id: String,
    request: QueryRequest,
    state: tauri::State<'_, DuckDBState>,
) -> Result<QueryOutcome, String> {
    let session = state.session(&tab_id)?;
    run_with_timeout(session, APPLY_TIMEOUT_MS, move |session| {
        apply(session, &request)
    })
    .await
    .map_err(String::from)
}

#[tauri::command]
pub async fn preview_query(
    tab_id: String,
    request: QueryRequest,
    request_id: u64,
    state: tauri::State<'_, DuckDBState>,
) -> Result<QueryPreview, String> {
    let session = state.session(&tab_id)?;
    run_with_timeout(session, PREVIEW_TIMEOUT_MS, move |session| {
        preview(session, &request, request_id)
    })
    .await
    .map_err(String::from)
}

#[tauri::command]
pub fn clear_query(
    tab_id: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<QueryOutcome, String> {
    let session = state.session(&tab_id)?;
    clear(&session).map_err(String::from)
}

/// Runs `f` (synchronous DB work) on a blocking-task thread while a watchdog
/// thread waits up to `timeout_ms` and interrupts the connection if `f`
/// hasn't finished by then. `Connection` is `Send` (verified against the
/// bundled `duckdb` crate source — see docs/SEARCH_ARCHITECTURE.md §2-6), so
/// moving `session` onto `spawn_blocking`'s thread is sound; the interrupt
/// handle is independent of holding the connection's mutex, so the watchdog
/// thread never needs to lock anything itself.
///
/// Deliberately uses a `std::thread` + `Condvar` watchdog rather than
/// `tokio::time::timeout`: the project has no direct `tokio` dependency (see
/// Cargo.toml), and reaching for one just for this sleep would risk a
/// version-skew dependency separate from whatever Tauri bundles internally.
async fn run_with_timeout<T>(
    session: Arc<TabSession>,
    timeout_ms: u64,
    f: impl FnOnce(&TabSession) -> Result<T, CsvError> + Send + 'static,
) -> Result<T, CsvError>
where
    T: Send + 'static,
{
    let interrupt_handle = {
        let conn = session.conn.lock().unwrap();
        conn.interrupt_handle()
    };
    let watchdog = Watchdog::start(interrupt_handle, timeout_ms);

    let result = tauri::async_runtime::spawn_blocking(move || f(&session))
        .await
        .map_err(|e| CsvError::QueryError {
            message: format!("internal task error: {e}"),
            position: None,
        })?;

    let timed_out = watchdog.stop();
    match result {
        Err(_) if timed_out => Err(CsvError::QueryTimeout(timeout_ms)),
        other => other,
    }
}

enum WatchdogState {
    Waiting,
    Cancelled,
    Fired,
}

/// Waits up to `timeout_ms` for `stop()` to be called; if it isn't, calls
/// `handle.interrupt()` and marks itself as having fired, which
/// `run_with_timeout` uses to distinguish a genuine timeout from any other
/// error `f` might return around the same time — string-matching DuckDB's
/// interrupt error text would be fragile across versions, so this tracks the
/// outcome structurally instead.
struct Watchdog {
    state: Arc<(Mutex<WatchdogState>, Condvar)>,
    thread: std::thread::JoinHandle<()>,
}

impl Watchdog {
    fn start(handle: Arc<InterruptHandle>, timeout_ms: u64) -> Self {
        let state = Arc::new((Mutex::new(WatchdogState::Waiting), Condvar::new()));
        let state2 = Arc::clone(&state);
        let thread = std::thread::spawn(move || {
            let (lock, cvar) = &*state2;
            let guard = lock.lock().unwrap();
            let (mut guard, timeout_result) = cvar
                .wait_timeout_while(guard, Duration::from_millis(timeout_ms), |s| {
                    matches!(s, WatchdogState::Waiting)
                })
                .unwrap();
            if timeout_result.timed_out() && matches!(*guard, WatchdogState::Waiting) {
                *guard = WatchdogState::Fired;
                handle.interrupt();
            }
        });
        Watchdog { state, thread }
    }

    /// Cancels the watchdog if it hasn't fired yet and returns whether it did
    /// fire (i.e. whether the interrupt was actually sent).
    fn stop(self) -> bool {
        {
            let (lock, cvar) = &*self.state;
            let mut guard = lock.lock().unwrap();
            if matches!(*guard, WatchdogState::Waiting) {
                *guard = WatchdogState::Cancelled;
            }
            cvar.notify_one();
        }
        let _ = self.thread.join();
        let (lock, _) = &*self.state;
        matches!(*lock.lock().unwrap(), WatchdogState::Fired)
    }
}

/// Runs `f` inside an explicit `BEGIN`/`COMMIT`/`ROLLBACK`, rolling back on
/// any `Err`. Used for both `apply` (commit on success) and `preview`
/// (caller always returns before the rollback path — see `preview` below).
fn in_transaction<T>(
    conn: &Connection,
    f: impl FnOnce(&Connection) -> Result<T, CsvError>,
) -> Result<T, CsvError> {
    conn.execute_batch("BEGIN TRANSACTION")?;
    match f(conn) {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(e) => {
            // Best-effort: if the connection is already in a bad state the
            // rollback itself may fail, but the original error `e` is what
            // matters to the caller either way.
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Builds the SQL to run *inside* the CTAS/preview wrapper for `req` against
/// `table` (the tab's current view). `Sql` mode passes the user's string
/// through unchanged — wrapping and single-statement validation happen at
/// the call site (`sql::wrap_select`/`wrap_ctas`), not here. `Where` mode
/// rewrites the predicate against `table`, preserving the original file row
/// number under `SRC_ROW_ID`:
/// - `table == csv_data`: `csv_data`'s own ordinal is renamed to `SRC_ROW_ID`.
/// - `table == csv_result`: any `SRC_ROW_ID` the view already carries passes
///   through unchanged via `SELECT *`.
pub(crate) fn build_inner_sql(
    conn: &Connection,
    table: &str,
    req: &QueryRequest,
) -> Result<String, CsvError> {
    match req {
        QueryRequest::Sql { sql } => Ok(sql.clone()),
        QueryRequest::Where { predicate, sort } => {
            let ordinal = view::ordinal_col(table);
            let ordinal_q = view::quote_ident(ordinal);
            let src_select = if table == BASE_TABLE {
                format!(", \"{ordinal_q}\" AS \"{}\"", view::quote_ident(SRC_ROW_ID))
            } else {
                String::new()
            };

            let mut sql = format!(
                "SELECT * EXCLUDE (\"{ordinal_q}\"){src_select} FROM {table} WHERE ({predicate})"
            );

            if !sort.is_empty() {
                let display_cols = view::display_columns(conn, table)?;
                let mut clauses = Vec::with_capacity(sort.len());
                for spec in sort {
                    if !display_cols.iter().any(|c| c == &spec.column) {
                        return Err(CsvError::QueryError {
                            message: format!("unknown sort column: {}", spec.column),
                            position: None,
                        });
                    }
                    let quoted = view::quote_ident(&spec.column);
                    let dir = if spec.descending { "DESC" } else { "ASC" };
                    // The column is app-generated SQL (the user clicked a
                    // header, they didn't type this), so it's safe to numify
                    // it here in a way user-authored WHERE predicates
                    // deliberately are not (see docs/SEARCH_ARCHITECTURE.md
                    // §8's two-track VARCHAR policy): every column is
                    // VARCHAR (`all_varchar=true` at load), so an unadorned
                    // `ORDER BY "value"` would sort "100.5" before "9" —
                    // lexicographically, not numerically. `TRY_CAST` yields
                    // NULL instead of erroring on a non-numeric cell, and
                    // `NULLS LAST` keeps those parked at the end either way.
                    let expr = if column_is_numeric(conn, table, &spec.column)? {
                        format!("TRY_CAST(\"{quoted}\" AS DOUBLE)")
                    } else {
                        format!("\"{quoted}\"")
                    };
                    clauses.push(format!("{expr} {dir} NULLS LAST"));
                }
                sql.push_str(" ORDER BY ");
                sql.push_str(&clauses.join(", "));
            }

            Ok(sql)
        }
    }
}

/// Whether every non-null value in `table.col` parses as a number.
/// Recomputed on each sort request rather than cached: it's one lightweight
/// aggregate scan, and sorting is a per-click action (not a per-keystroke
/// one), so the added query cost is negligible against the complexity of
/// invalidating a cache when the underlying view changes.
fn column_is_numeric(conn: &Connection, table: &str, col: &str) -> Result<bool, CsvError> {
    let quoted = view::quote_ident(col);
    let sql = format!(
        "SELECT count(\"{quoted}\") > 0 AND count(\"{quoted}\") = count(TRY_CAST(\"{quoted}\" AS DOUBLE)) \
         FROM {table}"
    );
    Ok(conn.query_row(&sql, [], |r| r.get(0))?)
}

fn description_for(req: &QueryRequest) -> &'static str {
    match req {
        QueryRequest::Where { .. } => "filtered",
        QueryRequest::Sql { .. } => "sql",
    }
}

/// Pulls the column name out of DuckDB's `Binder Error: Referenced column
/// "<name>" not found in FROM clause!` message shape, or `None` if the
/// message doesn't match that shape (e.g. any other Binder/Catalog error).
fn column_not_found_name(message: &str) -> Option<&str> {
    let after = message.strip_prefix("Binder Error: Referenced column \"")?;
    let (name, rest) = after.split_once('"')?;
    rest.starts_with(" not found in FROM clause!")
        .then_some(name)
}

/// Replaces a "column not found" error with a plain-language explanation
/// when it looks like the classic double-quotes-instead-of-single-quotes
/// mistake: in SQL, double quotes name an *identifier* (a column), not a
/// text value — a predicate like `city = "Sapporo"` means "does city equal
/// the column named Sapporo", not "does city equal the text Sapporo".
/// Detected by checking whether the *exact* missing name appears
/// double-quoted in `original_sql` (the un-wrapped predicate/SQL the user
/// actually typed, before any of this app's own internal wrapping).
/// Deliberately does NOT fire for a bare, unquoted identifier (e.g. a
/// genuinely misspelled column name like `citty = 'Tokyo'`) — that produces
/// the exact same DuckDB message shape but is a different mistake, and
/// "use single quotes" would be actively wrong advice there.
///
/// This *replaces* rather than appends to DuckDB's own message: appending a
/// plain-language hint after "DuckDB error: Binder Error: ... Candidate
/// bindings: ..." still buried the one useful sentence behind three lines
/// of engine jargon (and an unhelpful candidate — "category" has nothing to
/// do with "Sapporo", it's just DuckDB's nearest-name guess). When we're
/// this confident about the cause, showing only the plain explanation is
/// clearer than showing both.
fn friendly_message_for_double_quoted_string(message: &str, original_sql: &str) -> Option<String> {
    let name = column_not_found_name(message)?;
    if !original_sql.contains(&format!("\"{name}\"")) {
        return None;
    }
    Some(format!(
        "\"{name}\" is being read as a column name, not text — for a text value, use single quotes: '{name}'"
    ))
}

/// Runs `f` (whatever DuckDB call actually executes/binds `original_sql`),
/// and if it fails, converts the error via the usual `CsvError::from`
/// (which already strips the internal-SQL trailer — see
/// `types::strip_location_trailer`), then — using the *original*,
/// user-typed predicate/SQL as context that the generic
/// `From<duckdb::Error>` conversion doesn't have access to — swaps in a
/// `friendly_message_for_double_quoted_string` result when one applies.
/// `CsvError::QueryError`, not `DuckDbError`, on that path: from the user's
/// perspective this is "something about the query you wrote", not a
/// mysterious backend failure, and `QueryError`'s `Invalid query: {message}`
/// prefix is the same one the sql::validate gate's messages already use.
fn run_with_quote_hint<T>(
    original_sql: &str,
    f: impl FnOnce() -> Result<T, duckdb::Error>,
) -> Result<T, CsvError> {
    f().map_err(|e| {
        let err = CsvError::from(e);
        let CsvError::DuckDbError(message) = &err else {
            return err;
        };
        match friendly_message_for_double_quoted_string(message, original_sql) {
            Some(message) => CsvError::QueryError {
                message,
                position: None,
            },
            None => err,
        }
    })
}

pub(crate) fn apply(session: &TabSession, req: &QueryRequest) -> Result<QueryOutcome, CsvError> {
    let start = Instant::now();
    let conn = session.conn.lock().unwrap();
    let (table, _generation, _src) = session.current_view();

    let inner = build_inner_sql(&conn, &table, req)?;
    let ctas = sql::wrap_ctas(&inner)?;

    let (total_rows, truncated) = in_transaction(&conn, |conn| {
        // `wrap_ctas` uses `CREATE OR REPLACE TABLE`, which atomically
        // replaces `csv_result` after its SELECT has been evaluated — no
        // separate `DROP` beforehand. That matters for chaining: when the
        // current view already *is* `csv_result` (narrowing an existing
        // filter further), `inner`'s `FROM csv_result` must still see the
        // old table while the new one is being computed. A `DROP` here
        // would destroy that source out from under the CTAS.
        run_with_quote_hint(&inner, || conn.execute_batch(&ctas))?;

        let raw_count: usize =
            conn.query_row(&format!("SELECT COUNT(*) FROM {RESULT_TABLE}"), [], |r| {
                r.get(0)
            })?;
        let truncated = raw_count > sql::MAX_RESULT_ROWS;
        if truncated {
            conn.execute_batch(&format!(
                "DELETE FROM {RESULT_TABLE} WHERE \"{}\" >= {}",
                view::quote_ident(view::VIEW_ROW_ID),
                sql::MAX_RESULT_ROWS
            ))?;
        }

        // Catalog assertion: confirm the query didn't mutate csv_data itself
        // (e.g. via a bypass of the Step 2a gate). DuckDB's transactional
        // DDL means an early return here rolls back the CTAS/DELETE above
        // too, not just this check.
        let base_rows: usize =
            conn.query_row(&format!("SELECT COUNT(*) FROM {BASE_TABLE}"), [], |r| {
                r.get(0)
            })?;
        if base_rows != session.base_total_rows {
            return Err(CsvError::QueryError {
                message: "query modified the source table".into(),
                position: None,
            });
        }

        Ok((raw_count.min(sql::MAX_RESULT_ROWS), truncated))
    })?;

    let raw_result_cols = view::raw_columns(&conn, RESULT_TABLE)?;
    let src_row_id_col = view::source_row_id_col(&raw_result_cols);
    let has_source_row_id = src_row_id_col.is_some();
    let columns: Vec<String> = raw_result_cols
        .into_iter()
        .filter(|c| !view::is_internal(c))
        .collect();

    drop(conn);
    let generation = session.bump_generation();
    let description = description_for(req).to_string();

    *session.result.lock().unwrap() = Some(ResultView {
        table: RESULT_TABLE.to_string(),
        total_rows,
        src_row_id_col,
    });

    Ok(QueryOutcome {
        generation,
        columns,
        total_rows,
        truncated,
        has_source_row_id,
        elapsed_ms: start.elapsed().as_millis() as u64,
        description,
    })
}

pub(crate) fn preview(
    session: &TabSession,
    req: &QueryRequest,
    request_id: u64,
) -> Result<QueryPreview, CsvError> {
    let start = Instant::now();
    let conn = match session.conn.try_lock() {
        Ok(conn) => conn,
        Err(_) => {
            // A long-running apply_query is holding the connection. Tell the
            // frontend to keep showing its last successful preview rather
            // than queuing behind it (see docs/SEARCH_ARCHITECTURE.md §5.1).
            return Ok(QueryPreview {
                request_id,
                columns: vec![],
                rows: vec![],
                elapsed_ms: 0,
                busy: true,
            });
        }
    };
    let (table, _generation, _src) = session.current_view();
    let inner = build_inner_sql(&conn, &table, req)?;
    let wrapped = sql::wrap_select(&inner, PREVIEW_ROWS)?;

    // Always rolled back, as defense in depth (docs/SEARCH_ARCHITECTURE.md
    // §1 decision 5) — DDL/DML can't appear in `wrap_select`'s `FROM (...)`
    // subquery position at all, so this mainly guards against a future
    // relaxation of that shape rather than anything reachable today. Note
    // this does NOT roll back every possible side effect: DuckDB sequences
    // (`nextval`), like Postgres, advance outside the transaction and are
    // not affected by ROLLBACK.
    conn.execute_batch("BEGIN TRANSACTION")?;
    let result = (|| -> Result<QueryPreview, CsvError> {
        let mut stmt = run_with_quote_hint(&inner, || conn.prepare(&wrapped))?;
        let mut rows = stmt.query([])?;
        let raw_columns = rows
            .as_ref()
            .expect("query() always sets the statement")
            .column_names();
        let display_idx: Vec<usize> = raw_columns
            .iter()
            .enumerate()
            .filter(|(_, c)| !view::is_internal(c))
            .map(|(i, _)| i)
            .collect();
        let columns: Vec<String> = display_idx
            .iter()
            .map(|&i| raw_columns[i].clone())
            .collect();

        // Reads every display cell as `Option<String>` — safe for any
        // column type because `wrap_select` already casts the whole
        // projection with `COLUMNS(*)::VARCHAR` (see `sql::wrap::wrap_select_impl`).
        let mut out_rows = Vec::new();
        while let Some(row) = rows.next()? {
            let cells: Vec<String> = display_idx
                .iter()
                .map(|&i| {
                    row.get::<_, Option<String>>(i)
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                })
                .collect();
            out_rows.push(cells);
        }

        Ok(QueryPreview {
            request_id,
            columns,
            rows: out_rows,
            elapsed_ms: start.elapsed().as_millis() as u64,
            busy: false,
        })
    })();
    let _ = conn.execute_batch("ROLLBACK");
    result
}

pub(crate) fn clear(session: &TabSession) -> Result<QueryOutcome, CsvError> {
    let conn = session.conn.lock().unwrap();
    conn.execute_batch(&format!("DROP TABLE IF EXISTS {RESULT_TABLE}"))?;
    *session.result.lock().unwrap() = None;
    let generation = session.bump_generation();

    Ok(QueryOutcome {
        generation,
        columns: session.base_columns.clone(),
        total_rows: session.base_total_rows,
        truncated: false,
        has_source_row_id: true,
        elapsed_ms: 0,
        description: BASE_TABLE.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{data::get_range_for_session, file::load_csv};

    fn session_for(path: &str) -> TabSession {
        let (conn, metadata) = load_csv(path, None).expect("fixture should load");
        TabSession::new(conn, metadata.total_rows, metadata.headers)
    }

    fn where_req(predicate: &str) -> QueryRequest {
        QueryRequest::Where {
            predicate: predicate.to_string(),
            sort: vec![],
        }
    }

    fn sql_req(sql: &str) -> QueryRequest {
        QueryRequest::Sql {
            sql: sql.to_string(),
        }
    }

    fn sorted_where_req(predicate: &str, column: &str, descending: bool) -> QueryRequest {
        QueryRequest::Where {
            predicate: predicate.to_string(),
            sort: vec![crate::types::SortSpec {
                column: column.to_string(),
                descending,
            }],
        }
    }

    #[test]
    fn where_mode_narrows_the_view_and_preserves_source_row_ids() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let outcome =
            apply(&session, &where_req("city = 'Sapporo'")).expect("apply should succeed");
        assert!(outcome.total_rows > 0);
        assert!(outcome.has_source_row_id);

        let range = get_range_for_session(&session, 0, outcome.total_rows)
            .expect("range fetch should not error");
        assert_eq!(
            range.row_ids.as_ref().map(|r| r.len()),
            Some(outcome.total_rows)
        );
        for row in &range.rows {
            assert!(row.iter().any(|c| c == "Sapporo"));
        }
    }

    #[test]
    fn apply_then_get_data_range_reads_the_filtered_view() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let outcome = apply(&session, &where_req("1=1")).expect("apply should succeed");
        assert_eq!(outcome.total_rows, 100);

        let range = get_range_for_session(&session, 0, 5).expect("range fetch should not error");
        assert_eq!(range.total_rows, 100);
        assert_eq!(range.rows.len(), 5);
    }

    #[test]
    fn apply_bumps_generation_and_data_range_echoes_it() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);
        assert_eq!(session.generation(), 0);

        let outcome = apply(&session, &where_req("1=1")).expect("apply should succeed");
        assert_eq!(outcome.generation, 1);

        let range = get_range_for_session(&session, 0, 1).unwrap();
        assert_eq!(range.generation, 1);
    }

    #[test]
    fn clear_query_drops_csv_result_and_reverts_to_csv_data() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        apply(&session, &where_req("city = 'Sapporo'")).expect("apply should succeed");
        let outcome = clear(&session).expect("clear should succeed");
        assert_eq!(outcome.total_rows, 100);

        let range = get_range_for_session(&session, 0, 5).unwrap();
        assert_eq!(range.total_rows, 100);
    }

    #[test]
    fn a_second_apply_chains_off_the_first_and_replaces_csv_result() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let first = apply(&session, &where_req("city = 'Sapporo'")).expect("apply should succeed");
        assert!(first.total_rows > 0 && first.total_rows < 100);

        // apply_query always runs against the tab's *current* view (see
        // docs/SEARCH_ARCHITECTURE.md §3-3), so a predicate matching
        // everything in the already-Sapporo-filtered csv_result leaves the
        // count unchanged rather than resetting to the full 100-row file.
        let second = apply(&session, &where_req("1=1")).expect("apply should succeed");
        assert_eq!(second.total_rows, first.total_rows);

        // A predicate that matches nothing in the current (Sapporo-only)
        // view proves this apply *replaced* csv_result's contents rather
        // than accumulating into it — if rows had merely been appended, the
        // first apply's Sapporo rows would still be present.
        let third = apply(&session, &where_req("city = 'Tokyo'")).expect("apply should succeed");
        assert_eq!(third.total_rows, 0);
    }

    #[test]
    fn where_predicate_containing_a_statement_separator_is_rejected() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = apply(&session, &where_req("1=1; DROP TABLE csv_data; --")).unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));

        // csv_data must be untouched.
        let conn = session.conn.lock().unwrap();
        let count: usize = conn
            .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 100);
    }

    #[test]
    fn a_parser_error_message_has_no_internal_sql_leaking_through() {
        // An unterminated quote is the worst case for leakage: the "at or
        // near" snippet DuckDB echoes swallows everything from the unclosed
        // quote to the end of the *wrapped* CTAS string, which is mostly
        // our own internal syntax, not anything the user typed.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = apply(&session, &where_req("city = \"Sapporo")).unwrap_err();
        let CsvError::QueryError { message, .. } = err else {
            panic!("expected QueryError, got {err:?}");
        };
        assert_eq!(message, "Parser Error: unterminated quoted identifier");
        assert!(!message.contains("__row_id"));
        assert!(!message.contains("csv_result"));
        assert!(!message.contains("LIMIT"));
    }

    #[test]
    fn a_binder_error_message_has_no_internal_sql_leaking_through() {
        // A bare, unquoted, misspelled column reference — genuinely a
        // Binder Error with no double-quote-mistake pattern to rewrite (see
        // `a_double_quoted_column_not_found_gets_a_friendly_message` for
        // that case, which now returns a different `CsvError` variant).
        // This fails at execution, *not* at the sql::validate gate (it
        // parses as valid SQL), so it exercises a different error path than
        // the statement-separator rejection above — one that used to leak
        // the fully wrapped CTAS (`__row_id`, `csv_result`,
        // `LIMIT 1000001`, ...) into the message.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = apply(&session, &where_req("citty = 'Tokyo'")).unwrap_err();
        let CsvError::DuckDbError(message) = err else {
            panic!("expected DuckDbError, got {err:?}");
        };
        assert!(message.contains("citty"));
        assert!(!message.contains("__row_id"));
        assert!(!message.contains("csv_result"));
        assert!(!message.contains("LINE 1"));
    }

    #[test]
    fn a_double_quoted_column_not_found_gets_a_friendly_message() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = apply(&session, &where_req("city = \"Sapporo\"")).unwrap_err();
        // A `QueryError`, not `DuckDbError`: this replaces DuckDB's raw
        // "Binder Error: ... Candidate bindings: ..." text entirely, it
        // doesn't just append a hint after it (see
        // `friendly_message_for_double_quoted_string`'s doc comment for why).
        let CsvError::QueryError { message, .. } = err else {
            panic!("expected QueryError, got {err:?}");
        };
        assert_eq!(
            message,
            "\"Sapporo\" is being read as a column name, not text — for a text value, use single quotes: 'Sapporo'"
        );
    }

    #[test]
    fn a_misspelled_bare_column_name_keeps_duckdbs_own_message() {
        // `citty` (unquoted) produces the identical DuckDB message shape as
        // the double-quoted case above, but it's a genuine typo of a column
        // name, not a string-vs-identifier mix-up — the friendly rewrite
        // would be wrong advice here, so DuckDB's own (already-clean, see
        // `a_binder_error_message_has_no_internal_sql_leaking_through`)
        // message is kept as-is.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = apply(&session, &where_req("citty = 'Tokyo'")).unwrap_err();
        let CsvError::DuckDbError(message) = err else {
            panic!("expected DuckDbError, got {err:?}");
        };
        assert!(message.contains("citty"));
        assert!(!message.contains("is being read as a column name"));
    }

    #[test]
    fn preview_also_gets_the_friendly_message() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = preview(&session, &where_req("city = \"Sapporo\""), 1).unwrap_err();
        let CsvError::QueryError { message, .. } = err else {
            panic!("expected QueryError, got {err:?}");
        };
        assert!(message.contains("is being read as a column name"));
    }

    #[test]
    fn preview_never_creates_a_table_even_when_attempted() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        // `wrap_select`'s `SELECT * FROM (<inner>) LIMIT n` shape only
        // accepts a query expression in the subquery position, so DDL like
        // `CREATE TABLE` can't even parse there — this is rejected before
        // `preview`'s BEGIN/ROLLBACK is ever reached.
        let sql_req = QueryRequest::Sql {
            sql: "CREATE TABLE side_effect (a INTEGER)".to_string(),
        };
        let err = preview(&session, &sql_req, 1).unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));

        let conn = session.conn.lock().unwrap();
        let exists: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM (DESCRIBE) WHERE name = 'side_effect'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        assert_eq!(exists, 0, "preview must not leave a created table behind");
    }

    #[test]
    fn preview_returns_at_most_100_rows_and_echoes_request_id() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let result = preview(&session, &where_req("1=1"), 42).expect("preview should succeed");
        assert_eq!(result.request_id, 42);
        assert!(!result.busy);
        assert!(result.rows.len() <= PREVIEW_ROWS);
    }

    #[test]
    fn preview_renders_a_non_varchar_column_as_text() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let result = preview(&session, &sql_req("SELECT count(*) AS n FROM csv_data"), 1)
            .expect("preview should succeed");
        assert_eq!(result.rows[0][0], "100");
    }

    #[test]
    fn search_after_apply_returns_view_coordinates() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);
        apply(&session, &where_req("city = 'Sapporo'")).expect("apply should succeed");

        let (table, _gen, _src) = session.current_view();
        let ordinal = view::ordinal_col(&table);

        let conn = session.conn.lock().unwrap();
        let response =
            crate::commands::search::search_in(&conn, &table, ordinal, "Sapporo").unwrap();
        assert!(!response.hits.is_empty());
        // Every hit row index must be valid within the *filtered* view.
        let view_row_count: usize = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        for hit in &response.hits {
            assert!(hit.row < view_row_count);
        }
    }

    #[test]
    fn sql_mode_replaces_the_result_set_with_an_aggregation() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let outcome = apply(
            &session,
            &sql_req("SELECT city, count(*) AS n FROM csv_data GROUP BY city"),
        )
        .expect("apply should succeed");
        assert_eq!(outcome.columns, vec!["city".to_string(), "n".to_string()]);
        assert!(
            !outcome.has_source_row_id,
            "an aggregation has no source row identity"
        );

        let range = get_range_for_session(&session, 0, outcome.total_rows)
            .expect("range fetch should not error");
        assert_eq!(range.row_ids, None);

        // `n` is a BIGINT column (count(*)), not VARCHAR like every other
        // column in the app — regression check that its cells render as
        // their text form ("5") rather than silently reading back empty.
        let n_idx = outcome.columns.iter().position(|c| c == "n").unwrap();
        let total: i64 = range
            .rows
            .iter()
            .map(|r| r[n_idx].parse::<i64>().unwrap())
            .sum();
        assert_eq!(
            total, 100,
            "counts across all cities should sum to the full 100 rows"
        );
    }

    #[test]
    fn sql_mode_select_star_keeps_the_source_row_id() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        // Regression for the __row_id/__view_row_id naming collision found in
        // docs/SEARCH_ARCHITECTURE.md §2-4: a plain `SELECT * FROM csv_data`
        // carries csv_data's own `__row_id` straight through as a column,
        // which the CTAS's own `row_number() OVER () AS __view_row_id` must
        // not collide with.
        let outcome =
            apply(&session, &sql_req("SELECT * FROM csv_data")).expect("apply should succeed");
        assert!(outcome.has_source_row_id);
        assert_eq!(outcome.total_rows, 100);
        assert!(!outcome.columns.contains(&"__row_id".to_string()));
        assert!(!outcome.columns.contains(&"__view_row_id".to_string()));
    }

    #[test]
    fn cte_query_executes_through_apply() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let outcome = apply(
            &session,
            &sql_req("WITH t AS (SELECT * FROM csv_data) SELECT * FROM t WHERE city = 'Sapporo'"),
        )
        .expect("a CTE-based query should apply successfully");
        assert!(outcome.total_rows > 0);
    }

    #[test]
    fn duplicate_output_column_names_are_auto_deduplicated_by_duckdb() {
        // Verified against the bundled DuckDB, contrary to an earlier
        // assumption: CTAS does not error on `SELECT x, x` (nor even on two
        // columns explicitly given the same alias) — it silently renames the
        // second one with a `_1` suffix. There is no "duplicate column"
        // error to translate into a friendlier `QueryError` here.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let outcome = apply(
            &session,
            &sql_req("SELECT city AS x, id AS x FROM csv_data"),
        )
        .expect("DuckDB auto-deduplicates rather than erroring");
        assert_eq!(outcome.columns, vec!["x".to_string(), "x_1".to_string()]);
    }

    #[test]
    fn preview_timeout_returns_query_timeout() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = Arc::new(session_for(path));
        // Deliberately expensive: hashing + a LIKE scan over several million
        // synthetic rows reliably runs well past a tiny test-only timeout
        // without needing an enormous or memory-heavy dataset.
        let req = sql_req(
            "SELECT count(*) FROM range(20000000) t(i) WHERE md5(i::VARCHAR) LIKE '%zzzzzzzz%'",
        );

        let result = tauri::async_runtime::block_on(run_with_timeout(session, 20, move |s| {
            preview(s, &req, 1)
        }));

        assert!(
            matches!(result, Err(CsvError::QueryTimeout(20))),
            "expected a QueryTimeout, got {result:?}"
        );
    }

    #[test]
    fn run_with_timeout_does_not_time_out_a_fast_query() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = Arc::new(session_for(path));
        let req = where_req("1=1");

        let result = tauri::async_runtime::block_on(run_with_timeout(session, 5_000, move |s| {
            apply(s, &req)
        }));

        assert!(
            result.is_ok(),
            "expected a fast query not to be timed out: {result:?}"
        );
    }

    #[test]
    fn sort_spec_on_a_numeric_varchar_column_orders_numerically_not_lexicographically() {
        // All columns are VARCHAR (all_varchar=true at load), so a naive
        // ORDER BY would sort "100" before "9" lexicographically. A
        // synthetic table pins this precisely rather than relying on
        // small.csv's actual (harder to predict) values.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE csv_data AS \
             SELECT * FROM (VALUES (0, '9'), (1, '100'), (2, '10')) AS t(__row_id, n)",
        )
        .unwrap();
        let session = TabSession::new(conn, 3, vec!["n".to_string()]);

        let outcome =
            apply(&session, &sorted_where_req("1=1", "n", false)).expect("apply should succeed");
        let range = get_range_for_session(&session, 0, outcome.total_rows).unwrap();
        let values: Vec<&str> = range.rows.iter().map(|r| r[0].as_str()).collect();
        assert_eq!(values, vec!["9", "10", "100"]);
    }

    #[test]
    fn sort_spec_orders_a_non_numeric_column_lexicographically() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let outcome =
            apply(&session, &sorted_where_req("1=1", "city", false)).expect("apply should succeed");
        let range = get_range_for_session(&session, 0, 5).unwrap();
        let city_idx = outcome.columns.iter().position(|c| c == "city").unwrap();
        let cities: Vec<&str> = range.rows.iter().map(|r| r[city_idx].as_str()).collect();
        let mut sorted = cities.clone();
        sorted.sort();
        assert_eq!(cities, sorted);
    }

    #[test]
    fn sort_spec_rejects_a_column_not_in_the_current_view() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        let err = apply(
            &session,
            &sorted_where_req("1=1", "not_a_real_column", false),
        )
        .unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));
    }

    #[test]
    fn sort_composes_with_an_existing_filter() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        apply(&session, &where_req("city = 'Sapporo'")).expect("filter should apply");
        let outcome = apply(&session, &sorted_where_req("1=1", "value", false))
            .expect("sort on the filtered view should apply");

        // Sorting must narrow further off the already-filtered view (the
        // same chaining semantics as any other apply), not reset to all 100
        // rows.
        assert!(outcome.total_rows > 0 && outcome.total_rows < 100);
    }

    #[test]
    fn sort_applies_to_a_sql_result_view() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/small.csv");
        let session = session_for(path);

        apply(
            &session,
            &sql_req("SELECT city, count(*) AS n FROM csv_data GROUP BY city"),
        )
        .expect("sql apply should succeed");
        let outcome = apply(&session, &sorted_where_req("1=1", "n", true))
            .expect("sort on the sql result view should apply");

        let range = get_range_for_session(&session, 0, outcome.total_rows).unwrap();
        let n_idx = outcome.columns.iter().position(|c| c == "n").unwrap();
        let counts: Vec<i64> = range
            .rows
            .iter()
            .map(|r| r[n_idx].parse().unwrap())
            .collect();
        let mut sorted_desc = counts.clone();
        sorted_desc.sort_by(|a, b| b.cmp(a));
        assert_eq!(counts, sorted_desc);
    }
}
