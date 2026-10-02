use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to resolve the app config directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create {}: {error}", directory.display()))?;
    Ok(directory.join("workspace-v1.json"))
}
pub fn load(app: &AppHandle) -> Result<Value, String> {
    let path = workspace_path(app)?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))
}

pub fn save(app: &AppHandle, state: &Value) -> Result<(), String> {
    let path = workspace_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let encoded = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Unable to encode workspace state: {error}"))?;
    fs::write(&temporary, encoded)
        .map_err(|error| format!("Unable to write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Unable to replace {}: {error}", path.display()))
}
