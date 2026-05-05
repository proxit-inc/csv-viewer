use duckdb::Connection;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct DuckDBState {
    pub connections: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl DuckDBState {
    pub fn new() -> Self {
        DuckDBState {
            connections: Mutex::new(HashMap::new()),
        }
    }
}
