/**
 * useCommitActions — commit context-menu modal state + handlers (v1.9)
 *
 * Encapsulates the modal lifecycle (checkout, reset, create branch, tag) and
 * the fire-and-forget actions (revert, cherry-pick, view on forge) that the
 * commit right-click menu exposes in CommitLog → RepoSidebar → App.
 *
 * Usage:
 *   const commitActions = useCommitActions({ repoFolderPath, repoError, loadLog, loadBranches, repoRefresh });
 *   // spread handlers on the template: v-bind="commitActions.handlers"
 */

import { ref } from "vue";
import type { Ref } from "vue";
import type { GitLogEntry } from "../utils/backend";
import {
  gitCheckoutCommit,
  gitResetToCommit,
  gitRevertCommit,
  gitCreateBranch,
  gitCreateTag,
  gitRemoteInfo,
  gitDeleteTag,
  gitDeleteRemoteTag,
  openExternalUrl,
} from "../utils/backend";
import { forgeCommitUrl } from "../utils/forgeUrls";
import { useI18n } from "./useI18n";
import { useSettings } from "./useSettings";
import { useUndoToast } from "./useUndoToast";
import { useTagSuggestion } from "./useTagSuggestion";
import { useAIProvider } from "./useAIProvider";
import { useBranchName } from "./useBranchName";

// ─── Types ───────────────────────────────────────────────

export interface CommitActionModal {
  type: "checkout" | "reset" | "createBranch" | "tag" | "deleteBranch" | "deleteTag" | null;
  entry: GitLogEntry | null;
  resetMode: "soft" | "mixed" | "hard";
  branchName: string;
  tagName: string;
  tagMessage: string;
  busy: boolean;
  error: string;
  // Branch deletion options (v2.12)
  deleteBranchMode: "local" | "remote" | "both";
  deleteBranchName: string;
  deleteBranchRemoteName: string;
  deleteBranchHasLocal: boolean;
  deleteBranchHasRemote: boolean;
  // Tag deletion options (v2.12)
  deleteTagMode: "local" | "remote" | "both";
  deleteTagName: string;
  deleteTagHasLocal: boolean;
  deleteTagHasRemote: boolean;
}

interface Deps {
  repoFolderPath: Ref<string | null>;
  repoError: Ref<string | null>;
  loadLog: () => Promise<void>;
  loadBranches: () => void;
  repoRefresh: () => Promise<void>;
  onReset?: () => void;
  /** cherry-pick one or more commits (owned by useGitRepo — handles conflict flow). */
  cherryPick: (hashes: string[]) => Promise<void>;
  /** Branch deletion actions (owned by useGitRepo) */
  deleteBranch: (name: string) => Promise<void>;
  deleteRemoteBranch: (remote: string, name: string) => Promise<void>;
  /** Tag deletion actions (owned by useGitRepo) */
  deleteTag: (name: string) => Promise<void>;
  deleteRemoteTag: (remote: string, name: string) => Promise<void>;
}

// ─── Composable ──────────────────────────────────────────

