/**
 * @file useCredentials.ts
 *
 * Vue composable for managing forge credentials stored in the OS keychain.
 *
 * Wraps the `credentials.rs` Tauri commands (`set_credential`,
 * `get_credential`, `delete_credential`) with a reactive layer so UI
 * components (Settings > Accounts) can read/write credentials ergonomically.
 *
 * **Convention:**
 * - service  = `"gitwand:<forge>"`, e.g. `"gitwand:bitbucket"`
 * - account  = workspace/org identifier, e.g. `"my-workspace"`
 * - value    = `"<username>:<app_password>"` for Bitbucket App Passwords
 *
 * **Usage:**
 * ```ts
 * const { saving, error, saveCredential, removeCredential } = useCredentials();
 *
 * // Save a Bitbucket App Password:
 * await saveCredential("gitwand:bitbucket", workspace, `${username}:${appPassword}`);
 *
 * // Remove credentials on disconnect:
 * await removeCredential("gitwand:bitbucket", workspace);
 * ```
 */

import { ref } from "vue";
import { setCredential, getCredential, deleteCredential } from "../utils/backend";

export function useCredentials() {
  const saving = ref(false);
  const error = ref<string | null>(null);

  /**
   * Store a credential in the OS keychain.
   *
   * Sets `saving = true` while the operation runs and clears it on completion.
   * Populates `error` on failure; clears it on success.
   */
  async function saveCredential(
    service: string,
    account: string,
    value: string,
  ): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      await setCredential(service, account, value);
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      saving.value = false;
    }
  }

  /**
   * Read a credential from the OS keychain.
   *
   * Returns `null` if no credential is found (rather than throwing), so callers
   * can distinguish "not configured" from other errors.
   */
  async function loadCredential(
    service: string,
    account: string,
  ): Promise<string | null> {
    error.value = null;
    try {
      return await getCredential(service, account);
    } catch {
      // NoEntry — not an error in the UI sense; the credential just isn't set.
      return null;
    }
  }

  /**
   * Delete a credential from the OS keychain (idempotent — safe to call even
   * if the credential doesn't exist).
   */
  async function removeCredential(
    service: string,
    account: string,
  ): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      await deleteCredential(service, account);
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      saving.value = false;
    }
  }

  // ── Bitbucket-specific helpers ────────────────────────────────────────────

  const BB_SERVICE = "gitwand:bitbucket";

  /**
   * Save a Bitbucket App Password for a workspace.
   *
   * Stores `"<username>:<appPassword>"` under `service="gitwand:bitbucket"`,
   * `account=workspace`.
   */
  async function saveBitbucketCredential(
    workspace: string,
    username: string,
    appPassword: string,
  ): Promise<boolean> {
    return saveCredential(BB_SERVICE, workspace, `${username}:${appPassword}`);
  }

  /**
   * Load Bitbucket credentials for a workspace.
   *
   * Returns `{ username, appPassword }` or `null` if not configured.
   */
  async function loadBitbucketCredential(
    workspace: string,
  ): Promise<{ username: string; appPassword: string } | null> {
    const stored = await loadCredential(BB_SERVICE, workspace);
    if (!stored) return null;
    const idx = stored.indexOf(":");
    if (idx === -1) return null;
    return {
      username: stored.slice(0, idx),
      appPassword: stored.slice(idx + 1),
    };
  }

  /**
   * Remove Bitbucket credentials for a workspace.
   */
  async function removeBitbucketCredential(workspace: string): Promise<boolean> {
    return removeCredential(BB_SERVICE, workspace);
  }

  // ── Gitea-specific helpers ────────────────────────────────────────────────

  const GITEA_SERVICE = "gitwand:gitea";

  /**
   * Store a Gitea token plus the host pointer the Rust side reads.
   *
   * `host` must be the bare host (no port): it is the keychain lookup key,
   * and Rust derives the same bare host from the git remote, so a port here
   * would make every lookup miss. Two entries: `<host>:<username>` holds the
   * token; `<host>` holds a JSON pointer `{"username", "base"}`, where `base`
   * is the full validated server URL (scheme, host, port). Rust knows the
   * bare host from the remote but not the username, nor the exact scheme or
   * port a self-hosted instance uses, so the pointer is what makes both a
   * keychain lookup and the right API base URL possible.
   */
  async function saveGiteaCredential(
    host: string,
    username: string,
    token: string,
    base: string,
  ): Promise<boolean> {
    const ok = await saveCredential(GITEA_SERVICE, `${host}:${username}`, token);
    if (!ok) return false;
    return saveCredential(GITEA_SERVICE, host, JSON.stringify({ username, base }));
  }

  return {
    /** Whether a save/remove operation is in flight. */
    saving,
    /** Last error message, or null. */
    error,
    // Generic
    saveCredential,
    loadCredential,
    removeCredential,
    // Bitbucket-specific
    saveBitbucketCredential,
    loadBitbucketCredential,
    removeBitbucketCredential,
    // Gitea-specific
    saveGiteaCredential,
  };
}
