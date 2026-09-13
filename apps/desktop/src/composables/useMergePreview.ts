/**
 * useMergePreview — Phase 8.1
 *
 * Calcule et expose un aperçu de merge "sans effet de bord" :
 * pour chaque fichier qui conflicterait entre HEAD et la branche cible,
 * exécute le résolveur @gitwand/core et prédit le résultat.
 *
 * Architecture :
 *  1. Rust (preview_merge) → trois versions par fichier + git merge-file -p
 *  2. Ce composable → resolve() sur chaque fichier conflictuel
 *  3. MergePreviewPanel.vue → affichage
 */

import { ref, computed } from "vue";
import {
  previewMerge,
  previewRebase,
  previewCherryPick,
  readGitwandrc,
} from "../utils/backend.js";
// Types only: erased at build. `parseGitwandrc` is a *value*, so it is
// imported dynamically inside `buildPreviewOptions` instead. This composable
// sits on an eager path (AppHeader -> BranchSelector -> useMergePreview,
// always mounted), which is the same reason `engine()` is lazy above: a static
// value import from `@gitwand/core` here puts part of the package back into
// the boot chunk, and the main bundle has single-digit KB of budget headroom.
import type { GitWandOptions, MergeContext } from "@gitwand/core";
// `resolve` is loaded lazily via `engine()` — this composable sits on an
// eager path (AppHeader → BranchSelector → useMergePreview, always mounted),
// so a static import here would put the ~244 KB raw / ~73 KB gzip resolution
// engine back in the boot chunk even after useGitWand.ts stopped doing so.
// See ../utils/coreEngine.ts.
import { engine } from "../utils/coreEngine.js";
import { useResolutionSelection } from "./useResolutionSelection";

// ─── Opérations prédictibles (v2.20.0) ───────────────────
//
// Le Conflict Predictor simule un merge, un rebase ou un cherry-pick sans
// toucher au working tree. `merge` est la valeur par défaut (rétrocompatible).

export type PreviewOperation = "merge" | "rebase" | "cherry-pick";

/** Niveau de risque global d'une opération prédite. */
export type RiskLevel = "low" | "medium" | "high";

// ─── Types ─────────────────────────────────────────────────

export type PreviewFileStatus =
  | "auto-resolved"   // gitwand peut tout résoudre automatiquement
  | "partial"         // une partie est auto-résolvable
  | "manual"          // tous les conflits nécessitent une intervention manuelle
  | "clean"           // pas de conflit (modifié d'un seul côté)
  | "add-delete";     // conflit add/delete (toujours manuel)

/**
 * Aperçu d'un hunk individuel prédit (v2.20.0). Surface le résultat
 * `resolve()` déjà calculé pour un affichage hunk-par-hunk dans le panel.
 */
export interface PreviewHunk {
  /** Ligne de début du hunk dans le fichier conflictuel */
  startLine: number;
  /** Type de conflit classifié par le résolveur */
  type: string;
  /** GitWand peut-il résoudre ce hunk automatiquement ? */
  autoResolved: boolean;
  /**
   * v3.11 — score composite du moteur, 0-100. Calculé depuis toujours, il
   * était jeté ici : le panneau ne pouvait donc afficher aucune confiance,
   * et la barre « appliquer seulement au-dessus de X % » n'avait rien à lire.
   */
  confidenceScore: number;
  /** Label discret dérivé du score (couleur sans re-dériver les seuils). */
  confidenceLabel: string;
  /**
   * `resolutionReason` du moteur : pourquoi ce hunk est auto-résolvable, ou
   * pourquoi il ne l'est pas. C'est le texte du tooltip, et la seule réponse
   * honnête à « pourquoi celui-là est-il manuel ? ».
   *
   * Volontairement PAS `resolvedLines` : il n'y a pas de case à cocher dans
   * l'aperçu (les index de hunks d'une simulation ne correspondent pas à ceux
   * du vrai merge), donc le panneau n'a jamais besoin du contenu, et l'omettre
   * garde le résumé petit sur un gros merge.
   */
  reason: string;
}

export interface PreviewFileResult {
  filePath: string;
  status: PreviewFileStatus;
  /** Nombre total de conflits détectés */
  totalConflicts: number;
  /** Nombre auto-résolvables */
  autoResolved: number;
  /** Types de conflits détectés */
  conflictTypes: string[];
  /** Aperçu hunk-par-hunk (vide pour les fichiers clean / add-delete) */
  hunks: PreviewHunk[];
}

