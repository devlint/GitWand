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
import { previewMerge } from "../utils/backend.js";
import { resolve } from "@gitwand/core";

// ─── Types ─────────────────────────────────────────────────

export type PreviewFileStatus =
  | "auto-resolved"   // gitwand peut tout résoudre automatiquement
  | "partial"         // une partie est auto-résolvable
  | "manual"          // tous les conflits nécessitent une intervention manuelle
  | "clean"           // pas de conflit (modifié d'un seul côté)
  | "add-delete";     // conflit add/delete (toujours manuel)

export interface PreviewFileResult {
  filePath: string;
  status: PreviewFileStatus;
  /** Nombre total de conflits détectés */
  totalConflicts: number;
  /** Nombre auto-résolvables */
  autoResolved: number;
  /** Types de conflits détectés */
  conflictTypes: string[];
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

  async function computePreview(sourceBranch: string): Promise<void> {
    loading.value = true;
    error.value = null;
    summary.value = null;

    try {
      const rawFiles = await previewMerge(cwd(), sourceBranch);

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

          files.push({
            filePath: raw.file_path,
            status,
            totalConflicts: result.stats.totalConflicts,
            autoResolved: result.stats.autoResolved,
            conflictTypes: types,
          });
        } else {
          // Pas de contenu → conflit indéterminé
          files.push({
            filePath: raw.file_path,
            status: "manual",
            totalConflicts: 1,
            autoResolved: 0,
            conflictTypes: ["complex"],
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
        sourceBranch,
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

  return {
    loading,
    error,
    summary,
    conflictingFiles,
    computePreview,
    reset,
  };
}
