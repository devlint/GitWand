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
import { previewMerge, previewRebase, previewCherryPick } from "../utils/backend.js";
// `resolve` is loaded lazily via `engine()` — this composable sits on an
// eager path (AppHeader → BranchSelector → useMergePreview, always mounted),
// so a static import here would put the ~244 KB raw / ~73 KB gzip resolution
// engine back in the boot chunk even after useGitWand.ts stopped doing so.
// See ../utils/coreEngine.ts.
import { engine } from "../utils/coreEngine.js";

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

      const { resolve } = await engine();
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
          const result = resolve(raw.conflict_content, raw.file_path);
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
              }))
            : result.hunks.map(h => ({
                startLine: h.startLine,
                type: h.type,
                autoResolved: false,
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
            hunks: [{ startLine: 0, type: "complex", autoResolved: false }],
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

  return {
    loading,
    error,
    summary,
    conflictingFiles,
    riskLevel,
    computePreview,
    reset,
  };
}
