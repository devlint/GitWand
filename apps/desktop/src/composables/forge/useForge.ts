/**
 * @file forge/useForge.ts
 *
 * ForgeRegistry — détecte le forge depuis `gitRemoteInfo().provider` et
 * retourne le ForgeProvider correspondant.
 *
 * Usage:
 *   const forge = await useForge(cwd);
 *   const prs = await forge.listPRs(cwd, { state: "open" });
 *
 * Design:
 * - `gitRemoteInfo()` est déjà appelé par usePrPanel au montage. La détection
 *   est donc sans surcoût si on réutilise le résultat.
 * - `useForge(cwd)` peut être appelé sans attendre (mode synchro) si le provider
 *   est déjà connu, ou en mode async si la détection réseau est nécessaire.
 * - Le fallback est toujours `githubProvider` pour assurer la rétro-compatibilité
 *   avec les repos GitHub existants avant que le provider soit détecté.
 *
 * §4.3 Account-aware resolution:
 * - `getCurrentForgeAccount(forge)` returns the active `Account` for a given
 *   forge from `useAccounts()`. Components use this to display "Connected as …".
 * - Provider selection itself is still forge-name-based (no multi-account
 *   provider switching yet — deferred to v2.11 when providers accept an Account
 *   context). This is the no-op fallthrough documented in the v2.10 plan.
 */

import { gitRemoteInfo } from "../../utils/backend";
import type { ForgeProvider, ForgeName } from "./types";
import { githubProvider } from "./GitHubProvider";
import { useAccounts } from "../useAccounts";
import type { Account } from "../useAccounts";

// ─── Provider cache — lazy-loaded for non-GitHub providers ──────────────────
// GitLabProvider and BitbucketProvider are split into separate Vite chunks and
// pre-warmed here as non-blocking dynamic imports. This keeps them OUT of the
// main bundle (~450 KB saved) while ensuring they are ready well before the
// user opens the PR panel. githubProvider stays static (most-common case,
// zero latency required).
const _cache = new Map<ForgeName, ForgeProvider>();
_cache.set("github", githubProvider);

// Pre-warm at module init — Vite emits separate chunks for each provider.
import("./GitLabProvider").then((m) => _cache.set("gitlab", m.gitlabProvider));
import("./BitbucketProvider").then((m) => _cache.set("bitbucket", m.bitbucketProvider));
import("./AzureProvider").then((m) => _cache.set("azure", m.azureProvider));

/**
 * Retourne le ForgeProvider correspondant à un nom de forge déjà connu.
 * Pratique quand `RemoteInfo.provider` est déjà chargé.
 */
export function getProviderByName(name: ForgeName): ForgeProvider {
  return _cache.get(name as ForgeName) ?? githubProvider;
}

/**
 * Retourne le ForgeProvider correspondant à une URL remote.
 * Effectue la détection sans appel réseau.
 */
export function getProviderByUrl(remoteUrl: string): ForgeProvider {
  for (const provider of _cache.values()) {
    if (provider.detectFromRemote(remoteUrl)) return provider;
  }
  return githubProvider;
}

/**
 * Charge le ForgeProvider pour un repo local en appellant `gitRemoteInfo(cwd)`.
 *
 * À utiliser lors du premier montage d'un composant forge (usePrPanel, etc.)
 * quand RemoteInfo n'est pas encore disponible dans le contexte.
 *
 * Si `gitRemoteInfo` échoue (repo sans remote), retourne githubProvider en fallback.
 */
export async function useForge(cwd: string): Promise<ForgeProvider> {
  try {
    const info = await gitRemoteInfo(cwd);
    return getProviderByName(info.provider);
  } catch {
    return githubProvider;
  }
}

/**
 * Variante synchrone — retourne le provider depuis un RemoteInfo déjà chargé.
 * Evite un double appel réseau dans les composants qui ont déjà chargé RemoteInfo.
 *
 * @example
 *   const remoteInfo = await gitRemoteInfo(cwd);
 *   const forge = forgeFromRemoteInfo(remoteInfo);
 */
export function forgeFromRemoteInfo(info: { provider: string; url: string }): ForgeProvider {
  // Priorité au champ provider (calculé par Rust) — fallback sur URL matching.
  const byName = _cache.get(info.provider as ForgeName);
  if (byName) return byName;
  return getProviderByUrl(info.url);
}

// ─── Account-aware helpers (§4.3) ────────────────────────────────────────────

/**
 * Return the active `Account` for a given forge, or `null` if no account has
 * been configured in Settings > Accounts.
 *
 * In v2.10 this is purely informational — the provider selection still goes
 * through `getProviderByName()` above. Multi-account provider switching
 * (passing the account context into provider methods) is deferred to v2.11.
 *
 * Typical use: show "Connected as alice" badge in PrPanel / LaunchpadView.
 *
 * @example
 *   const account = getCurrentForgeAccount("bitbucket");
 *   // → { forge: "bitbucket", label: "work", username: "alice", ... } | null
 */
export function getCurrentForgeAccount(forge: ForgeName): Account | null {
  const { activeAccount } = useAccounts();
  return activeAccount(forge);
}

/**
 * Return the active account for the forge detected from a RemoteInfo object.
 * Convenient shorthand for components that have already resolved RemoteInfo.
 */
export function getForgeAccountFromRemote(info: {
  provider: string;
  url: string;
}): Account | null {
  const provider = forgeFromRemoteInfo(info);
  return getCurrentForgeAccount(provider.name as ForgeName);
}

/**
 * Whether Today should attempt to fetch from `forge`.
 * GitHub is always attempted (gh CLI / ambient token / OAuth keychain resolve
 * downstream). Other forges require an explicit in-app account.
 */
export function isForgeConnected(forge: ForgeName): boolean {
  if (forge === "github") return true;
  return useAccounts().hasAccounts(forge);
}

/** Resolve the ForgeProvider for a local repo (thin alias over useForge). */
export async function forgeForRepo(cwd: string): Promise<ForgeProvider> {
  return useForge(cwd);
}

// ─── Re-exports ─────────────────────────────────────────────────────────────
// gitlabProvider / bitbucketProvider ne sont plus re-exportés ici pour éviter
// de les faire remonter dans le bundle principal. Les consommateurs qui en ont
// besoin doivent les importer directement depuis leurs fichiers source.
export { githubProvider };
export type { ForgeProvider, ForgeName };
export type { Account };
