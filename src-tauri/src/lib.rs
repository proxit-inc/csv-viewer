mod commands;
mod csv;
mod state;
mod types;

use state::DuckDBState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DuckDBState::new())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_csv_file,
            commands::file::close_tab,
            commands::data::get_csv_data_range,
            commands::search::search_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
