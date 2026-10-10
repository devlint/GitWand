/**
 * useAiApiKey — the AI provider API key, held in the OS keychain.
 *
 * The key used to be a plain field of the settings blob in localStorage,
 * which the WebView persists unencrypted on disk. It now lives in the
 * keychain (Rust `commands/ai_http.rs`), and the webview only ever sees a
 * masked hint: requests that need the key go through `aiHttpRequest`, which
 * the backend signs.
 *
 * The key is bound to the origin of the endpoint it was entered for: the
 * backend attaches it to requests for that origin only, so a script in the
 * webview cannot have it sent elsewhere. Changing the endpoint to another
 * host therefore means entering the key again (`boundElsewhere`).
 *
 * Migration: `useSettings.loadSettings()` hands any legacy `aiApiKey` it
 * finds to `stashLegacyAiApiKey()`, which moves it to the keychain and then
 * removes it from localStorage. Until that keychain write has succeeded, the
 * legacy value is the only copy of the key: `toPersistedSettings` keeps it in
 * every settings write, so a keychain failure (locked keychain, no libsecret)
 * loses nothing and the next launch retries. Once migrated — or when there is
 * nothing to migrate — every settings writer strips the field, so it cannot
 * be written back by a stale in-memory copy.
 */
import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import { aiApiKeyHint, aiApiKeySet, type AiKeyInfo } from "../utils/backend";

const SETTINGS_KEY = "gitwand-settings";
/** Endpoint a legacy key is bound to when the settings name none. */
const DEFAULT_ENDPOINT = "https://api.anthropic.com";

/** Masked form of the stored key, or null when none is configured. */
const hint = ref<string | null>(null);
/** Origin the stored key is bound to (null: unbound legacy key, or none). */
const origin = ref<string | null>(null);
/** Bumped on every change, so watchers can refetch (model lists…). */
const revision = ref(0);

let loading: Promise<void> | null = null;
let migrating: Promise<void> | null = null;
/**
 * The legacy key while its move to the keychain has not succeeded — the only
 * copy of it, which no settings write may drop.
 */
let pendingLegacyKey: string | null = null;
/**
 * True while a legacy key sits unencrypted in localStorage because its move
 * to the keychain failed (keychain locked or unavailable, unusable endpoint).
 * Settings tells the user, who can enter the key again or remove it.
 */
const legacyKeyStuck = ref(false);

function apply(info: AiKeyInfo | null): void {
  hint.value = info?.hint ?? null;
  origin.value = info?.origin ?? null;
  revision.value++;
}

/** Remove `aiApiKey` from a settings object. */
export function stripAiApiKey<T extends object>(s: T): T {
  if (s && typeof s === "object" && "aiApiKey" in s) {
    const copy = { ...s } as Record<string, unknown>;
    delete copy.aiApiKey;
    return copy as T;
  }
  return s;
}

/**
 * The object to persist for settings `s`: without `aiApiKey`, except for a
 * legacy key still waiting for its keychain move, which is kept as is.
 */
export function toPersistedSettings<T extends object>(s: T): T {
  const stripped = stripAiApiKey(s);
  return pendingLegacyKey === null
    ? stripped
    : ({ ...stripped, aiApiKey: pendingLegacyKey } as T);
}

/** Drop the legacy field from the persisted settings blob. */
function removeLegacyFromStorage(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "aiApiKey" in parsed) {
      delete parsed.aiApiKey;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
  } catch {
    // ignore
  }
}

/**
 * True for a host that can only be on this machine or its private network:
 * loopback, private (RFC 1918), link-local, CGNAT and unspecified IPv4
 * literals, IPv6 loopback / ULA / link-local literals, `localhost` and
 * `*.localhost` (RFC 6761: always loopback), and `host.docker.internal`. Names that merely look internal (`*.local`,
 * `*.internal`, single-label) are not: an HTTPS-only corporate gateway can
 * live there, and guessing http would send the key to it in clear.
 */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  // `*.localhost` always resolves to loopback (RFC 6761).
  return h === "localhost" || h.endsWith(".localhost") || h === "host.docker.internal";
}

/**
 * The endpoint a legacy key was used with, made usable for the binding:
 * as is when it is an http(s) URL, with a scheme added when it lacks one
 * (`localhost:8080/v1` — which the old webview `fetch` could never reach
 * anyway): `http://` for a loopback / private address (`isLocalHost`) on
 * any port but 443, `https://` otherwise. Empty means the Anthropic default. Null when nothing sensible
 * can be made of it.
 */
