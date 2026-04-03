import { ref, computed } from "vue";
import { resolve, type MergeResult, type ConflictHunk } from "@gitwand/core";
import {
  pickFolder,
  getConflictedFiles,
  readFile,
  writeFile,
} from "../utils/backend";
import { useFolderHistory } from "./useFolderHistory";

export interface ConflictFile {
  path: string;
  content: string;
  result: MergeResult;
}

export interface GlobalStats {
  totalFiles: number;
  totalConflicts: number;
  autoResolved: number;
  remaining: number;
}

/** A snapshot of the entire files state, used for undo/redo. */
type Snapshot = ConflictFile[];

function cloneFiles(files: ConflictFile[]): Snapshot {
  return files.map((f) => ({ ...f }));
}

const MAX_HISTORY = 50;

/**
 * Replace a specific conflict block (by index) with replacement text,
 * keeping all other conflicts intact.
 */
function replaceConflictByIndex(
  content: string,
  targetIndex: number,
  replacement: string,
): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let conflictIdx = 0;
  let inConflict = false;
  let conflictBuffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      inConflict = true;
      conflictBuffer = [line];
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      conflictBuffer.push(line);
      if (conflictIdx === targetIndex) {
        // Replace this conflict with the replacement text
        const repLines = replacement.split("\n");
        result.push(...repLines);
      } else {
        // Keep this conflict intact
        result.push(...conflictBuffer);
      }
      conflictIdx++;
      inConflict = false;
      conflictBuffer = [];
    } else if (inConflict) {
      conflictBuffer.push(line);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Main composable for GitWand Desktop.
 * Manages file list, conflict analysis, resolution state,
 * undo/redo history, and inline editing.
 */
export function useGitWand() {
  const { addToHistory } = useFolderHistory();

  const files = ref<ConflictFile[]>([]);
  const selectedPath = ref<string | null>(null);
  const folderPath = ref<string | null>(null);

  // ─── Undo / Redo ───────────────────────────────────────
  const undoStack = ref<Snapshot[]>([]);
  const redoStack = ref<Snapshot[]>([]);

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  /** Save current state before a mutation. */
  function pushUndo() {
    undoStack.value.push(cloneFiles(files.value));
    if (undoStack.value.length > MAX_HISTORY) {
      undoStack.value.shift();
    }
    // Any new action clears the redo stack
    redoStack.value = [];
  }

  function undo() {
    if (!canUndo.value) return;
    redoStack.value.push(cloneFiles(files.value));
    files.value = undoStack.value.pop()!;
  }

  function redo() {
    if (!canRedo.value) return;
    undoStack.value.push(cloneFiles(files.value));
    files.value = redoStack.value.pop()!;
  }

  const selectedFile = computed(() =>
    files.value.find((f) => f.path === selectedPath.value) ?? null,
  );

  const stats = computed<GlobalStats>(() => {
    let totalConflicts = 0;
    let autoResolved = 0;

    for (const f of files.value) {
      totalConflicts += f.result.stats.totalConflicts;
      autoResolved += f.result.stats.autoResolved;
    }

    return {
      totalFiles: files.value.length,
      totalConflicts,
      autoResolved,
      remaining: totalConflicts - autoResolved,
    };
  });

  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * Open a folder and scan for conflicted files.
   * Works in both Tauri (native dialog) and browser (prompt + dev server).
   */
  async function openFolder() {
    error.value = null;
    loading.value = true;

    try {
      const folder = await pickFolder(folderPath.value ?? undefined);
      if (!folder) { loading.value = false; return; }

      folderPath.value = folder;
      addToHistory(folder);
      await loadRealFiles(folder);
    } catch (err: any) {
      console.error("openFolder error:", err);
      error.value = err.message ?? "Erreur inconnue";
      // Fallback to demo data if dev server is not running
      loadDemoData();
    } finally {
      loading.value = false;
    }
  }

  /**
   * Open a specific folder path directly (e.g. from history/favorites).
   */
  async function openPath(path: string) {
    error.value = null;
    loading.value = true;

    try {
      folderPath.value = path;
      addToHistory(path);
      await loadRealFiles(path);
    } catch (err: any) {
      console.error("openPath error:", err);
      error.value = err.message ?? "Erreur inconnue";
      loadDemoData();
    } finally {
      loading.value = false;
    }
  }

  /**
   * Load real conflicted files from a Git repository.
   */
  async function loadRealFiles(cwd: string) {
    const conflictedPaths = await getConflictedFiles(cwd);

    if (conflictedPaths.length === 0) {
      error.value = "Aucun fichier en conflit trouvé dans ce dossier.";
      files.value = [];
      return;
    }

    // Read each file
    const loaded: ConflictFile[] = [];
    for (const filePath of conflictedPaths) {
      const content = await readFile(cwd, filePath);
      loaded.push({
        path: filePath,
        content,
        result: resolve(content, filePath),
      });
    }

    files.value = loaded;
    if (loaded.length > 0) {
      selectedPath.value = loaded[0].path;
    }
  }

  /**
   * Load demo conflicted files for development/preview.
   */
  function loadDemoData() {
    const demoFiles: Array<{ path: string; content: string }> = [
      {
        path: "src/components/Header.tsx",
        content: `import React from "react";
<<<<<<< ours
import { useState, useEffect } from "react";
import { Logo } from "./Logo";
||||||| base
import { useState } from "react";
import { Logo } from "./Logo";
=======
import { useState } from "react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
>>>>>>> theirs

export function Header() {
<<<<<<< ours
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    document.title = "GitWand App";
  }, []);
||||||| base
  const [menuOpen, setMenuOpen] = useState(false);
=======
  const [menuOpen, setMenuOpen] = useState(false);
>>>>>>> theirs

  return (
    <header>
      <Logo />
      <nav>{menuOpen && <Menu />}</nav>
    </header>
  );
}`,
      },
      {
        path: "src/utils/config.ts",
        content: `<<<<<<< ours
export const API_URL = "https://api.staging.example.com";
export const TIMEOUT = 5000;
export const RETRIES = 3;
export const DEBUG = true;
||||||| base
export const API_URL = "https://api.example.com";
export const TIMEOUT = 5000;
export const RETRIES = 3;
=======
export const API_URL = "https://api.production.com";
export const TIMEOUT = 5000;
export const RETRIES = 3;
>>>>>>> theirs`,
      },
      {
        path: "src/services/api.ts",
        content: `import axios from "axios";
import { API_URL } from "../utils/config";

<<<<<<< ours
export async function fetchUsers() {
  const response = await axios.get(\`\${API_URL}/users\`, {
    timeout: 5000,
    headers: { "X-Client": "gitwand" },
  });
  return response.data;
}
=======
export async function fetchUsers() {
  const { data } = await fetch(\`\${API_URL}/users\`).then(r => r.json());
  return data;
}
>>>>>>> theirs`,
      },
      {
        path: "package.json",
        content: `{
  "name": "my-app",
<<<<<<< ours
  "version": "2.1.0",
||||||| base
  "version": "2.0.0",
=======
  "version": "2.1.0",
>>>>>>> theirs
  "license": "MIT"
}`,
      },
    ];

    files.value = demoFiles.map(({ path, content }) => ({
      path,
      content,
      result: resolve(content, path),
    }));

    if (files.value.length > 0) {
      selectedPath.value = files.value[0].path;
    }
  }

  /**
   * Resolve all trivial conflicts in all files.
   */
  function resolveAll() {
    pushUndo();
    files.value = files.value.map((f) => {
      if (f.result.stats.autoResolved > 0 && f.result.mergedContent) {
        return {
          ...f,
          content: f.result.mergedContent,
          result: resolve(f.result.mergedContent, f.path),
        };
      }
      return f;
    });
  }

  /**
   * Resolve a single file.
   */
  function resolveFile(path: string) {
    const file = files.value.find((f) => f.path === path);
    if (!file || !file.result.mergedContent) return;

    pushUndo();
    const idx = files.value.indexOf(file);
    files.value[idx] = {
      ...file,
      content: file.result.mergedContent,
      result: resolve(file.result.mergedContent, file.path),
    };
  }

  /**
   * Manually resolve a specific hunk in a file.
   * @param path - File path
   * @param hunkIndex - Index of the hunk (0-based, in order of appearance)
   * @param choice - "ours" | "theirs" | "both" | "both-theirs-first"
   */
  function resolveHunkManual(
    path: string,
    hunkIndex: number,
    choice: "ours" | "theirs" | "both" | "both-theirs-first",
  ) {
    const file = files.value.find((f) => f.path === path);
    if (!file) return;

    pushUndo();
    const lines = file.content.split("\n");
    const newLines: string[] = [];
    let conflictIdx = 0;
    let inConflict = false;
    let oursLines: string[] = [];
    let theirsLines: string[] = [];
    let inBase = false;
    let inTheirs = false;

    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) {
        inConflict = true;
        inBase = false;
        inTheirs = false;
        oursLines = [];
        theirsLines = [];
      } else if (line.startsWith("|||||||") && inConflict) {
        // Entering base section (diff3) — stop collecting ours
        inBase = true;
      } else if (line.startsWith("=======") && inConflict) {
        inBase = false;
        inTheirs = true;
      } else if (line.startsWith(">>>>>>>") && inConflict) {
        // End of conflict — resolve if this is the target hunk
        if (conflictIdx === hunkIndex) {
          if (choice === "ours") {
            newLines.push(...oursLines);
          } else if (choice === "theirs") {
            newLines.push(...theirsLines);
          } else if (choice === "both") {
            newLines.push(...oursLines, ...theirsLines);
          } else if (choice === "both-theirs-first") {
            newLines.push(...theirsLines, ...oursLines);
          }
        } else {
          // Keep conflict markers intact for other hunks
          newLines.push(`<<<<<<< ours`);
          newLines.push(...oursLines);
          newLines.push(`=======`);
          newLines.push(...theirsLines);
          newLines.push(`>>>>>>> theirs`);
        }
        conflictIdx++;
        inConflict = false;
        inTheirs = false;
      } else if (inConflict) {
        if (inTheirs) {
          theirsLines.push(line);
        } else if (!inBase) {
          oursLines.push(line);
        }
        // base lines are discarded (not needed for manual resolution)
      } else {
        newLines.push(line);
      }
    }

    const newContent = newLines.join("\n");
    const idx = files.value.indexOf(file);
    files.value[idx] = {
      ...file,
      content: newContent,
      result: resolve(newContent, file.path),
    };
  }

  /**
   * Resolve a hunk with custom edited content.
   * @param path - File path
   * @param hunkIndex - Index of the hunk
   * @param customContent - The user-written replacement text
   */
  function resolveHunkCustom(
    path: string,
    hunkIndex: number,
    customContent: string,
  ) {
    const file = files.value.find((f) => f.path === path);
    if (!file) return;

    pushUndo();
    const newContent = replaceConflictByIndex(file.content, hunkIndex, customContent);
    const idx = files.value.indexOf(file);
    files.value[idx] = {
      ...file,
      content: newContent,
      result: resolve(newContent, file.path),
    };
  }

  /**
   * Save a resolved file back to disk.
   */
  async function saveFile(path: string) {
    const file = files.value.find((f) => f.path === path);
    if (!file || !folderPath.value) return;

    try {
      await writeFile(folderPath.value, path, file.content);
    } catch (err: any) {
      error.value = `Erreur sauvegarde: ${err.message}`;
    }
  }

  /**
   * Save all files back to disk.
   */
  async function saveAllFiles() {
    if (!folderPath.value) return;

    let saved = 0;
    for (const file of files.value) {
      try {
        await writeFile(folderPath.value, file.path, file.content);
        saved++;
      } catch (err: any) {
        error.value = `Erreur sauvegarde ${file.path}: ${err.message}`;
        return;
      }
    }
    error.value = null;
  }

  function selectFile(path: string) {
    selectedPath.value = path;
  }

  return {
    files,
    selectedFile,
    stats,
    folderPath,
    loading,
    error,
    canUndo,
    canRedo,
    openFolder,
    resolveAll,
    resolveFile,
    resolveHunkManual,
    resolveHunkCustom,
    saveFile,
    saveAllFiles,
    openPath,
    undo,
    redo,
    selectFile,
  };
}
