use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub filename: String,
    pub file_path: String,
    pub file_size: u64,
    pub total_rows: usize,
    pub total_columns: usize,
    pub encoding: String,
    pub delimiter: String,
    pub headers: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRange {
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    /// Echoed back from the request so the frontend can silently discard a
    /// response that arrives after a newer query was applied (see
    /// docs/SEARCH_ARCHITECTURE.md §2-3) instead of treating a stale
    /// generation as an error.
    pub generation: u64,
    /// The original file row number for each returned row, when the current
    /// view still carries one (`#` column display); `None` when viewing an
    /// aggregation or other query that doesn't preserve row identity.
    pub row_ids: Option<Vec<usize>>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub row: usize,
    pub column: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub total_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum QueryRequest {
    Where {
        predicate: String,
        sort: Vec<SortSpec>,
    },
    Sql {
        sql: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutcome {
    pub generation: u64,
    pub columns: Vec<String>,
    pub total_rows: usize,
    pub truncated: bool,
    pub has_source_row_id: bool,
    pub elapsed_ms: u64,
    pub description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPreview {
    pub request_id: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub elapsed_ms: u64,
    /// True when the tab's connection was busy (e.g. an `apply_query` in
    /// flight) and this preview attempt was skipped rather than queued —
    /// the frontend should keep showing its last successful preview.
    pub busy: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum CsvError {
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Encoding detection failed")]
    EncodingError,
    #[error("CSV parse error: {0}")]
    ParseError(String),
    #[error("Tab not found: {0}")]
    TabNotFound(String),
    #[error("DuckDB error: {0}")]
    DuckDbError(String),
    #[error("Invalid query: {message}")]
    QueryError {
        message: String,
        position: Option<usize>,
    },
    #[error("Query timed out after {0} ms")]
    QueryTimeout(u64),
}

impl From<CsvError> for String {
    fn from(err: CsvError) -> String {
        err.to_string()
    }
}

impl From<duckdb::Error> for CsvError {
    fn from(e: duckdb::Error) -> Self {
        CsvError::DuckDbError(strip_location_trailer(&e.to_string()))
    }
}

/// DuckDB error messages echo a snippet of the exact SQL that was executed
/// in two different places, both of which this app strips: a
/// `\n\nLINE N: <snippet>\n<caret>` trailer, and — specifically for parser
/// errors — an inline `... at or near "<snippet>"` clause inside the
/// summary line itself (DuckDB's/Postgres's standard parser-error phrasing).
/// For any query this app runs, either snippet is a fragment of the fully
/// wrapped, internal-column-name-laden statement (`__row_id`, `csv_result`,
/// the CTAS's own `LIMIT 1000001`, ...) — useful when debugging this app's
/// own code, but meaningless noise to someone who only typed a WHERE
/// predicate or a `SELECT`. This is most visible on an *unterminated*
/// quote/identifier: the snippet swallows everything from the unclosed
/// quote to the end of the wrapped string, which is mostly our own wrapper
/// text, not the user's.
///
/// Used by both this `From` impl and
/// `sql::validate::extract_statements`'s parse-failure path, so the same
/// trimming rule applies to every DuckDB-originated message a user can see,
/// however it reached us. Binder/Catalog errors (e.g. "column not found")
/// don't use either phrasing and pass through unchanged — DuckDB's own
/// category-plus-description text for those is already specific and
/// accurate, so it's kept as-is rather than replaced with a hand-written
/// template that would need to anticipate every error DuckDB can raise.
pub(crate) fn strip_location_trailer(message: &str) -> String {
    let without_line = match message.split_once("\n\nLINE ") {
        Some((summary, _)) => summary,
        None => message,
    };
    let without_near = match without_line.split_once(" at or near ") {
        Some((summary, _)) => summary,
        None => without_line,
    };
    without_near.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_location_trailer_drops_the_line_and_caret_snippet() {
        let raw = "Binder Error: Referenced column \"“Sapporo\" not found in FROM clause!\n\
                    Candidate bindings: \"category\"\n\
                    \n\
                    LINE 1: ...FROM csv_data WHERE (city = “Sapporo)) LIMIT 1000001\n                                                                        ^";
        assert_eq!(
            strip_location_trailer(raw),
            "Binder Error: Referenced column \"“Sapporo\" not found in FROM clause!\n\
             Candidate bindings: \"category\""
        );
    }

    #[test]
    fn strip_location_trailer_drops_an_inline_at_or_near_snippet() {
        // The exact shape reported by a user: an unterminated quoted
        // identifier swallows everything to the end of the wrapped CTAS
        // string, so the "at or near" snippet is mostly our own internal
        // wrapper syntax (`)) LIMIT 1000001`), not anything they typed.
        let raw = "Parser Error: unterminated quoted identifier at or near \
                    \"\"Sapporo)) LIMIT 1000001\"\n\n\
                    LINE 1: ...WHERE (city = \"Sapporo)) LIMIT 1000001\n                     ^";
        assert_eq!(
            strip_location_trailer(raw),
            "Parser Error: unterminated quoted identifier"
        );
    }

    #[test]
    fn strip_location_trailer_leaves_a_binder_error_unchanged() {
        // Binder/Catalog errors don't use "at or near" phrasing (that's
        // specific to the parser), so this must NOT strip anything here —
        // "Referenced column ... not found" and the candidate list are both
        // exactly what a user needs to see.
        let raw = "Binder Error: Referenced column \"Sapporo\" not found in FROM clause!\n\
                    Candidate bindings: \"category\"";
        assert_eq!(strip_location_trailer(raw), raw);
    }

    #[test]
    fn strip_location_trailer_leaves_a_message_without_one_unchanged() {
        assert_eq!(
            strip_location_trailer("Tab not found: abc"),
            "Tab not found: abc"
        );
    }
}
