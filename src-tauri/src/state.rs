use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use duckdb::Connection;

use crate::commands::view::{BASE_TABLE, ROW_ID};

pub struct DuckDBState {
    pub tabs: Mutex<HashMap<String, Arc<TabSession>>>,
}

impl DuckDBState {
    pub fn new() -> Self {
        DuckDBState {
            tabs: Mutex::new(HashMap::new()),
        }
    }

    /// Looks up a tab's session and clones the `Arc`, dropping the map lock
    /// before returning — every command needs this same lock-get-clone-drop
    /// sequence so it can hold the tab's own connection lock afterward
    /// without also holding the (unrelated) tabs-map lock.
    pub fn session(&self, tab_id: &str) -> Result<Arc<TabSession>, String> {
        self.tabs
            .lock()
            .unwrap()
            .get(tab_id)
            .cloned()
            .ok_or_else(|| format!("Tab not found: {}", tab_id))
    }
}

/// A tab's DuckDB connection plus whatever view (`csv_data`, or a
/// materialized `csv_result`) the grid currently reads. `generation` lives
/// here rather than on `ResultView` so it's meaningful even when `result` is
/// `None` (viewing `csv_data` directly is generation 0).
pub struct TabSession {
    pub conn: Arc<Mutex<Connection>>,
    pub result: Mutex<Option<ResultView>>,
    generation: AtomicU64,
    /// Row count of `csv_data` captured at load time, used by `apply_query`'s
    /// post-execution catalog check to detect a query that mutated the
    /// source table (see docs/SEARCH_ARCHITECTURE.md §1 decision 5).
    pub base_total_rows: usize,
    pub base_columns: Vec<String>,
}

/// A materialized `csv_result` — the outcome of the most recently applied
/// `where`/`sql` query. Deliberately minimal: this is the state
/// `get_csv_data_range`/`current_view` need to keep reading the right table
/// on every scroll. The richer snapshot returned to the frontend at apply
/// time (columns, truncated, description, ...) is `QueryOutcome`, which the
/// frontend holds onto itself rather than the backend re-deriving it later.
#[derive(Debug, Clone)]
pub struct ResultView {
    pub table: String,
    pub total_rows: usize,
    /// `Some(ROW_ID)` or `Some(SRC_ROW_ID)` when the view still carries the
    /// original file row number (see `view::source_row_id_col` for which
    /// name means what), `None` for e.g. an aggregation result.
    pub src_row_id_col: Option<&'static str>,
}

impl TabSession {
    pub fn new(conn: Connection, base_total_rows: usize, base_columns: Vec<String>) -> Self {
        TabSession {
            conn: Arc::new(Mutex::new(conn)),
            result: Mutex::new(None),
            generation: AtomicU64::new(0),
            base_total_rows,
            base_columns,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// `(table, generation, source_row_id_column)` for whatever the grid
    /// should currently read: the materialized `csv_result` if one exists,
    /// else the raw `csv_data` table.
    pub fn current_view(&self) -> (String, u64, Option<String>) {
        let result = self.result.lock().unwrap();
        match result.as_ref() {
            Some(view) => (
                view.table.clone(),
                self.generation(),
                view.src_row_id_col.map(str::to_string),
            ),
            None => (
                BASE_TABLE.to_string(),
                self.generation(),
                Some(ROW_ID.to_string()),
            ),
        }
    }
}
