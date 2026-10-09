/**
 * useScratchWorktree — v2.20.0
 *
 * Orchestre un "scratch worktree" : un worktree temporaire isolé
 * (`gitwand-scratch-<timestamp>`) pour résoudre des conflits hors du checkout
 * actif, puis ramener le résultat en un clic — avec cleanup automatique.
 *
 * Composable mince : état réactif + appels backend.ts, aucune logique métier.
 * Voir la spec docs/superpowers/specs/2026-06-16-v2.20.0-scratch-worktree-design.md
 */

import { ref } from "vue";
import { useSettings } from "./useSettings.js";
import {
  scratchWorktreeCreate,
  scratchWorktreeMergeBack,
  scratchWorktreeDiscard,
  type ScratchWorktree,
} from "../utils/backend.js";

export function useScratchWorktree(cwd: () => string) {
  const { settings } = useSettings();
  const active = ref<ScratchWorktree | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  // Set when merge-back succeeded but the scratch couldn't be removed (git's
  // message). The merge stands; the leftover worktree is deleted by hand.
  const cleanupWarning = ref<string | null>(null);
  // Main-repo cwd captured at create time. merge-back / discard MUST run from the
  // ORIGIN checkout, not from `cwd()` — once we open the scratch in a new tab the
  // reactive `cwd()` follows the active tab and would otherwise point at the
  // scratch itself (overlaying onto the scratch instead of the main checkout).
  const originCwd = ref<string | null>(null);

  /** Crée le scratch worktree basé sur `sourceBranch` (HEAD par défaut). */
  async function create(sourceBranch?: string): Promise<ScratchWorktree | null> {
    const origin = cwd();
    loading.value = true;
    error.value = null;
    cleanupWarning.value = null;
    try {
      const wt = await scratchWorktreeCreate(origin, sourceBranch);
      active.value = wt;
      originCwd.value = origin;
      return wt;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  /** Ramène les changements du scratch dans le checkout principal, puis cleanup. */
  async function mergeBack(): Promise<boolean> {
    if (!active.value || !originCwd.value) return false;
    loading.value = true;
    error.value = null;
    cleanupWarning.value = null;
    try {
      const outcome = await scratchWorktreeMergeBack(originCwd.value, active.value.path, settings.value.snapshotsEnabled);
      // Merged even when the scratch couldn't be removed: it is then left
      // detached, its branch deleted, a plain worktree to delete by hand.
      cleanupWarning.value = outcome.cleanup_warning;
      active.value = null;
      originCwd.value = null;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** Abandonne le scratch worktree (cleanup sans rien ramener). */
  async function discard(): Promise<boolean> {
    if (!active.value || !originCwd.value) return false;
    loading.value = true;
    error.value = null;
    cleanupWarning.value = null;
    try {
      await scratchWorktreeDiscard(originCwd.value, active.value.path);
      active.value = null;
      originCwd.value = null;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      loading.value = false;
    }
  }

  return { active, loading, error, cleanupWarning, originCwd, create, mergeBack, discard };
}
