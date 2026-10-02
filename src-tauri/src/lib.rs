mod codex;
mod persistence;

use codex::CodexManager;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn codex_request(
    manager: State<'_, CodexManager>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    manager.request(&method, params).await
}

#[tauri::command]
async fn codex_respond(
    manager: State<'_, CodexManager>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    manager.respond(id, result).await
}

#[tauri::command]
async fn codex_info(manager: State<'_, CodexManager>) -> Result<Value, String> {
    manager.info().await
}

#[tauri::command]
fn load_workspace(app: AppHandle) -> Result<Value, String> {
    persistence::load(&app)
}

#[tauri::command]
fn save_workspace(app: AppHandle, state: Value) -> Result<(), String> {
    persistence::save(&app, &state)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(CodexManager::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex_request,
            codex_respond,
            codex_info,
            load_workspace,
            save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Agentic Tiles");
}
