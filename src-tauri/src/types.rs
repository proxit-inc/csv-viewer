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
        CsvError::DuckDbError(e.to_string())
    }
}
