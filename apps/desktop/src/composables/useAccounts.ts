/**
 * @file useAccounts.ts
 *
 * AccountRegistry — manages forge accounts stored in localStorage.
 *
 * Each account entry holds the forge name, a user-facing label, the username,
 * and a `tokenKey` that identifies the keychain entry (service + account key)
 * without ever holding the secret itself.
 *
 * **Convention:**
 * - `tokenKey` = `"<service>/<account>"`, e.g. `"gitwand:bitbucket/my-workspace"`
 *   Matches the `service` / `account` split used by `useCredentials.ts`.
 *
 * **Persistence**: `localStorage` key `"gitwand-accounts"` (array of Account).
 * Same pattern as `useSettings.ts`.
 *
 * **Usage:**
 * ```ts
 * const {
 *   accounts,
 *   addAccount,
 *   removeAccount,
 *   activeAccount,
 *   setActiveAccount,
 * } = useAccounts();
 *
 * // Add a Bitbucket account:
 * addAccount({
 *   forge: "bitbucket",
 *   label: "work",
 *   username: "alice",
 *   tokenKey: "gitwand:bitbucket/my-workspace",
 * });
 *
 * // Get the active GitHub account (first one if none explicitly set):
 * const ghAccount = activeAccount("github");
 * ```
 */

import { ref, computed } from "vue";
import type { ForgeName } from "./forge/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Account {
  /** Unique ID — generated on creation. */
  id: string;
  /** Which forge this credential belongs to. */
  forge: ForgeName;
  /** User-facing label, e.g. "perso", "work", "client-X". */
  label: string;
  /** Username / nickname on the forge. */
  username: string;
  /**
   * Keychain pointer: `"<service>/<account>"`, e.g.
   * `"gitwand:bitbucket/my-workspace"`.
   *
   * Never holds the secret itself — that lives in the OS keychain.
   */
  tokenKey: string;
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

const ACCOUNTS_KEY = "gitwand-accounts";
const ACTIVE_KEY = "gitwand-active-accounts"; // forge → account id

function loadAccounts(): Account[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (raw) return JSON.parse(raw) as Account[];
  } catch {
    // ignore malformed data
  }
  return [];
}

function saveAccounts(list: Account[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // ignore storage errors
  }
}

function loadActiveMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    // ignore
  }
  return {};
}

function saveActiveMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

// ─── Gitea host helpers (pure, unit-testable) ────────────────────────────────
//
// The pointer keychain entry that carries a Gitea account's active username
// and validated base URL (`useCredentials.saveGiteaCredential`) is keyed by
// bare host alone, while the account model above is multi-account per forge.
// A second Gitea account on a host that already has one would silently
// overwrite the first account's pointer, and removing either account could
// leave the surviving one with no working pointer. These two predicates are
// what SettingsAccountsTab.vue calls to avoid both: block the add, and only
// delete the pointer on remove when no sibling account on the same host
// remains. Kept here, not local to the component, so they are covered by
// tests rather than only exercised through the form: the same precedent as
// forgeUrls.ts's `giteaHostFromUrl`/`giteaBaseFromUrl`.

/** Bare Gitea host encoded in `tokenKey` (`"gitwand:gitea/<host>:<username>"`), or `""`. */
function giteaHostFromTokenKey(tokenKey: string): string {
  return tokenKey.split("/")[1]?.split(":")[0] ?? "";
}

/**
 * Whether `host` already has a configured Gitea account among `accounts`.
 * Used to refuse adding a second one on the same host before it silently
 * overwrites the first account's shared keychain pointer.
 */
export function giteaHostHasAccount(accounts: Account[], host: string): boolean {
  return accounts.some((a) => a.forge === "gitea" && giteaHostFromTokenKey(a.tokenKey) === host);
}

/**
 * Whether removing `removed` should also delete the shared `<host>` keychain
 * pointer entry. Only true when no other Gitea account on the same host
 * remains: the pointer is keyed by host alone, so a surviving sibling account
 * still needs it, and deleting it out from under that sibling would make
 * every one of its commands fail with "No Gitea account configured".
 */
