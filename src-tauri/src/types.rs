use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct DataRange {
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub row: usize,
    pub column: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub total_count: usize,
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