export interface MergePreviewSummary {
  /** Branche source analysée */
  sourceBranch: string;
  /** Fichiers analysés (toutes catégories) */
  files: PreviewFileResult[];
  /** Nombre de fichiers avec au moins un conflit */
  conflictingFiles: number;
  /** Nombre de fichiers entièrement auto-résolvables */
  autoResolvableFiles: number;
  /** Nombre de fichiers nécessitant une intervention manuelle */
  manualFiles: number;
  /** Nombre de fichiers propres (pas de conflit bilatéral) */
  cleanFiles: number;
  /** Estimation : le merge peut-il être entièrement automatisé ? */
  fullyAutoMergeable: boolean;
}

// ─── Composable ───────────────────────────────────────────

export function useMergePreview(cwd: () => string) {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const summary = ref<MergePreviewSummary | null>(null);

  /**
   * Options handed to the engine for a preview.
   *
   * Mirrors what `useGitWand.loadRealFiles` builds for a real resolution, so
   * the prediction is made under the same rules the apply will use, with two
   * deliberate differences:
   *
   *  - **no `llmFallback`.** A preview is a read-only glance at a merge that
   *    has not happened; it must never cost money or seconds. This is the one
   *    remaining, documented source of under-estimation.
   *  - **`mergeContext` comes from the operation being previewed**, not from
   *    `.git` state, because nothing is in progress yet. That is exactly the
   *    context the engine wants (accuracy lot C): the marker convention makes
   *    "ours" the target side for merge, rebase and cherry-pick alike.
   */
  async function buildPreviewOptions(
    operation: PreviewOperation,
  ): Promise<GitWandOptions> {
    let options: GitWandOptions = {};
    try {
      const rcRaw = await readGitwandrc(cwd());
      if (rcRaw.trim()) {
        const { parseGitwandrc } = await import("@gitwand/core");
        const cfg = parseGitwandrc(rcRaw);
        if (cfg) {
          options = {
            policy: cfg.policy,
            patternOverrides: cfg.patterns,
            generatedFiles: cfg.generatedFiles,
            resolveGeneratedFiles: cfg.resolveGeneratedFiles,
          };
        }
      }
    } catch {
      // Absent or invalid .gitwandrc → engine defaults, same as the real path.
    }

    const mergeContext: MergeContext = {
      operation: operation === "cherry-pick" ? "cherry-pick" : operation,
      targetSide: "ours",
    };
    return { ...options, mergeContext };
  }

  async function computePreview(
    ref_: string,
    operation: PreviewOperation = "merge",
  ): Promise<void> {
    loading.value = true;
    error.value = null;
    summary.value = null;

    try {
      const rawFiles =
        operation === "rebase"
          ? await previewRebase(cwd(), ref_)
          : operation === "cherry-pick"
            ? await previewCherryPick(cwd(), ref_)
            : await previewMerge(cwd(), ref_);

      const core = await engine();
      const options = await buildPreviewOptions(operation);
      const files: PreviewFileResult[] = [];

      for (const raw of rawFiles) {
        if (!raw.has_conflicts && !raw.is_add_delete) {
          // Fichier modifié d'un seul côté → pas de conflit
          files.push({
            filePath: raw.file_path,
            status: "clean",
            totalConflicts: 0,
            autoResolved: 0,
            conflictTypes: [],
            hunks: [],
          });
          continue;
        }

        if (raw.is_add_delete) {
          files.push({
            filePath: raw.file_path,
            status: "add-delete",
            totalConflicts: 1,
            autoResolved: 0,
            conflictTypes: ["add_delete"],
            hunks: [],
          });
          continue;
        }

        // Conflit textuel → lancer le résolveur
        if (raw.conflict_content) {
          // `resolveAsync`, not `resolve`: the real apply runs the structural
          // (tree-sitter) pass, and predicting with a weaker engine than the
          // one that will execute is what made the preview a lower bound.
          const result = await core.resolveAsync(raw.conflict_content, raw.file_path, options);
          const types = [...new Set(result.hunks.map(h => h.type))];

          let status: PreviewFileStatus;
          if (result.stats.remaining === 0) {
            status = "auto-resolved";
          } else if (result.stats.autoResolved > 0) {
            status = "partial";
          } else {
            status = "manual";
          }

          // Aperçu hunk-par-hunk : on réutilise la sortie resolve() déjà
          // calculée (pas de second passage) pour alimenter le panel.
          // `resolutions` porte le flag `autoResolved` par hunk ; on retombe
          // sur `hunks` si la liste est vide.
          const hunks: PreviewHunk[] = result.resolutions.length > 0
            ? result.resolutions.map(r => ({
                startLine: r.hunk.startLine,
                type: r.hunk.type,
                autoResolved: r.autoResolved,
                confidenceScore: r.hunk.confidence.score,
                confidenceLabel: r.hunk.confidence.label,
                reason: r.resolutionReason,
              }))
            : result.hunks.map(h => ({
                startLine: h.startLine,
                type: h.type,
                autoResolved: false,
                confidenceScore: h.confidence.score,
                confidenceLabel: h.confidence.label,
                reason: h.explanation,
              }));

          files.push({
            filePath: raw.file_path,
            status,
            totalConflicts: result.stats.totalConflicts,
            autoResolved: result.stats.autoResolved,
            conflictTypes: types,
            hunks,
          });
        } else {
          // Pas de contenu → conflit indéterminé
          files.push({
            filePath: raw.file_path,
            status: "manual",
            totalConflicts: 1,
            autoResolved: 0,
            conflictTypes: ["complex"],
            hunks: [{
            startLine: 0,
            type: "complex",
            autoResolved: false,
            confidenceScore: 0,
            confidenceLabel: "low",
            reason: "No content to analyse: the conflict could not be simulated.",
          }],
          });
        }
      }

      const conflictingFiles = files.filter(f => f.status !== "clean").length;
      const autoResolvableFiles = files.filter(f => f.status === "auto-resolved").length;
      const manualFiles = files.filter(f =>
        f.status === "manual" || f.status === "add-delete" || f.status === "partial",
      ).length;
      const cleanFiles = files.filter(f => f.status === "clean").length;
      const fullyAutoMergeable = conflictingFiles > 0 && manualFiles === 0;

      summary.value = {
        sourceBranch: ref_,
        files,
        conflictingFiles,
        autoResolvableFiles,
        manualFiles,
        cleanFiles,
        fullyAutoMergeable,
      };
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    summary.value = null;
    error.value = null;
    loading.value = false;
  }

  /** Fichiers qui ont au moins un conflit (status != clean) */
  const conflictingFiles = computed(() =>
    summary.value?.files.filter(f => f.status !== "clean") ?? [],
  );

  /**
   * Niveau de risque global (v2.20.0), dérivé du résumé :
   *  - low    : aucun fichier conflictuel, ou tous auto-résolus
   *  - medium : des fichiers "partial" mais aucun "manual"/"add-delete"
   *  - high   : au moins un fichier "manual" ou "add-delete"
   */
  const riskLevel = computed<RiskLevel>(() => {
    const s = summary.value;
    if (!s || s.conflictingFiles === 0) return "low";
    const hasHard = s.files.some(
      f => f.status === "manual" || f.status === "add-delete",
    );
    if (hasHard) return "high";
    const hasPartial = s.files.some(f => f.status === "partial");
    return hasPartial ? "medium" : "low";
  });

  // ─── v3.11 — confidence bar ───────────────────────────────
  //
  // Derived, never stored. The panel re-filters on every tick of the control,
  // and re-running the engine per tick is not viable, so the bar is a pure
  // read over the summary already computed. Same reasoning as
  // `wouldApplyAtThreshold` in `@gitwand/core`.

  /**
   * The confidence bar. Deliberately the SHARED store's ref, not a local one.
   *
   * It was local, and that was a real bug: the panel filtered its own displayed
   * counts while `useResolutionSelection.minScore` stayed 0, so the apply never
   * saw the bar at all. A user could set 90%, watch the panel report "1 held
   * back by the bar", press Merge and auto-resolve, and have the sub-90 hunk
   * written anyway. Two refs for one concept cannot be kept in sync by
   * discipline; there is now one.
   */
  const threshold = useResolutionSelection().minScore;

  /** Every hunk of every conflicting file, flattened once. */
  const allHunks = computed(() =>
    (summary.value?.files ?? []).flatMap(f => f.hunks),
  );

  /** How many auto-resolutions survive the current bar. */
  const estimatedAutoResolutions = computed(() =>
    allHunks.value.filter(
      h => h.autoResolved && h.confidenceScore >= threshold.value,
    ).length,
  );

  /**
   * How many auto-resolutions the bar alone is holding back.
   *
   * Deliberately excludes hunks the engine itself declined: reporting those as
   * "held back by your 90% setting" would tell the user that lowering the bar
   * would apply them, which is false.
   */
  const heldByThreshold = computed(() =>
    allHunks.value.filter(
      h => h.autoResolved && h.confidenceScore < threshold.value,
    ).length,
  );

  /** Hunks no bar can rescue: the engine refused them outright. */
  const manualHunks = computed(() =>
    allHunks.value.filter(h => !h.autoResolved).length,
  );

  return {
    loading,
    error,
    summary,
    conflictingFiles,
    riskLevel,
    computePreview,
    reset,
    threshold,
    estimatedAutoResolutions,
    heldByThreshold,
    manualHunks,
  };
}
