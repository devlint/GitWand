/**
 * Backend abstraction layer.
 *
 * Provides the same API whether running inside Tauri (native) or
 * in a browser with the dev server (Node HTTP on port 3001).
 *
 * No static import of @tauri-apps/* — we access Tauri internals
 * at runtime via window.__TAURI_INTERNALS__ to avoid Vite resolution errors.
 */

const DEV_SERVER = "http://localhost:3001";

/** Check if we're inside a Tauri webview. */
export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

/** Call a Tauri command via the invoke IPC bridge. */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error("Tauri invoke not available");
  }
  return internals.invoke(cmd, args) as Promise<T>;
}

/** Open a native folder picker (Tauri only). */
async function tauriOpenFolder(): Promise<string | null> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) return null;
  // The dialog plugin is registered as a Tauri plugin command
  try {
    const result = await internals.invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false },
    });
    return result as string | null;
  } catch {
    return null;
  }
}

// ─── Folder picker callback ─────────────────────────────

/**
 * In browser mode, the UI layer (App.vue) registers a callback
 * that opens the FolderPicker modal and resolves with the selected path.
 * This avoids coupling backend.ts to any Vue component.
 */
let _browserFolderPicker: (() => Promise<string | null>) | null = null;

/** Register the browser folder picker (called once from App.vue). */
export function registerBrowserFolderPicker(
  fn: () => Promise<string | null>,
): void {
  _browserFolderPicker = fn;
}

// ─── Public API ──────────────────────────────────────────

/**
 * Pick a folder. Tauri: native dialog. Browser: FolderPicker modal.
 */
export async function pickFolder(_defaultPath?: string): Promise<string | null> {
  if (isTauri()) {
    return tauriOpenFolder();
  }
  if (_browserFolderPicker) {
    return _browserFolderPicker();
  }
  // Fallback if no picker registered (shouldn't happen in practice)
  return window.prompt(
    "Chemin du repo avec des conflits Git :",
    _defaultPath ?? "~/Documents/GitHub/Dendreo",
  );
}

/**
 * List conflicted files in a Git repository.
 */
export async function getConflictedFiles(cwd: string): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("get_conflicted_files", { cwd });
  }
  const res = await fetch(
    `${DEV_SERVER}/api/conflicted-files?cwd=${encodeURIComponent(cwd)}`,
  );
  if (!res.ok) throw new Error(`Dev server error: ${res.status}`);
  const data = await res.json();
  return data.files;
}

/**
 * Read a file's content.
 */
export async function readFile(cwd: string, path: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("read_file", { path: `${cwd}/${path}` });
  }
  const res = await fetch(`${DEV_SERVER}/api/read-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path }),
  });
  if (!res.ok) throw new Error(`Failed to read ${path}`);
  const data = await res.json();
  return data.content;
}

/**
 * Write a file's content back to disk.
 */
export async function writeFile(
  cwd: string,
  path: string,
  content: string,
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("write_file", { path: `${cwd}/${path}`, content });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/write-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, content }),
  });
  if (!res.ok) throw new Error(`Failed to write ${path}`);
}
