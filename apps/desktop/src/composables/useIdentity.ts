/**
 * useIdentity — multiple committer identity profiles (v2.12).
 *
 * Allows users to maintain several named git identities (Perso, Pro, Client…)
 * and select which one is active globally or per-repo. Each repo remembers its
 * own choice (`identityOverrideByRepo`). The resolved identity is passed to
 * `gitCommit()` (see `commitIdentityFor`), which injects `-c user.name=…
 * -c user.email=…` (and `user.signingkey` when the profile has one) for that
 * commit only (git_commit in ops.rs / the dev-server route).
 *
 * Resolution order:
 *   identityOverrideByRepo[cwd] > activeIdentityId > null (use git global config)
 *
 * State persisted in AppSettings via localStorage.
 */

import { computed } from "vue";
import { loadSettings, normaliseCwd, saveSettings, settingsRevision, type IdentityProfile } from "./useSettings";

// ─── helpers ─────────────────────────────────────────────────────────────────

function uuid(): string {
  // Crypto UUID — supported in Tauri's WebView and modern browsers.
  return crypto.randomUUID();
}

// ─── read ─────────────────────────────────────────────────────────────────────

/** Return all saved identity profiles. */
export function allIdentities(): IdentityProfile[] {
  return loadSettings().identities;
}

/** Find a profile by id, or undefined. */
export function findIdentity(id: string): IdentityProfile | undefined {
  return loadSettings().identities.find((p) => p.id === id);
}

/**
 * Resolve the active identity for a repo path.
 * Returns null when no override is set (git global config is used).
 */
export function resolveIdentity(cwd?: string): IdentityProfile | null {
  const s = loadSettings();
  const repoId = cwd ? repoIdentityId(cwd) : null;
  if (repoId) return s.identities.find((p) => p.id === repoId) ?? null;
  if (s.activeIdentityId) {
    const found = s.identities.find((p) => p.id === s.activeIdentityId);
    if (found) return found;
  }
  return null;
}

/**
 * The identity explicitly chosen for this repo, or null when the repo follows
 * the global default. A dangling id (profile since deleted) counts as null.
 */
export function repoIdentityId(cwd: string): string | null {
  const s = loadSettings();
  const id = s.identityOverrideByRepo[normaliseCwd(cwd)];
  return id && s.identities.some((p) => p.id === id) ? id : null;
}

/** What `gitCommit()` takes for a commit in this repo, trimmed. */
export interface CommitIdentity {
  name: string;
  email: string;
  signingKey: string | null;
}

/**
 * The identity a commit in `cwd` is made with, or null to use git's own
 * config. Every commit call site goes through this, so the profile's signing
 * key travels with its name and email: an overridden email signed with the
 * global key shows as Unverified on the forges.
 */
export function commitIdentityFor(cwd: string): CommitIdentity | null {
  const p = resolveIdentity(cwd);
  if (!p) return null;
  const name = p.gitName.trim();
  const email = p.gitEmail.trim();
  if (!name || !email) return null;
  return { name, email, signingKey: p.gpgKey?.trim() || null };
}

// ─── write ────────────────────────────────────────────────────────────────────

/** Add a new identity profile. Returns the generated id. */
export function addIdentity(profile: Omit<IdentityProfile, "id">): string {
  const id = uuid();
  const s = loadSettings();
  s.identities = [...s.identities, { ...profile, id }];
  saveSettings(s);
  return id;
}

/** Update fields on an existing profile. */
export function updateIdentity(id: string, patch: Partial<Omit<IdentityProfile, "id">>): void {
  const s = loadSettings();
  s.identities = s.identities.map((p) => (p.id === id ? { ...p, ...patch } : p));
  saveSettings(s);
}

/**
 * Remove a profile. Clears activeIdentityId and any repo overrides that
 * referenced this profile so the app never references a dangling id.
 */
export function removeIdentity(id: string): void {
  const s = loadSettings();
  s.identities = s.identities.filter((p) => p.id !== id);
  if (s.activeIdentityId === id) s.activeIdentityId = null;
  for (const cwd of Object.keys(s.identityOverrideByRepo)) {
    if (s.identityOverrideByRepo[cwd] === id) delete s.identityOverrideByRepo[cwd];
  }
  saveSettings(s);
}

/** Set the global active identity (null = use git global config). */
export function setActiveIdentity(id: string | null): void {
  const s = loadSettings();
  s.activeIdentityId = id;
  saveSettings(s);
}

/** Set a per-repo identity override (null removes the override). */
export function setRepoIdentity(cwd: string, id: string | null): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  if (id === null) {
    delete s.identityOverrideByRepo[key];
  } else {
    s.identityOverrideByRepo[key] = id;
  }
  saveSettings(s);
}

// ─── composable ──────────────────────────────────────────────────────────────

export function useIdentity(cwd?: () => string) {
  const identities = computed(() => {
    // Depend on the settings revision so add/update/remove reflect immediately.
    void settingsRevision.value;
    return allIdentities();
  });
  const activeIdentity = computed(() => {
    // Same as above — resolveIdentity() reads localStorage directly and has
    // no reactive dependency of its own.
    void settingsRevision.value;
    return resolveIdentity(cwd?.());
  });

  /** Id chosen for the current repo, null when it follows the global default. */
  const repoOverrideId = computed(() => {
    void settingsRevision.value;
    const path = cwd?.();
    return path ? repoIdentityId(path) : null;
  });
  const globalDefault = computed(() => {
    void settingsRevision.value;
    return resolveIdentity();
  });

  return {
    identities,
    activeIdentity,
    repoOverrideId,
    globalDefault,
    resolve:         (path?: string) => resolveIdentity(path),
    add:             addIdentity,
    update:          updateIdentity,
    remove:          removeIdentity,
    setActive:       setActiveIdentity,
    setRepoOverride: setRepoIdentity,
  };
}