export function useCommitActions(deps: Deps) {
  const { t } = useI18n();
  const {
    repoFolderPath,
    repoError,
    loadLog,
    loadBranches,
    repoRefresh,
    cherryPick,
    deleteBranch,
    deleteRemoteBranch,
    deleteTag,
    deleteRemoteTag,
  } = deps;
  const tagAI = useTagSuggestion();
  const branchAI = useBranchName();
  const ai = useAIProvider();

  // ── Modal state ────────────────────────────────────────

  const modal = ref<CommitActionModal>({
    type: null,
    entry: null,
    resetMode: "mixed",
    branchName: "",
    tagName: "",
    tagMessage: "",
    busy: false,
    error: "",
    deleteBranchMode: "local",
    deleteBranchName: "",
    deleteBranchRemoteName: "",
    deleteBranchHasLocal: false,
    deleteBranchHasRemote: false,
    deleteTagMode: "local",
    deleteTagName: "",
    deleteTagHasLocal: false,
    deleteTagHasRemote: false,
  });

  function closeModal() {
    modal.value = {
      ...modal.value,
      type: null,
      entry: null,
      busy: false,
      error: "",
      deleteBranchName: "",
      deleteBranchMode: "local",
      deleteTagName: "",
      deleteTagMode: "local",
    };
  }

  // ── Branch deletion ────────────────────────────────────

  function handleDeleteBranchRequest(name: string, hasLocal: boolean, hasRemote: boolean, remoteName?: string) {
    modal.value = {
      ...modal.value,
      type: "deleteBranch",
      deleteBranchName: name,
      deleteBranchHasLocal: hasLocal,
      deleteBranchHasRemote: hasRemote,
      deleteBranchRemoteName: remoteName || "",
      deleteBranchMode: hasLocal && hasRemote ? "both" : hasLocal ? "local" : "remote",
      error: "",
    };
  }

  async function confirmDeleteBranch() {
    const { deleteBranchName: name, deleteBranchMode: mode, deleteBranchRemoteName: rName } = modal.value;
    const cwd = repoFolderPath.value;
    if (!cwd) return;
    modal.value.busy = true;
    try {
      if (mode === "local" || mode === "both") {
        await deleteBranch(name);
      }
      if (mode === "remote" || mode === "both") {
        const fullRemoteName = rName || `origin/${name}`;
        const slashIdx = fullRemoteName.indexOf("/");
        if (slashIdx === -1) throw new Error(`Invalid remote branch name: ${fullRemoteName}`);
        const remote = fullRemoteName.slice(0, slashIdx);
        const branch = fullRemoteName.slice(slashIdx + 1);
        await deleteRemoteBranch(remote, branch);
      }
      closeModal();
      await Promise.all([loadBranches(), repoRefresh()]);
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  // ── Tag deletion ───────────────────────────────────────

  async function handleDeleteTagRequest(name: string) {
    const cwd = repoFolderPath.value;
    if (!cwd) return;

    // Direct deletion as requested (v2.16)
    // No modal. Always both local & remote (best effort).
    try {
      // 1. Determine remote
      let remote = "origin";
      try {
        const info = await gitRemoteInfo(cwd);
        if (info.name) remote = info.name;
      } catch { /* ignore */ }

      // 2. Local delete (best effort, ignore if already gone)
      await gitDeleteTag(cwd, name).catch(() => {});

      // 3. Remote delete (best effort, ignore if already gone)
      await gitDeleteRemoteTag(cwd, remote, name).catch(() => {});

      // 4. Final refresh
      await repoRefresh();
    } catch (err: any) {
      repoError.value = err?.message ?? String(err);
    }
  }

  // ── Checkout commit ────────────────────────────────────

  function handleCheckoutCommit(entry: GitLogEntry) {
    modal.value = { ...modal.value, type: "checkout", entry, error: "" };
  }

  async function confirmCheckoutCommit() {
    const entry = modal.value.entry;
    const cwd = repoFolderPath.value;
    if (!entry || !cwd) return;
    modal.value.busy = true;
    try {
      const snapshots = useSettings().settings.value.snapshotsEnabled;
      await gitCheckoutCommit(cwd, entry.hashFull, snapshots);
      if (snapshots) {
        useUndoToast().show(t("timeMachine.toastCheckout", entry.hash));
      }
      closeModal();
      await Promise.all([loadLog(), repoRefresh()]);
      loadBranches();
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  // ── Reset to commit ────────────────────────────────────

  function handleResetToCommit(entry: GitLogEntry, mode?: "soft" | "mixed" | "hard") {
    modal.value = { ...modal.value, type: "reset", entry, resetMode: mode || "mixed", error: "" };
    // If a mode was explicitly provided (e.g. from a context sub-menu),
    // we assume the user wants to trigger it immediately.
    if (mode) {
      confirmResetToCommit();
    }
  }

  async function confirmResetToCommit() {
    const entry = modal.value.entry;
    const cwd = repoFolderPath.value;
    if (!entry || !cwd) return;
    modal.value.busy = true;
    try {
      const snapshots = useSettings().settings.value.snapshotsEnabled;
      await gitResetToCommit(cwd, entry.hashFull, modal.value.resetMode, snapshots);
      if (snapshots) {
        useUndoToast().show(t("timeMachine.toastReset", entry.hash));
      }
      closeModal();
      // repoRefresh reloads staged/unstaged status — critical for --hard.
      await Promise.all([loadLog(), repoRefresh()]);
      loadBranches();
      deps.onReset?.();
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  // ── Revert commit (fire-and-forget) ───────────────────

  async function handleRevertCommit(entry: GitLogEntry) {
    const cwd = repoFolderPath.value;
    if (!cwd) return;
    const isMerge = (entry.parents?.length ?? 0) > 1;
    try {
      const result = await gitRevertCommit(cwd, entry.hashFull, isMerge ? 1 : undefined);
      if (!result.success) {
        repoError.value = result.conflicts
          ? t("commitCtx.revertConflicts")
          : result.message || t("commitCtx.revertFailed");
      }
      await repoRefresh();
    } catch (err: any) {
      repoError.value = err?.message ?? String(err);
    }
  }

  // ── Create branch from commit ──────────────────────────

  function handleCreateBranchFromCommit(entry: GitLogEntry) {
    modal.value = { ...modal.value, type: "createBranch", entry, branchName: "", error: "" };
  }

  async function confirmCreateBranchFromCommit() {
    const entry = modal.value.entry;
    const cwd = repoFolderPath.value;
    const name = modal.value.branchName.trim();
    if (!entry || !cwd || !name) return;
    modal.value.busy = true;
    try {
      await gitCreateBranch(cwd, name, true, entry.hashFull);
      closeModal();
      await Promise.all([repoRefresh(), loadBranches()]);
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  async function suggestBranchNameWithAI() {
    const cwd = repoFolderPath.value;
    if (!cwd) return;
    modal.value.busy = true;
    modal.value.error = "";
    try {
      const suggestion = await branchAI.suggest(cwd, modal.value.branchName);
      modal.value.branchName = suggestion;
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  // ── Tag commit ─────────────────────────────────────────

  function handleTagCommit(entry: GitLogEntry) {
    modal.value = { ...modal.value, type: "tag", entry, tagName: "", tagMessage: "", error: "" };
  }

  async function suggestTagWithAI() {
    const cwd = repoFolderPath.value;
    if (!cwd) return;
    modal.value.busy = true;
    modal.value.error = "";
    try {
      const suggestion = await tagAI.suggest(cwd);
      modal.value.tagName = suggestion.name;
      modal.value.tagMessage = suggestion.message;
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  async function confirmTagCommit() {
    const entry = modal.value.entry;
    const cwd = repoFolderPath.value;
    const name = modal.value.tagName.trim();
    if (!entry || !cwd || !name) return;
    modal.value.busy = true;
    try {
      await gitCreateTag(cwd, name, entry.hashFull, modal.value.tagMessage || undefined);
      closeModal();
      await repoRefresh();
    } catch (err: any) {
      modal.value.error = err?.message ?? String(err);
    } finally {
      modal.value.busy = false;
    }
  }

  // ── Cherry-pick ────────────────────────────────────────
  // Delegates to useGitRepo.cherryPick() which handles the full conflict
  // resolution flow (switch to changes view, keep isCherryPicking=true, etc.)

  async function handleCherryPickCommit(entry: GitLogEntry) {
    await cherryPick([entry.hashFull]);
  }

  // ── View on forge (fire-and-forget) ───────────────────

  async function handleViewOnForge(entry: GitLogEntry) {
    const cwd = repoFolderPath.value;
    if (!cwd) return;
    try {
      const info = await gitRemoteInfo(cwd);
      // No owner/repo check here: Azure DevOps carries its coordinates in the
      // remote URL, not in owner/repo, so `forgeCommitUrl` is the single judge
      // of whether a correct URL can be built.
      const base = forgeCommitUrl(info, entry.hashFull);
      if (!base) {
        repoError.value = t("commitCtx.noRemote");
        return;
      }
      void openExternalUrl(base);
    } catch {
      repoError.value = t("commitCtx.noRemote");
    }
  }

  // ── Public API ─────────────────────────────────────────

  return {
    /** Reactive modal state — bind to BaseModal v-if + form inputs in the template. */
    commitActionModal: modal,
    closeCommitActionModal: closeModal,
    // Handlers wired from RepoSidebar emits
    handleCheckoutCommit,
    handleResetToCommit,
    handleRevertCommit,
    handleCreateBranchFromCommit,
    handleTagCommit,
    handleCherryPickCommit,
    handleViewOnForge,
    handleDeleteBranchRequest,
    handleDeleteTagRequest,
    // Confirm callbacks called from modal footers
    confirmCheckoutCommit,
    confirmResetToCommit,
    confirmCreateBranchFromCommit,
    confirmTagCommit,
    confirmDeleteBranch,
    // AI
    suggestTagWithAI,
    isTagAISuggesting: tagAI.isGenerating,
    suggestBranchNameWithAI,
    isBranchNameAISuggesting: branchAI.isGenerating,
    isAIAvailable: ai.isAvailable,
  };
}
