use crate::{
    commands::view::{quote_ident, RESULT_TABLE, VIEW_ROW_ID},
    sql::validate::assert_single_statement,
    types::CsvError,
};

/// Row cap enforced by `wrap_ctas`'s own `LIMIT`, which — unlike a `LIMIT`
/// interpolated next to user SQL — sits outside the user's string entirely
/// and so can't be defeated by a trailing `--` comment (see
/// docs/SEARCH_ARCHITECTURE.md §4-2(b)). `+ 1` on the applied `LIMIT` lets
/// the caller detect truncation from the materialized row count alone.
pub(crate) const MAX_RESULT_ROWS: usize = 1_000_000;

fn wrap_select_impl(user_sql: &str, limit: usize) -> String {
    // `COLUMNS(*)::VARCHAR` rather than a plain `*`: preview's only consumer
    // reads every cell back as a string (it never needs a column's native
    // type, unlike the row-id column `get_data_range_in` reads elsewhere),
    // and a non-VARCHAR result (e.g. `count(*)` is BIGINT) would otherwise
    // read back as an empty string — verified against duckdb-rs's `impl
    // FromSql for String`, which does not stringify other DuckDB types.
    format!("SELECT COLUMNS(*)::VARCHAR FROM ({user_sql}) LIMIT {limit}")
}

/// Builds the `SELECT * FROM (<user_sql>) LIMIT <limit>` wrapper without
/// validating it. Exists only so `validate`'s tests can construct
/// known-malicious payloads to prove the gate catches them; every non-test
/// caller must go through `wrap_select`/`wrap_ctas` instead, whose API
/// contract is "the returned string has already passed
/// `assert_single_statement`".
#[cfg(test)]
pub(super) fn wrap_select_unchecked(user_sql: &str, limit: usize) -> String {
    wrap_select_impl(user_sql, limit)
}

/// `SELECT * FROM (<user_sql>) LIMIT <limit>`, validated as a single
/// statement before being returned. `limit` here is not itself a security
/// boundary (a trailing `--` in `user_sql` can comment out the `)  LIMIT`
/// that follows it) — it exists to cap preview result sizes. The real
/// row-count ceiling for a committed view lives in `wrap_ctas`'s `LIMIT`,
/// which sits outside the user's string and can't be commented out.
pub(crate) fn wrap_select(user_sql: &str, limit: usize) -> Result<String, CsvError> {
    let sql = wrap_select_impl(user_sql, limit);
    assert_single_statement(&sql)?;
    Ok(sql)
}

/// `CREATE OR REPLACE TABLE csv_result AS SELECT (row_number() OVER () - 1)
/// AS __view_row_id, * FROM (<inner_sql>) LIMIT MAX_RESULT_ROWS + 1`,
/// validated as a single statement before being returned. `__view_row_id` is
/// deliberately distinct from `csv_data`'s own `__row_id` so a plain
/// `SELECT * FROM csv_data` as `inner_sql` doesn't collide with it (see
/// docs/SEARCH_ARCHITECTURE.md §2-4).
pub(crate) fn wrap_ctas(inner_sql: &str) -> Result<String, CsvError> {
    let sql = format!(
        "CREATE OR REPLACE TABLE {RESULT_TABLE} AS \
         SELECT (row_number() OVER () - 1) AS \"{view_row_id}\", * \
         FROM ({inner_sql}) LIMIT {limit}",
        view_row_id = quote_ident(VIEW_ROW_ID),
        limit = MAX_RESULT_ROWS + 1
    );
    assert_single_statement(&sql)?;
    Ok(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_select_accepts_a_single_statement() {
        let wrapped = wrap_select("SELECT * FROM csv_data", 100).unwrap();
        assert!(wrapped
            .starts_with("SELECT COLUMNS(*)::VARCHAR FROM (SELECT * FROM csv_data) LIMIT 100"));
    }

    #[test]
    fn wrap_select_rejects_a_multi_statement_payload() {
        let err = wrap_select("csv_data) LIMIT 1; DROP TABLE csv_data; --", 100).unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));
    }

    #[test]
    fn wrap_ctas_references_the_result_table_and_view_row_id() {
        let wrapped = wrap_ctas("SELECT * FROM csv_data").unwrap();
        assert!(wrapped.contains(RESULT_TABLE));
        assert!(wrapped.contains(VIEW_ROW_ID));
        assert!(wrapped.contains(&format!("LIMIT {}", MAX_RESULT_ROWS + 1)));
    }

    #[test]
    fn wrap_ctas_rejects_a_multi_statement_inner_query() {
        let err = wrap_ctas("csv_data) LIMIT 1; DROP TABLE csv_data; --").unwrap_err();
        assert!(matches!(err, CsvError::QueryError { .. }));
    }
}