export function giteaPointerShouldBeDeleted(accounts: Account[], removed: Account): boolean {
  if (removed.forge !== "gitea") return false;
  const host = giteaHostFromTokenKey(removed.tokenKey);
  if (!host) return false;
  return !accounts.some(
    (a) => a.id !== removed.id && a.forge === "gitea" && giteaHostFromTokenKey(a.tokenKey) === host,
  );
}

// ─── Singleton state ─────────────────────────────────────────────────────────
// Shared across all useAccounts() calls in the same Vue app instance.

const _accounts = ref<Account[]>(loadAccounts());
const _activeMap = ref<Record<string, string>>(loadActiveMap());

// ─── Composable ──────────────────────────────────────────────────────────────

export function useAccounts() {
  /** Reactive list of all accounts across all forges. */
  const accounts = computed(() => _accounts.value);

  /** Accounts grouped by forge. */
  const accountsByForge = computed(() => {
    const map: Partial<Record<ForgeName, Account[]>> = {};
    for (const acc of _accounts.value) {
      if (!map[acc.forge]) map[acc.forge] = [];
      map[acc.forge]!.push(acc);
    }
    return map;
  });

  /**
   * Add a new account. Generates a unique `id` automatically.
   * If this is the first account for the forge, it becomes the active one.
   */
  function addAccount(account: Omit<Account, "id">): Account {
    const newAcc: Account = { ...account, id: crypto.randomUUID() };
    _accounts.value = [..._accounts.value, newAcc];
    saveAccounts(_accounts.value);
    // Auto-set as active if it's the first account for this forge.
    if (!_activeMap.value[account.forge]) {
      setActiveAccount(account.forge, newAcc.id);
    }
    return newAcc;
  }

  /**
   * Remove an account by id.
   * If the removed account was the active one, switches to the next available
   * account for the same forge (or clears the active entry).
   */
  function removeAccount(id: string): void {
    const removed = _accounts.value.find((a) => a.id === id);
    _accounts.value = _accounts.value.filter((a) => a.id !== id);
    saveAccounts(_accounts.value);

    if (!removed) return;
    // If removed account was active, elect the next one or clear.
    if (_activeMap.value[removed.forge] === id) {
      const remaining = _accounts.value.filter((a) => a.forge === removed.forge);
      const newMap = { ..._activeMap.value };
      if (remaining.length > 0) {
        newMap[removed.forge] = remaining[0].id;
      } else {
        delete newMap[removed.forge];
      }
      _activeMap.value = newMap;
      saveActiveMap(_activeMap.value);
    }
  }

  /**
   * Get the active account for a forge, or the first account if no explicit
   * active entry is set, or `null` if no accounts exist for this forge.
   */
  function activeAccount(forge: ForgeName): Account | null {
    const forgeAccounts = _accounts.value.filter((a) => a.forge === forge);
    if (forgeAccounts.length === 0) return null;
    const activeId = _activeMap.value[forge];
    return forgeAccounts.find((a) => a.id === activeId) ?? forgeAccounts[0];
  }

  /**
   * Explicitly set the active account for a forge.
   */
  function setActiveAccount(forge: ForgeName, accountId: string): void {
    _activeMap.value = { ..._activeMap.value, [forge]: accountId };
    saveActiveMap(_activeMap.value);
  }

  /**
   * Whether any accounts are configured for a given forge.
   */
  function hasAccounts(forge: ForgeName): boolean {
    return _accounts.value.some((a) => a.forge === forge);
  }

  /**
   * Hosts of every configured Gitea account, parsed out of `tokenKey`
   * (`"gitwand:gitea/<host>:<username>"`). Feeds detection layer 2 in
   * `gitRemoteInfo`.
   */
  function giteaHosts(): string[] {
    return _accounts.value
      .filter((a) => a.forge === "gitea")
      .map((a) => giteaHostFromTokenKey(a.tokenKey))
      .filter((h) => h.length > 0);
  }

  return {
    accounts,
    accountsByForge,
    addAccount,
    removeAccount,
    activeAccount,
    setActiveAccount,
    hasAccounts,
    giteaHosts,
  };
}
