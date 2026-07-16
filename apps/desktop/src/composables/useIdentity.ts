/**
 * useIdentity — multiple committer identity profiles (v2.12).
 *
 * Allows users to maintain several named git identities (Perso, Pro, Client…)
 * and select which one is active globally or per-repo. The active identity is
 * injected as `-c user.name=… -c user.email=…` in git_commit on the Rust side.
 *
 * Resolution order:
 *   identityOverrideByRepo[cwd] > activeIdentityId > null (use git global config)
 *
 * State persisted in AppSettings via localStorage.
 */

import { computed } from "vue";
import { loadSettings, normaliseCwd, saveSettings, type IdentityProfile } from "./useSettings";

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
  if (cwd) {
    const repoId = s.identityOverrideByRepo[normaliseCwd(cwd)];
    if (repoId) {
      const found = s.identities.find((p) => p.id === repoId);
      if (found) return found;
    }
  }
  if (s.activeIdentityId) {
    const found = s.identities.find((p) => p.id === s.activeIdentityId);
    if (found) return found;
  }
  return null;
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
  const identities = computed(() => allIdentities());
  const activeIdentity = computed(() => resolveIdentity(cwd?.()));

  return {
    identities,
    activeIdentity,
    resolve:         (path?: string) => resolveIdentity(path),
    add:             addIdentity,
    update:          updateIdentity,
    remove:          removeIdentity,
    setActive:       setActiveIdentity,
    setRepoOverride: setRepoIdentity,
  };
}
