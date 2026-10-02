use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};

type PendingReply = oneshot::Sender<Result<Value, String>>;

#[derive(Clone)]
pub struct CodexManager {
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, PendingReply>>,
    next_id: AtomicU64,
    start_lock: Mutex<()>,
    executable: Mutex<Option<PathBuf>>,
}

impl CodexManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                app,
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                start_lock: Mutex::new(()),
                executable: Mutex::new(None),
            }),
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_started().await?;
        self.request_started(method, params).await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        self.ensure_started().await?;
        self.write_message(&json!({ "id": id, "result": result })).await
    }

    pub async fn info(&self) -> Result<Value, String> {
        let executable = find_codex().ok_or_else(|| {
            "Codex CLI was not found. Install Codex or set AGENTIC_TILES_CODEX_PATH.".to_string()
        })?;
        let output = codex_command(&executable)
            .arg("--version")
            .output()
            .await
            .map_err(|error| format!("Unable to run {}: {error}", executable.display()))?;
        if !output.status.success() {
            return Err(format!(
                "Codex CLI exited while checking its version: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(json!({
            "path": executable,
            "version": String::from_utf8_lossy(&output.stdout).trim(),
            "running": self.inner.stdin.lock().await.is_some()
        }))
    }

    async fn ensure_started(&self) -> Result<(), String> {
        if self.inner.stdin.lock().await.is_some() {
            return Ok(());
        }

        let _guard = self.inner.start_lock.lock().await;
        if self.inner.stdin.lock().await.is_some() {
            return Ok(());
        }

        let executable = find_codex().ok_or_else(|| {
            "Codex CLI was not found. Install Codex or set AGENTIC_TILES_CODEX_PATH.".to_string()
        })?;

        let mut child = codex_command(&executable)
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Unable to start {}: {error}", executable.display()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server did not expose stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server did not expose stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex app-server did not expose stderr".to_string())?;

        *self.inner.stdin.lock().await = Some(stdin);
        *self.inner.child.lock().await = Some(child);
        *self.inner.executable.lock().await = Some(executable.clone());

        let reader_manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                reader_manager.handle_line(&line).await;
            }
            reader_manager.handle_disconnect().await;
        });

        let app_for_stderr = self.inner.app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_for_stderr.emit("codex-log", json!({ "level": "stderr", "message": line }));
            }
        });

        let initialize = self
            .request_started(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "agentic_tiles",
                        "title": "Agentic Tiles",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await;

        if let Err(error) = initialize {
            self.handle_disconnect().await;
            return Err(error);
        }

        self.write_message(&json!({ "method": "initialized", "params": {} }))
            .await?;
        let _ = self.inner.app.emit(
            "codex-connection",
            json!({ "connected": true, "path": executable }),
        );
        Ok(())
    }

    async fn request_started(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);

        if let Err(error) = self
            .write_message(&json!({ "id": id, "method": method, "params": params }))
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }

        match timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("Codex app-server closed while handling {method}")),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(format!("Timed out waiting for Codex method {method}"))
            }
        }
    }

    async fn write_message(&self, message: &Value) -> Result<(), String> {
        let mut stdin_guard = self.inner.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| "Codex app-server is not running".to_string())?;
        let mut encoded = serde_json::to_vec(message)
            .map_err(|error| format!("Unable to encode Codex request: {error}"))?;
        encoded.push(b'\n');
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Unable to write to Codex app-server: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Unable to flush Codex request: {error}"))
    }

    async fn handle_line(&self, line: &str) {
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                let _ = self.inner.app.emit(
                    "codex-log",
                    json!({ "level": "error", "message": format!("Invalid app-server JSON: {error}") }),
                );
                return;
            }
        };

        if message.get("method").is_some() {
            let _ = self.inner.app.emit("codex-event", message);
            return;
        }

        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            let _ = self.inner.app.emit("codex-event", message);
            return;
        };

        let Some(sender) = self.inner.pending.lock().await.remove(&id) else {
            return;
        };

        if let Some(error) = message.get("error") {
            let detail = error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string());
            let _ = sender.send(Err(detail));
        } else {
            let _ = sender.send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
        }
    }

    async fn handle_disconnect(&self) {
        *self.inner.stdin.lock().await = None;
        *self.inner.child.lock().await = None;
        let pending = std::mem::take(&mut *self.inner.pending.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err("Codex app-server disconnected".to_string()));
        }
        let _ = self
            .inner
            .app
            .emit("codex-connection", json!({ "connected": false }));
    }
}

fn find_codex() -> Option<PathBuf> {
    if let Some(path) = env::var_os("AGENTIC_TILES_CODEX_PATH").map(PathBuf::from) {
        if is_file(&path) {
            return Some(path);
        }
    }

    if let Some(path_env) = env::var_os("PATH") {
        for directory in env::split_paths(&path_env) {
            let candidate = directory.join("codex");
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }

    let home = env::var_os("HOME").map(PathBuf::from)?;
    for candidate in [
        home.join(".local/bin/codex"),
        home.join(".npm-global/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
    ] {
        if is_file(&candidate) {
            return Some(candidate);
        }
    }

    let node_versions = home.join(".nvm/versions/node");
    let mut candidates = std::fs::read_dir(node_versions)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin/codex"))
        .filter(|path| is_file(path))
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.pop()
}

fn is_file(path: &Path) -> bool {
    path.metadata().map(|metadata| metadata.is_file()).unwrap_or(false)
}

fn codex_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);

    // Desktop launchers do not inherit NVM's shell setup. If Codex is an NVM-installed
    // JavaScript entry point, its sibling `node` executable must be visible to the shebang.
    if let Some(bin_directory) = executable.parent() {
        let mut paths = vec![bin_directory.to_path_buf()];
        if let Some(current_path) = env::var_os("PATH") {
            paths.extend(env::split_paths(&current_path));
        }
        if let Ok(path) = env::join_paths(paths) {
            command.env("PATH", path);
        }
    }

    command
}
