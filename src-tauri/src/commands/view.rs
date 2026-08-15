use duckdb::Connection;

use crate::types::CsvError;

/// The table materialized once at file-load time (see `file::load_csv`).
pub const BASE_TABLE: &str = "csv_data";
/// The table materialized by `apply_query` once a `where`/`sql` query is applied.
pub const RESULT_TABLE: &str = "csv_result";
/// `csv_data`'s stable ordinal, assigned once at load time.
pub const ROW_ID: &str = "__row_id";
/// `csv_result`'s stable ordinal, assigned each time the view is (re)materialized.
/// Deliberately distinct from `ROW_ID` so `SELECT * FROM csv_data` doesn't collide
/// with it when materialized into `csv_result` (see docs/SEARCH_ARCHITECTURE.md §2-4).
pub const VIEW_ROW_ID: &str = "__view_row_id";
/// Carries the original file row number through a `csv_result` view, when present.
pub const SRC_ROW_ID: &str = "__src_row_id";

/// Whether `col` is one of this app's internal ordinal columns rather than
/// user-visible CSV data.
pub fn is_internal(col: &str) -> bool {
    matches!(col, ROW_ID | VIEW_ROW_ID | SRC_ROW_ID)
}

/// The stable ordinal column to `ORDER BY` for `table` — `csv_data` and
/// `csv_result` each carry their own, assigned at different times (see
/// `ROW_ID`/`VIEW_ROW_ID` docs above), so this can't be a single constant.
pub fn ordinal_col(table: &str) -> &'static str {
    if table == RESULT_TABLE {
        VIEW_ROW_ID
    } else {
        ROW_ID
    }
}

/// `DESCRIBE table`'s full column list, in ordinal order, including this
/// app's internal ordinal columns. Used where a caller needs to know whether
/// an internal column (e.g. `SRC_ROW_ID`) is present, not just the
/// user-visible ones — `display_columns` below is built on this.
pub fn raw_columns(conn: &Connection, table: &str) -> Result<Vec<String>, CsvError> {
    let mut stmt = conn.prepare(&format!("DESCRIBE {table}"))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

/// `raw_columns` filtered down to user-visible columns. Unlike a plain
/// `.skip(1)` on the header list, this doesn't assume the internal ordinal
/// column is first — `csv_result` won't always have it there.
pub fn display_columns(conn: &Connection, table: &str) -> Result<Vec<String>, CsvError> {
    Ok(raw_columns(conn, table)?
        .into_iter()
        .filter(|c| !is_internal(c))
        .collect())
}

/// Which internal column (if any) in `cols` carries the original file row
/// number. A `csv_result` can carry this under two different names
/// depending on how it was produced:
/// - `SRC_ROW_ID`: `where`-mode's `build_inner_sql` renamed `csv_data`'s own
///   ordinal on the way in (see `commands::query::build_inner_sql`).
/// - `ROW_ID`: `sql`-mode passes the user's SQL through unchanged, so a
///   plain `SELECT * FROM csv_data` carries `csv_data`'s ordinal straight
///   through under its original name.
///
/// A view only ever carries one of the two in practice, but `SRC_ROW_ID` is
/// checked first to keep the check unambiguous if that ever changes.
pub fn source_row_id_col(cols: &[String]) -> Option<&'static str> {
    if cols.iter().any(|c| c == SRC_ROW_ID) {
        Some(SRC_ROW_ID)
    } else if cols.iter().any(|c| c == ROW_ID) {
        Some(ROW_ID)
    } else {
        None
    }
}

/// Doubles embedded `"` so `name` is safe to interpolate as a quoted
/// identifier (`"{quoted}"`). Column names are never available as bind
/// parameters in DuckDB, so every generated identifier must go through this.
pub fn quote_ident(name: &str) -> String {
    name.replace('"', "\"\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_columns_excludes_the_internal_ordinal() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE csv_data (__row_id INTEGER, name VARCHAR, note VARCHAR)")
            .unwrap();
        assert_eq!(
            display_columns(&conn, BASE_TABLE).unwrap(),
            vec!["name".to_string(), "note".to_string()]
        );
    }

    #[test]
    fn display_columns_excludes_the_view_ordinal_even_when_not_first() {
        let conn = Connection::open_in_memory().unwrap();
        // csv_result's ordinal is not guaranteed to be the first column once
        // arbitrary user SQL selects columns in any order.
        conn.execute_batch(
            "CREATE TABLE csv_result (name VARCHAR, __view_row_id INTEGER, note VARCHAR)",
        )
        .unwrap();
        assert_eq!(
            display_columns(&conn, RESULT_TABLE).unwrap(),
            vec!["name".to_string(), "note".to_string()]
        );
    }

    #[test]
    fn raw_columns_includes_the_internal_ordinal() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE csv_data (__row_id INTEGER, name VARCHAR)")
            .unwrap();
        assert_eq!(
            raw_columns(&conn, BASE_TABLE).unwrap(),
            vec!["__row_id".to_string(), "name".to_string()]
        );
    }

    #[test]
    fn ordinal_col_differs_by_table() {
        assert_eq!(ordinal_col(BASE_TABLE), ROW_ID);
        assert_eq!(ordinal_col(RESULT_TABLE), VIEW_ROW_ID);
    }

    #[test]
    fn source_row_id_col_prefers_src_row_id_over_row_id() {
        let cols = vec!["a".to_string(), SRC_ROW_ID.to_string(), ROW_ID.to_string()];
        assert_eq!(source_row_id_col(&cols), Some(SRC_ROW_ID));
    }

    #[test]
    fn source_row_id_col_falls_back_to_row_id() {
        // The sql-mode passthrough case: `SELECT * FROM csv_data` carries
        // csv_data's own __row_id straight through, unrenamed.
        let cols = vec!["a".to_string(), ROW_ID.to_string()];
        assert_eq!(source_row_id_col(&cols), Some(ROW_ID));
    }

    #[test]
    fn source_row_id_col_is_none_when_neither_is_present() {
        let cols = vec!["a".to_string(), "b".to_string()];
        assert_eq!(source_row_id_col(&cols), None);
    }

    #[test]
    fn quote_ident_doubles_embedded_quotes() {
        assert_eq!(quote_ident(r#"a"b"#), r#"a""b"#);
    }
}
