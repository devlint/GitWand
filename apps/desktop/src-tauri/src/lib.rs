use tauri::Manager;

/// GitWand Desktop — Tauri backend
///
/// For now, most of the logic runs in the frontend via @gitwand/core (TypeScript).
/// This Rust backend handles:
/// - Native file system access (reading conflicted files)
/// - Git command execution
/// - Window management

#[tauri::command]
fn get_conflicted_files(cwd: String) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<String> = stdout
        .trim()
        .split('\n')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(files)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_conflicted_files,
            read_file,
            write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitWand");
}
