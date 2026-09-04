import { ref, computed, toRaw } from "vue";
import { parseGitwandrc, type MergeResult, type ConflictHunk, type GitWandOptions, type MergePolicy, type LlmFallbackConfig, type MergeContext } from "@gitwand/core";
// `resolve`, `resolveAsync` and `parseConflictMarkers` are loaded lazily via
// `engine()` (see ../utils/coreEngine.ts) — they pull in the classifier +
// full pattern registry (~243 KB raw / ~73 KB gzip) and must stay out of the
// boot chunk. `import type` below is erased at build time; it only gives us
// `typeof parseConflictMarkers` for `RawConflictSegment` without a runtime import.
import type { parseConflictMarkers } from "@gitwand/core";
import { engine } from "../utils/coreEngine";
import * as Comlink from "comlink";
import { useSnapshots } from "./useSnapshots";
import {
  pickFolder,
  getConflictedFiles,
  readFile,
  writeFile,
  readGitwandrc,
  getTreeConflicts,
  resolveTreeConflict,
  reconstructConflict,
  gitStage,
  gitRepoState,
} from "../utils/backend";
import { useFolderHistory } from "./useFolderHistory";
import { useAIProvider } from "./useAIProvider";
import { t } from "./useI18n";
import { applyMemory, isGeneralizableStrategy, type ResolutionMemoryEntry } from "./useResolutionMemory";
import { useTierStats } from "./useTierStats";
import { createSemaphore } from "../utils/concurrentMap";

/**
 * Reads the index via `git show` ×3 + runs `git merge-file` per call — up to 4
 * git subprocesses per file. `loadRealFiles()` runs fully in parallel across all
 * conflicted files, so without a cap a repo with many base-less conflicts could
 * spawn dozens of concurrent git subprocesses at once. Defensive, not a proven
 * fix for any specific incident — reduces subprocess load regardless.
 */
const reconstructLimiter = createSemaphore(4);

/** A single conflict segment from `parseConflictMarkers()`, before classification. */
type RawConflictSegment = Extract<
  ReturnType<typeof parseConflictMarkers>["segments"][number],
  { type: "conflict" }
>;

/**
 * Strip diff3 `|||||||...=======` base sections from reconstructed content,
 * leaving plain conflict markers — so it can be compared against working-tree
 * content read via `readFile()`, which never has a base section for hunks
 * `reconstructConflict()` had to enrich.
 */
