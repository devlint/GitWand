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
 * Move a key found in the legacy settings blob to the keychain, bound to
 * `endpoint` (the endpoint it was used with). Idempotent: only the first call
 * migrates. An empty legacy value is just removed.
 */
export function stashLegacyAiApiKey(key: unknown, endpoint?: unknown): void {
  if (migrating) return;
  const trimmed = typeof key === "string" ? key.trim() : "";
  const target = typeof endpoint === "string" && endpoint.trim() ? endpoint.trim() : DEFAULT_ENDPOINT;
  if (trimmed) pendingLegacyKey = trimmed;
  migrating = (async () => {
    if (!trimmed) {
      removeLegacyFromStorage();
      return;
    }
    try {
      apply(await aiApiKeySet(trimmed, target));
      pendingLegacyKey = null;
      removeLegacyFromStorage();
    } catch (e) {
      // Kept in localStorage (see toPersistedSettings) so the next launch
      // retries. The error never carries the key.
      console.warn("[gitwand] could not move the AI API key to the keychain:", e);
    }
  })();
}

/** Forget a legacy key the user has since replaced or cleared. */
function dropPendingLegacyKey(): void {
  if (pendingLegacyKey === null) return;
  pendingLegacyKey = null;
  removeLegacyFromStorage();
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
      apply(await aiApiKeySet(key.trim(), endpoint));
      dropPendingLegacyKey();
    },
    async clear(): Promise<void> {
      apply(await aiApiKeySet(""));
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