export function repairLegacyEndpoint(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return DEFAULT_ENDPOINT;
  if (endpointOrigin(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // another scheme: leave it
  let parsed: URL;
  try {
    parsed = new URL(`http://${t}`);
  } catch {
    return null;
  }
  // An explicit :443 means TLS whatever the host.
  const http = isLocalHost(parsed.hostname) && parsed.port !== "443";
  const fixed = (http ? "http://" : "https://") + t;
  return endpointOrigin(fixed) ? fixed : null;
}

/**
 * The `aiApiEndpoint` setting as it should be used: repaired when it was saved
 * without a scheme (see repairLegacyEndpoint), unchanged otherwise — empty or
 * beyond repair included. Shared by every settings loader.
 */
export function normalizeEndpointSetting(endpoint: unknown): string {
  const t = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!t || endpointOrigin(t)) return typeof endpoint === "string" ? endpoint : "";
  return repairLegacyEndpoint(t) ?? endpoint as string;
}

/**
 * Move a key found in the legacy settings blob to the keychain, bound to
 * `endpoint` (the endpoint it was used with, see `repairLegacyEndpoint`).
 * Idempotent: only the first call migrates. An empty legacy value is just
 * removed. A failure leaves the key where it is — its only copy — and raises
 * `legacyKeyStuck`, so the user learns it is still unencrypted.
 */
export function stashLegacyAiApiKey(key: unknown, endpoint?: unknown): void {
  if (migrating) return;
  const trimmed = typeof key === "string" ? key.trim() : "";
  const target = repairLegacyEndpoint(endpoint);
  if (trimmed) pendingLegacyKey = trimmed;
  migrating = (async () => {
    if (!trimmed) {
      removeLegacyFromStorage();
      return;
    }
    if (target === null) {
      // Retrying cannot help: the endpoint itself is unusable.
      legacyKeyStuck.value = true;
      console.warn("[gitwand] the AI API key could not be moved to the keychain: unusable endpoint");
      return;
    }
    try {
      apply(await aiApiKeySet(trimmed, target));
      pendingLegacyKey = null;
      removeLegacyFromStorage();
    } catch (e) {
      // Kept in localStorage (see toPersistedSettings) so the next launch
      // retries. The error never carries the key.
      legacyKeyStuck.value = true;
      console.warn("[gitwand] could not move the AI API key to the keychain:", e);
    }
  })();
}

/** Forget a legacy key the user has since replaced or cleared. */
function dropPendingLegacyKey(): void {
  legacyKeyStuck.value = false;
  if (pendingLegacyKey === null) return;
  pendingLegacyKey = null;
  removeLegacyFromStorage();
}

/**
 * Wait for a legacy migration still in flight, so a save or clear the user
 * makes meanwhile lands after it — never under it (a clear must not be
 * undone by a migration finishing late).
 */
async function afterMigration(): Promise<void> {
  if (migrating) await migrating;
}

/** Load the hint once (after any pending migration). */
export function ensureAiApiKeyLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      await migrating;
      const before = revision.value;
      let info: AiKeyInfo | null = null;
      try {
        info = await aiApiKeyHint();
      } catch {
        info = null;
      }
      // A save or clear that landed while the hint was in flight is newer.
      if (revision.value === before) apply(info);
    })();
  }
  return loading;
}

/** True once a key is known to be stored. Synchronous read for guards. */
export function isAiApiKeyConfigured(): boolean {
  return hint.value !== null;
}

/**
 * `scheme://host[:port]` of `endpoint`, as the backend computes it for the
 * binding — null when it is not an http(s) URL.
 */
export function endpointOrigin(endpoint: string | null | undefined): string | null {
  try {
    const u = new URL((endpoint ?? "").trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function useAiApiKey() {
  void ensureAiApiKeyLoaded();
  return {
    /** Masked form of the stored key, or null. */
    hint,
    /** Origin the stored key is bound to, or null. */
    origin,
    configured: computed(() => hint.value !== null),
    revision,
    /**
     * True when a key is stored but will not be sent to `endpoint`: it is
     * bound to another origin, or to none (stored before the binding).
     */
    boundElsewhere(endpoint: string | null | undefined): boolean {
      if (hint.value === null) return false;
      return origin.value === null || origin.value !== endpointOrigin(endpoint);
    },
    /**
     * Store `key` (trimmed) in the keychain, bound to `endpoint`. Supersedes a
     * legacy key whose migration failed: it must not come back on the next
     * launch and overwrite this one.
     */
    async save(key: string, endpoint: string): Promise<void> {
      await afterMigration();
      apply(await aiApiKeySet(key.trim(), endpoint));
      dropPendingLegacyKey();
    },
    async clear(): Promise<void> {
      await afterMigration();
      apply(await aiApiKeySet(""));
      dropPendingLegacyKey();
    },
    /** A legacy key is still unencrypted in localStorage (see stashLegacyAiApiKey). */
    legacyKeyStuck,
    /** Remove such a stuck legacy key, at the user's request. */
    discardLegacyKey(): void {
      dropPendingLegacyKey();
    },
  };
}

/**
 * The Settings key input: a draft that is stored in the keychain, bound to
 * `endpoint()`, on `save()` — wired to the input's `change` — and also when
 * the owning component goes away. `change` only fires on blur / Enter, so a
 * key pasted right before closing Settings would otherwise be dropped; the
 * panel is unmounted on close, which disposes this scope. That last save
 * outlives the component (the key state is module-level); its error has
 * nowhere to show and is dropped — it never contains the key.
 */
export function useAiApiKeyDraft(endpoint: () => string) {
  const key = useAiApiKey();
  const draft = ref("");
  const error = ref<string | null>(null);

  async function save(): Promise<void> {
    const value = draft.value.trim();
    if (!value) return;
    try {
      await key.save(value, endpoint());
      // Cleared only once stored: a failed save leaves the draft to retry.
      if (draft.value.trim() === value) draft.value = "";
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (draft.value.trim()) void save();
    });
  }

  return { draft, error, save };
}
