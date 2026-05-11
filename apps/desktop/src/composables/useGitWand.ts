import { ref, computed } from "vue";
import { resolve, resolveAsync, parseGitwandrc, type MergeResult, type ConflictHunk, type GitWandOptions, type MergePolicy, type LlmFallbackConfig } from "@gitwand/core";
import {
  pickFolder,
  getConflictedFiles,
  readFile,
  writeFile,
  readGitwandrc,
} from "../utils/backend";
import { useFolderHistory } from "./useFolderHistory";
import { useAIProvider } from "./useAIProvider";
import { t } from "./useI18n";

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
 * v2.5 — Best-effort parse of the `llmFallback` block in a raw `.gitwandrc`.
 *
 * Mirrors the JSONC-tolerant logic in `SettingsPanel.vue#loadLlmFallback`
 * (single-line `//` + block `/* *\/` comments stripped before retry).
 * The endpoint field is never persisted, so it's stripped here too — it
 * gets injected programmatically by `loadRealFiles` later.
 *
 * Returns:
 *   - `null` if the file is empty, JSON-invalid, or has no `llmFallback` key
 *   - a clean `LlmFallbackConfig` (no `endpoint`) otherwise
 */
function parseLlmFallbackFromRc(rawRc: string): LlmFallbackConfig | null {
  if (!rawRc || !rawRc.trim()) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawRc) as Record<string, unknown>;
  } catch {
    try {
      const stripped = rawRc
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const llm = parsed.llmFallback;
  if (!llm || typeof llm !== "object") return null;
  const obj = llm as Partial<LlmFallbackConfig> & { endpoint?: unknown };
  // Strip any (illegitimate) endpoint that may have slipped into the file —
  // it's never serialisable and must be injected programmatically.
  const { endpoint: _drop, enabled: rawEnabled, ...rest } = obj;
  void _drop;
  // `enabled` is required on the core type; default to false if absent so
  // the resolver simply skips LLM resolution (silent opt-out, by design).
  const cfg: LlmFallbackConfig = {
    enabled: typeof rawEnabled === "boolean" ? rawEnabled : false,
    ...rest,
  };
  return cfg;
}

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

  // Phase 7.4 — Options de résolution issues du .gitwandrc du repo courant
  const resolveOptions = ref<GitWandOptions>({});

  // v2.5 — LLM fallback config (lue depuis `.gitwandrc.llmFallback`).
  // L'`endpoint` n'est PAS persisté ici : il est injecté à la volée par
  // `loadRealFiles` via `useAIProvider().toLlmEndpoint()` (cf. PLAN §2).
  // `null` = pas de `.gitwandrc` lisible OU clé absente OU JSON invalide.
  const llmFallbackConfig = ref<LlmFallbackConfig | null>(null);

  // Adapter AI — utilisé pour fabriquer un `LlmEndpoint` au moment du
  // resolveAsync. Instancié une seule fois pour partager le state du
  // composable parent (settings localStorage, etc.).
  const ai = useAIProvider();

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

    // Phase 7.4 — Charger la config .gitwandrc du repo
    try {
      const rcRaw = await readGitwandrc(cwd);
      if (rcRaw.trim()) {
        const cfg = parseGitwandrc(rcRaw);
        if (cfg) {
          resolveOptions.value = {
            policy: cfg.policy,
            patternOverrides: cfg.patterns,
            generatedFiles: cfg.generatedFiles,
          };
        }
        // v2.5 — `llmFallback` n'est pas géré par `parseGitwandrc` (qui
        // est strict sur les patterns Phase 7.4). On le relit nous-mêmes
        // depuis le JSON brut, en best-effort : silencieux si la clé est
        // absente ou si le JSON est invalide (déjà tracé par les autres
        // consommateurs côté Settings).
        llmFallbackConfig.value = parseLlmFallbackFromRc(rcRaw);
      } else {
        llmFallbackConfig.value = null;
      }
    } catch {
      // .gitwandrc absent ou invalide → options par défaut
      resolveOptions.value = {};
      llmFallbackConfig.value = null;
    }

    // Read each file (parallel — I/O bound, order preserved by Promise.all)
    // resolveAsync attempts structural merge (tree-sitter AST-level) for
    // supported languages (TS/TSX/JS/JSX/Python/Go/Rust), falling back
    // transparently to the hunk-based resolver for everything else.
    //
    // Grammar WASM files are served from /grammars/ (copied to public/ by
    // `pnpm copy-grammars` before the build, and by Vite dev server from
    // public/ during development).  A customLoader is used here to bypass
    // environment auto-detection (avoids the Tauri adapter's convertFileSrc
    // path, which requires absolute filesystem paths unknown at runtime).
    const structuralOpts = {
      wasmPath: "/grammars/web-tree-sitter.wasm",
      customLoader: async (grammarName: string): Promise<Uint8Array> => {
        const response = await fetch(`/grammars/${grammarName}.wasm`);
        if (!response.ok) {
          throw new Error(`[gitwand] Failed to fetch grammar ${grammarName} (HTTP ${response.status})`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    };

    // v2.5 — Construire les options avec LLM fallback si activé. L'endpoint
    // n'est pas dans `.gitwandrc` (non-sérialisable) : on l'injecte ici via
    // l'adapter `useAIProvider().toLlmEndpoint()`. Garde-fou : si la config
    // dit `enabled: true` mais qu'aucun provider n'est utilisable (clé API
    // manquante, etc.), on logge un avertissement, on remonte un message
    // (réutilise le ref `error` existant pour le toast App.vue), MAIS on
    // continue la résolution sans LLM — pas de crash silencieux ni de
    // blocage.
    const llmCfg = llmFallbackConfig.value;
    const aiEndpoint = llmCfg?.enabled ? ai.toLlmEndpoint() : null;
    if (llmCfg?.enabled && !aiEndpoint) {
      const msg = t("settings.ai.fallback.providerMissing");
      console.warn("[gitwand] LLM fallback enabled in .gitwandrc but no AI provider is configured — skipping LLM. " + msg);
      // Non-fatal : visible dans le toast d'erreur, mais on continue.
      error.value = msg;
    }
    const resolveOptionsWithLlm: GitWandOptions = (llmCfg?.enabled && aiEndpoint)
      ? {
          ...resolveOptions.value,
          llmFallback: { ...llmCfg, endpoint: aiEndpoint },
        }
      : resolveOptions.value;

    const loaded: ConflictFile[] = await Promise.all(
      conflictedPaths.map(async (filePath) => {
        const content = await readFile(cwd, filePath);
        return {
          path: filePath,
          content,
          result: await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts),
        };
      }),
    );

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
      result: resolve(content, path, resolveOptions.value),
    }));

    if (files.value.length > 0) {
      selectedPath.value = files.value[0].path;
    }
  }

  /**
   * Resolve all trivial conflicts in all files.
   * Handles mixed files (some auto-resolved, some not) by applying
   * auto-resolved hunks individually via replaceConflictByIndex.
   */
  function resolveAll() {
    pushUndo();
    files.value = files.value.map((f) => {
      if (f.result.stats.autoResolved === 0) return f;

      if (f.result.mergedContent) {
        // All conflicts resolved — use merged content directly
        return {
          ...f,
          content: f.result.mergedContent,
          result: resolve(f.result.mergedContent, f.path, resolveOptions.value),
        };
      }

      // Mixed file: apply auto-resolved hunks individually (reverse order
      // to preserve conflict indices as we replace earlier blocks).
      let newContent = f.content;
      const resolutions = f.result.resolutions;
      for (let i = resolutions.length - 1; i >= 0; i--) {
        const res = resolutions[i];
        if (res.autoResolved && res.resolvedLines) {
          newContent = replaceConflictByIndex(
            newContent,
            i,
            res.resolvedLines.join("\n"),
          );
        }
      }

      return {
        ...f,
        content: newContent,
        result: resolve(newContent, f.path, resolveOptions.value),
      };
    });
  }

  /**
   * Resolve a single file.
   * If the core produced a full mergedContent (all hunks resolved), use it.
   * Otherwise, build a partial resolution: apply resolved hunks and keep
   * conflict markers for the remaining ones.
   */
  function resolveFile(path: string) {
    const file = files.value.find((f) => f.path === path);
    if (!file) return;

    // If core resolved everything → use mergedContent directly
    // Otherwise → build partial content from resolutions
    const newContent = file.result.mergedContent ?? buildPartialContent(file.content, file.result.resolutions);
    if (!newContent || newContent === file.content) return;

    pushUndo();
    const idx = files.value.indexOf(file);
    files.value[idx] = {
      ...file,
      content: newContent,
      result: resolve(newContent, file.path, resolveOptions.value),
    };
  }

  /**
   * Build partially resolved content: replace auto-resolved hunks with their
   * resolved lines, keep conflict markers for unresolved hunks.
   */
  function buildPartialContent(
    original: string,
    resolutions: MergeResult["resolutions"],
  ): string {
    const lines = original.split("\n");
    const output: string[] = [];
    let conflictIdx = 0;
    let inConflict = false;
    let conflictBuffer: string[] = [];

    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) {
        inConflict = true;
        conflictBuffer = [line];
      } else if (line.startsWith(">>>>>>>") && inConflict) {
        conflictBuffer.push(line);
        const resolution = resolutions[conflictIdx];
        if (resolution?.autoResolved && resolution.resolvedLines) {
          output.push(...resolution.resolvedLines);
        } else {
          output.push(...conflictBuffer);
        }
        conflictIdx++;
        inConflict = false;
        conflictBuffer = [];
      } else if (inConflict) {
        conflictBuffer.push(line);
      } else {
        output.push(line);
      }
    }

    return output.join("\n");
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
    let baseLines: string[] = [];
    let theirsLines: string[] = [];
    let hasBase = false;
    let inBase = false;
    let inTheirs = false;

    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) {
        inConflict = true;
        hasBase = false;
        inBase = false;
        inTheirs = false;
        oursLines = [];
        baseLines = [];
        theirsLines = [];
      } else if (line.startsWith("|||||||") && inConflict) {
        // Entering base section (diff3) — stop collecting ours
        inBase = true;
        hasBase = true;
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
          // Keep conflict markers intact for other hunks (preserve diff3 format)
          newLines.push(`<<<<<<< ours`);
          newLines.push(...oursLines);
          if (hasBase) {
            newLines.push(`||||||| base`);
            newLines.push(...baseLines);
          }
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
        } else if (inBase) {
          baseLines.push(line);
        } else {
          oursLines.push(line);
        }
      } else {
        newLines.push(line);
      }
    }

    const newContent = newLines.join("\n");
    const idx = files.value.indexOf(file);
    files.value[idx] = {
      ...file,
      content: newContent,
      result: resolve(newContent, file.path, resolveOptions.value),
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
      result: resolve(newContent, file.path, resolveOptions.value),
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
   *
   * Parallélisé via `Promise.all` — miroir de `loadFiles` au-dessus. Chaque
   * `writeFile` est indépendant (le backend écrit par chemin, pas de state
   * partagé), donc on lance tout de front.
   *
   * Sémantique d'erreur : on attend que TOUTES les écritures se terminent
   * (au lieu de `return`-er à la première comme avant). Ça maximise le
   * nombre de fichiers effectivement sauvés lors d'une panne partielle —
   * l'utilisateur voit un message pointant le premier échec (dans l'ordre
   * d'origine, pas d'ordre de résolution) et les fichiers non fautifs sont
   * bien sur disque. Comportement antérieur : bail-on-first, laissait les
   * fichiers restants non sauvés — perte de travail lors d'un simple
   * permission error isolé.
   */
  async function saveAllFiles() {
    if (!folderPath.value) return;

    const failures: Array<{ index: number; path: string; err: unknown }> = [];
    await Promise.all(
      files.value.map(async (file, index) => {
        try {
          await writeFile(folderPath.value!, file.path, file.content);
        } catch (err) {
          failures.push({ index, path: file.path, err });
        }
      }),
    );

    if (failures.length > 0) {
      // Rapport stable : premier échec selon l'ordre d'origine, pas selon
      // l'ordre dans lequel les promesses se résolvent.
      failures.sort((a, b) => a.index - b.index);
      const first = failures[0];
      const msg = first.err instanceof Error ? first.err.message : String(first.err);
      error.value = `Erreur sauvegarde ${first.path}: ${msg}`;
      return;
    }

    error.value = null;
  }

  function selectFile(path: string) {
    selectedPath.value = path;
  }

  /**
   * v2.5 — Re-read `.gitwandrc.llmFallback` from disk for the active repo.
   *
   * Called by `App.vue` when the user closes the Settings panel, so the
   * next `loadRealFiles()` picks up changes made through the UI without
   * having to re-open the repo.
   *
   * No-op when no repo is open. Failure to read is silent (falls back to
   * `null`, matching the constructor behaviour).
   */
  async function refreshLlmFallbackConfig() {
    if (!folderPath.value) {
      llmFallbackConfig.value = null;
      return;
    }
    try {
      const rcRaw = await readGitwandrc(folderPath.value);
      llmFallbackConfig.value = parseLlmFallbackFromRc(rcRaw);
    } catch {
      llmFallbackConfig.value = null;
    }
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
    refreshLlmFallbackConfig,
  };
}