function stripBaseSections(diff3Content: string): string {
  const lines = diff3Content.split("\n");
  const result: string[] = [];
  let inBaseSection = false;
  for (const line of lines) {
    if (!inBaseSection && line.startsWith("|||||||")) {
      inBaseSection = true;
      continue;
    }
    if (inBaseSection) {
      if (line.startsWith("=======")) {
        inBaseSection = false;
        result.push(line);
      }
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

export interface TreeConflictInfo {
  code: string;
  hasOurs: boolean;
  hasTheirs: boolean;
  hasBase: boolean;
}

export interface ConflictFile {
  path: string;
  content: string;
  result: MergeResult;
  tree?: TreeConflictInfo;
  /** True when content was rebuilt from the index because the working tree had no markers. */
  reconstructed?: boolean;
  /** Set when an unmerged file has no markers AND the working tree matches no side (possible manual edit). */
  markerless?: { reconstructed: string };
  /**
   * True when the file had 2-way markers (no `|||||||` base — git's default
   * merge.conflictstyle) and the base was silently recovered from the git index.
   * The ours/theirs content shown to the user is unchanged; only the base was added.
   */
  baseEnriched?: boolean;
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
 * Walk a file's conflict markers once and replace every block via `resolver`.
 * Returns the new content plus counts. A resolver returning `null` leaves that
 * block conflicted (markers kept, diff3 base preserved). Generalizes the
 * single-hunk parser used by resolveHunkManual to the whole-file case.
 */
export function resolveAllConflictBlocks(
  content: string,
  resolver: (
    block: { oursLines: string[]; baseLines: string[]; theirsLines: string[] },
    index: number,
  ) => string | null,
): { content: string; applied: number; total: number } {
  const lines = content.split("\n");
  const newLines: string[] = [];
  let conflictIdx = 0;
  let applied = 0;
  let total = 0;
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
      inBase = true;
      hasBase = true;
    } else if (line.startsWith("=======") && inConflict) {
      inBase = false;
      inTheirs = true;
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      total++;
      const replacement = resolver({ oursLines, baseLines, theirsLines }, conflictIdx);
      if (replacement !== null) {
        applied++;
        if (replacement.length > 0) {
          newLines.push(...replacement.split("\n"));
        }
      } else {
        newLines.push("<<<<<<< ours");
        newLines.push(...oursLines);
        if (hasBase) {
          newLines.push("||||||| base");
          newLines.push(...baseLines);
        }
        newLines.push("=======");
        newLines.push(...theirsLines);
        newLines.push(">>>>>>> theirs");
      }
      conflictIdx++;
      inConflict = false;
      inTheirs = false;
    } else if (inConflict) {
      if (inTheirs) theirsLines.push(line);
      else if (inBase) baseLines.push(line);
      else oursLines.push(line);
    } else {
      newLines.push(line);
    }
  }

  return { content: newLines.join("\n"), applied, total };
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

  // ─── Serialized resolution mutations (v3.10.0) ─────────
  /**
   * `core.resolve` became a Web Worker RPC in v3.10.0, so every resolution
   * helper below now has an `await` between reading a file's content and
   * writing the resolved result back, a window of hundreds of milliseconds
   * on the first call, which pays for the tree-sitter grammar load. Two
   * helpers overlapping inside that window would each derive their new
   * content from the same stale snapshot and silently drop the other's
   * resolution.
   *
   * `withFiles` serializes them so each body starts from fresh state. Bodies
   * must therefore look their file up *inside* the callback (never capture it
   * before the queue is entered), and must not call each other, which would
   * deadlock.
   */
  let _filesQueue: Promise<unknown> = Promise.resolve();
  function withFiles<T>(job: () => Promise<T>): Promise<T> {
    const run = _filesQueue.then(job, job);
    // Keep the chain alive after a rejection without leaving it unhandled.
    _filesQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Re-resolve `newContent` for `file` and write the result back into
   * `files.value`.
   *
   * The slot is located *after* the await and a vanished path is a no-op:
   * `files.value` can still be replaced wholesale while the worker call is in
   * flight by the paths that don't go through `withFiles` (a fresh
   * `loadRealFiles`, a tree-conflict resolution, undo/redo). An index
   * captured before the await would then write to the wrong file, or, at
   * `-1`, create a dead `"-1"` property, swallowing the user's resolution
   * with no error anywhere.
   */
  async function commitResolved(
    file: ConflictFile,
    newContent: string,
    build?: (result: MergeResult) => ConflictFile,
  ): Promise<void> {
    const core = await engine();
    const result = await core.resolve(newContent, file.path, toRaw(resolveOptions.value));
    const idx = files.value.findIndex((f) => f.path === file.path);
    if (idx === -1) return;
    files.value[idx] = build ? build(result) : { ...file, content: newContent, result };
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
      await loadDemoData();
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
      await loadDemoData();
    } finally {
      loading.value = false;
    }
  }

  /**
   * Load real conflicted files from a Git repository.
   */
  async function loadRealFiles(cwd: string) {
    const conflictedPaths = await getConflictedFiles(cwd);
    // Tree-conflict detection is enrichment, not core loading: if it fails (e.g. a
    // stale dev-server without the /api/tree-conflicts route), degrade to "no tree
    // conflicts" so the merge editor still loads, rather than blanking the whole view.
    let treeConflicts: Awaited<ReturnType<typeof getTreeConflicts>> = [];
    try {
      treeConflicts = await getTreeConflicts(cwd);
    } catch (err) {
      console.warn("getTreeConflicts failed; continuing without tree-conflict detection", err);
    }
    const treeMap = new Map(treeConflicts.map(t => [t.path, t]));
    // Union: tree conflicts may include paths (e.g. both-deleted) the marker scan would choke on.
    const allPaths = Array.from(new Set([...conflictedPaths, ...treeConflicts.map(t => t.path)]));

    if (allPaths.length === 0) {
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
            // accuracy lot 1 — opt-in repo-level : ré-autorise l'auto-résolution des
            // fichiers générés (le défaut du moteur est de décliner).
            resolveGeneratedFiles: cfg.resolveGeneratedFiles,
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
    // Grammar loading now lives in utils/coreEngine.ts (worker + fallback share one loader).

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
    // accuracy lot C — Contexte de merge : l'app sait quelle opération est en cours
    // (git_repo_state lit .git directement). Convention des marqueurs git :
    // « ours » est la branche cible pour merge, rebase ET cherry-pick — déclaré
    // explicitement pour que le moteur n'ait jamais à re-dériver l'inversion
    // ours/theirs du rebase. `null` hors opération : le moteur propose au lieu
    // d'appliquer sur les décisions qui dépendent du contexte.
    let mergeContext: MergeContext | null = null;
    try {
      const st = await gitRepoState(cwd);
      const OP: Record<string, MergeContext["operation"]> = {
        merge: "merge", rebase: "rebase", rebase_interactive: "rebase",
        cherry_pick: "cherry-pick", revert: "revert",
      };
      const operation = OP[st.state];
      if (operation) {
        // `st.targetBranch` vient de rebase-merge/head-name : c'est la branche
        // EN COURS DE REBASE (le travail de l'utilisateur) — donc « theirs »
        // dans la convention des marqueurs, pas la branche onto. Pour merge /
        // cherry-pick / revert, le backend ne renvoie pas de ref (null).
        mergeContext = {
          operation,
          targetSide: "ours",
          theirsRef: (operation === "rebase" ? st.targetBranch : null) ?? undefined,
        };
      }
    } catch {
      // état illisible → contexte inconnu, comportement conservateur du moteur
    }

    // NOTE: `llmFallback.endpoint` is deliberately left out of this options
    // object — it's a live function, and Comlink only recognizes a
    // `Comlink.proxy()` marker on a top-level RPC argument, not on something
    // nested inside `options` (a function buried in `options` still trips the
    // browser's structured-clone algorithm). It travels separately as
    // `aiEndpointProxy` below, passed as `core.resolveAsync`'s dedicated 4th
    // argument; see ../utils/coreEngine.ts and ../workers/coreEngine.worker.ts.
    //
    // `toRaw(resolveOptions.value)` (not a plain spread of the reactive ref)
    // matters here: `resolveOptions` is a `ref<GitWandOptions>`, so `.value`
    // is a Vue reactive Proxy, and V8's structured-clone rejects a JSProxy
    // outright when this object crosses into the worker. A shallow spread
    // only unwraps the top level — nested object properties like
    // `patternOverrides`/`generatedFiles` (set from `.gitwandrc` above) are
    // still reactive Proxies when read through the parent Proxy's getter, so
    // the unwrap has to happen on the source (`toRaw(resolveOptions.value)`)
    // before spreading, not after.
    const resolveOptionsWithLlm: GitWandOptions = (llmCfg?.enabled && aiEndpoint)
      ? { ...toRaw(resolveOptions.value), mergeContext, llmFallback: { ...llmCfg } }
      : { ...toRaw(resolveOptions.value), mergeContext };

    // The LLM endpoint is a closure over useAIProvider, which reaches the AI
    // backend through Tauri IPC. That is main-thread-only, so it crosses into
    // the worker as a Comlink proxy: the worker calls it, the call hops back
    // here, the answer hops forward. Never send it as plain data.
    const aiEndpointProxy = (llmCfg?.enabled && aiEndpoint) ? Comlink.proxy(aiEndpoint) : undefined;

    // Lazily load the engine once for this whole batch — memoized by
    // `engine()`, so the worker is only spun up on the very first conflict
    // resolution of the app's lifetime.
    const core = await engine();

    const loaded: ConflictFile[] = await Promise.all(
      allPaths.map(async (filePath) => {
        const tc = treeMap.get(filePath);
        if (tc) {
          // Tree conflict: do not parse markers. Read working-tree content best-effort (for preview).
          let content = "";
          try { content = await readFile(cwd, filePath); } catch { /* file may be absent (both-deleted) */ }
          return {
            path: filePath,
            content,
            // Tree conflicts render the dedicated panel, never hunks — produce a
            // trivial empty MergeResult instead of running the full resolver on
            // (possibly large) working-tree content. `content` above is kept for the preview.
            result: await core.resolveAsync("", filePath, resolveOptionsWithLlm, aiEndpointProxy),
            tree: { code: tc.code, hasOurs: tc.hasOurs, hasTheirs: tc.hasTheirs, hasBase: tc.hasBase },
          };
        }
        const content = await readFile(cwd, filePath);

        // Cheap upfront parse (marker splitting only — no pattern classification)
        // to tell whether every hunk in this file is missing a diff3 base. When
        // it is, a resolveAsync() pass on the raw content would be entirely
        // superseded by the base-recovery pass below (diff3-only patterns can't
        // fire without a base) — running the full pattern registry against it
        // first would just classify every hunk twice for nothing.
        const { segments: rawSegments } = await core.parseConflictMarkers(content);
        const rawConflicts = rawSegments
          .filter((s): s is RawConflictSegment => s.type === "conflict")
          .map((s) => s.conflict);
        const needsBaseRecovery = rawConflicts.length > 0 && rawConflicts.some((c) => c.baseLines.length === 0);

        // Markers present but at least one hunk has no base (merge.conflictstyle isn't
        // diff3/zdiff3) → try recovering the base from the index so diff3-only patterns
        // (non_overlapping, one_side_change, token_level_merge, …) can apply.
        if (needsBaseRecovery) {
          try {
            const rec = await reconstructLimiter.run(() => reconstructConflict(cwd, filePath));
            const enrichedResult = await core.resolveAsync(rec.content, filePath, resolveOptionsWithLlm, aiEndpointProxy);
            const sameOursTheirs =
              enrichedResult.hunks.length === rawConflicts.length &&
              enrichedResult.hunks.every((h, i) =>
                h.oursLines.join("\n") === rawConflicts[i].oursLines.join("\n") &&
                h.theirsLines.join("\n") === rawConflicts[i].theirsLines.join("\n"),
              );
            // Guard against silently discarding a manual edit made outside the
            // conflict markers: reconstructConflict() rebuilds purely from git's
            // index, so any non-conflict line the user touched in the working
            // tree since won't be reflected in `rec.content`.
            const contextUnchanged = stripBaseSections(rec.content) === content;
            if (sameOursTheirs && contextUnchanged) {
              return { path: filePath, content: rec.content, result: enrichedResult, baseEnriched: true };
            }
            // ours/theirs or non-conflict context diverge from the working tree
            // (manual edit since the conflict) → fall through to a plain
            // classification of the original content below.
          } catch { /* no recoverable stage (e.g. add/add) → fall through to plain result */ }
        }

        const result = await core.resolveAsync(content, filePath, resolveOptionsWithLlm, aiEndpointProxy);
        // Unmerged file with no parseable markers → reconstruct the 3-way from the index.
        if (result.stats.totalConflicts === 0) {
          try {
            const rec = await reconstructLimiter.run(() => reconstructConflict(cwd, filePath));
            if (rec.content.includes("<<<<<<<")) {
              if (rec.wtMatchesSide) {
                // Working tree is just one side → swap in reconstructed markers and resolve normally.
                return {
                  path: filePath,
                  content: rec.content,
                  result: await core.resolveAsync(rec.content, filePath, resolveOptionsWithLlm, aiEndpointProxy),
                  reconstructed: true,
                };
              }
              // Working tree matches no side → possible manual edit; keep it, offer a choice.
              return { path: filePath, content, result, markerless: { reconstructed: rec.content } };
            }
          } catch { /* not reconstructable → fall through to plain result */ }
        }
        return { path: filePath, content, result };
      }),
    );

    files.value = loaded;
    if (loaded.length > 0) {
      selectedPath.value = loaded[0].path;
    }

    // v3.4 — agrégat local de la métrique tier (dédupliqué par empreinte,
    // les refreshs du même jeu de conflits ne recomptent pas).
    const { recordFile } = useTierStats();
    for (const f of loaded) {
      recordFile(cwd, f.path, f.result.stats);
    }
  }

  /**
   * Load demo conflicted files for development/preview.
   */
  async function loadDemoData() {
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

    const core = await engine();
    files.value = await Promise.all(
      demoFiles.map(async ({ path, content }) => ({
        path,
        content,
        result: await core.resolve(content, path, toRaw(resolveOptions.value)),
      })),
    );

    if (files.value.length > 0) {
      selectedPath.value = files.value[0].path;
    }
  }

  /**
   * Resolve all trivial conflicts in all files.
   * Handles mixed files (some auto-resolved, some not) by applying
   * auto-resolved hunks individually via replaceConflictByIndex.
   */
  async function resolveAll() {
    return withFiles(async () => {
      pushUndo();
      const core = await engine();
      const snapshot = files.value;
      const resolved = await Promise.all(
        snapshot.map(async (f) => {
          if (f.result.stats.autoResolved === 0) return f;

          if (f.result.mergedContent) {
            // All conflicts resolved — use merged content directly
            return {
              ...f,
              content: f.result.mergedContent,
              result: await core.resolve(f.result.mergedContent, f.path, toRaw(resolveOptions.value)),
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
            result: await core.resolve(newContent, f.path, toRaw(resolveOptions.value)),
          };
        }),
      );

      // Merge per slot instead of reassigning the whole array. This batch is
      // N worker round trips long, and the paths that don't go through
      // `withFiles` (`loadRealFiles`, a tree-conflict resolution, undo/redo)
      // can replace entries, or the entire list, while it runs. Keying on
      // object identity applies each result only to the exact entry it was
      // computed from: anything replaced meanwhile keeps its newer value
      // instead of being silently overwritten with a stale resolution.
      const byRef = new Map(snapshot.map((f, i) => [f, resolved[i]] as const));
      files.value = files.value.map((f) => byRef.get(f) ?? f);
    });
  }

  /**
   * Resolve a single file.
   * If the core produced a full mergedContent (all hunks resolved), use it.
   * Otherwise, build a partial resolution: apply resolved hunks and keep
   * conflict markers for the remaining ones.
   */
  async function resolveFile(path: string) {
    return withFiles(async () => {
      const file = files.value.find((f) => f.path === path);
      if (!file) return;

      // If core resolved everything → use mergedContent directly
      // Otherwise → build partial content from resolutions
      const newContent = file.result.mergedContent ?? buildPartialContent(file.content, file.result.resolutions);
      if (!newContent || newContent === file.content) return;

      pushUndo();
      await commitResolved(file, newContent);
    });
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
  async function resolveHunkManual(
    path: string,
    hunkIndex: number,
    choice: "ours" | "theirs" | "both" | "both-theirs-first",
  ) {
    // Delegates rather than wrapping its body inline (the marker walk below is
    // long): the queue is what guarantees the file is read fresh, so nothing
    // may look `path` up before entering it, except `contentAtCall`, which
    // must be read here, before queueing. See `resolveHunkManualLocked`.
    const contentAtCall = files.value.find((f) => f.path === path)?.content;
    return withFiles(() => resolveHunkManualLocked(path, hunkIndex, choice, contentAtCall));
  }

  async function resolveHunkManualLocked(
    path: string,
    hunkIndex: number,
    choice: "ours" | "theirs" | "both" | "both-theirs-first",
    contentAtCall?: string,
  ) {
    const file = files.value.find((f) => f.path === path);
    if (!file) return;
    // `hunkIndex` was computed by the caller against the content it had on
    // screen. If the file changed while this job waited its turn in the queue
    // (another resolution landed, an undo, a reload), that index now points at
    // a different hunk, or at none, since resolving one conflict renumbers
    // every later one. Applying it anyway would silently rewrite the wrong
    // hunk, so drop the stale request: the UI re-renders from the resolution
    // that did land, and the user can act on the new state.
    if (contentAtCall !== undefined && file.content !== contentAtCall) return;

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
    await commitResolved(file, newContent);
  }

  /**
   * Resolve a hunk with custom edited content.
   * @param path - File path
   * @param hunkIndex - Index of the hunk
   * @param customContent - The user-written replacement text
   */
  async function resolveHunkCustom(
    path: string,
    hunkIndex: number,
    customContent: string,
  ) {
    // Read before queueing: `hunkIndex` belongs to this content, and the
    // queued body must refuse to apply it to anything else. Same rationale as
    // `resolveHunkManual` above.
    const contentAtCall = files.value.find((f) => f.path === path)?.content;
    return withFiles(async () => {
      const file = files.value.find((f) => f.path === path);
      if (!file) return;
      if (file.content !== contentAtCall) return; // stale hunk index

      pushUndo();
      const newContent = replaceConflictByIndex(file.content, hunkIndex, customContent);
      await commitResolved(file, newContent);
    });
  }

  /**
   * Resolve EVERY hunk in a file with a single choice (ours/theirs/both),
   * including complex/low-confidence hunks. Distinct from `resolveFile`
   * (which only applies the core's safe auto-resolutions). Reversible via undo.
   */
  async function resolveFileBulk(
    path: string,
    choice: "ours" | "theirs" | "both",
  ): Promise<{ applied: number; total: number }> {
    return withFiles(async () => {
      const file = files.value.find((f) => f.path === path);
      if (!file) return { applied: 0, total: 0 };

      const { content: newContent, applied, total } = resolveAllConflictBlocks(
        file.content,
        (b) => {
          if (choice === "ours") return b.oursLines.join("\n");
          if (choice === "theirs") return b.theirsLines.join("\n");
          return [...b.oursLines, ...b.theirsLines].join("\n");
        },
      );

      if (newContent !== file.content) {
        pushUndo();
        await commitResolved(file, newContent);
      }
      return { applied, total };
    });
  }

  /**
   * Resolve a tree conflict (modify/delete, both-deleted, …) via the backend,
   * then drop the file from the conflict list. The backend stages/removes the
   * path, so no save is needed. Throws on backend error.
   */
  async function resolveTreeConflictFile(
    path: string,
    choice: "ours" | "theirs" | "delete",
  ): Promise<void> {
    if (!folderPath.value) return;
    await resolveTreeConflict(folderPath.value, path, choice);
    files.value = files.value.filter((f) => f.path !== path);
    if (selectedPath.value === path) {
      selectedPath.value = files.value[0]?.path ?? null;
    }
  }

  /** Markerless file → swap to the reconstructed conflict content and resolve via the normal pipeline. */
  async function reconstructAndResolve(path: string): Promise<void> {
    return withFiles(async () => {
      const file = files.value.find((f) => f.path === path);
      if (!file?.markerless) return;
      const newContent = file.markerless.reconstructed;
      pushUndo();
      // Builds a fresh entry rather than spreading `file`: the reconstructed
      // file is no longer markerless, so `markerless` must not survive.
      await commitResolved(file, newContent, (result) => ({
        path: file.path,
        content: newContent,
        result,
        reconstructed: true,
      }));
    });
  }

  /** Resolve an unmerged file by staging the current working-tree content as the resolution. */
  async function resolveByStaging(path: string): Promise<void> {
    if (!folderPath.value) return;
    await gitStage(folderPath.value, [path]);
    files.value = files.value.filter((f) => f.path !== path);
    if (selectedPath.value === path) {
      selectedPath.value = files.value[0]?.path ?? null;
    }
  }

  /**
   * Apply a memorized resolution rule to every hunk in a file. Hunks where the
   * rule can't apply (e.g. "date-latest" but content is no longer a date) keep
   * their conflict markers and are reported via the returned counts.
   */
  async function applyMemoryToFile(
    path: string,
    entry: ResolutionMemoryEntry,
  ): Promise<{ applied: number; total: number }> {
    return withFiles(async () => {
      const file = files.value.find((f) => f.path === path);
      if (!file) return { applied: 0, total: 0 };
      // A "custom" rule is a verbatim blob bound to one hunk, applying it to every
      // hunk would clobber the file. Bulk apply only generalizable strategies.
      if (!isGeneralizableStrategy(entry.strategy)) return { applied: 0, total: 0 };

      const { content: newContent, applied, total } = resolveAllConflictBlocks(
        file.content,
        (b) =>
          applyMemory(entry, {
            oursLines: b.oursLines,
            theirsLines: b.theirsLines,
          } as ConflictHunk),
      );

      if (newContent !== file.content) {
        pushUndo();
        await commitResolved(file, newContent);
      }
      return { applied, total };
    });
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

    // v3.8 Time Machine: writing every resolved file back is exactly the
    // "more auto-apply" the snapshot safety net exists for, and unlike the
    // destructive git commands this path is driven from the frontend, so it
    // has to capture its own. `capture` never throws, so a snapshot failure
    // cannot cost the user their save.
    //
    // The label is stored in the snapshot's commit message, so it stays in
    // English like the Rust-side labels and like git's own reflog subjects.
    // The UI localises the `kind`, not this string.
    await useSnapshots().capture(
      folderPath.value,
      "resolution",
      `Apply resolutions to ${files.value.length} file(s)`,
    );

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
    resolveFileBulk,
    applyMemoryToFile,
    saveFile,
    saveAllFiles,
    openPath,
    undo,
    redo,
    selectFile,
    refreshLlmFallbackConfig,
    resolveTreeConflictFile,
    reconstructAndResolve,
    resolveByStaging,
  };
}
