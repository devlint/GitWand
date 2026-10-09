/**
 * useAiApiKey — the AI provider API key, held in the OS keychain.
 *
 * The key used to be a plain field of the settings blob in localStorage,
 * which the WebView persists unencrypted on disk. It now lives in the
 * keychain (Rust `commands/ai_http.rs`), and the webview only ever sees a
 * masked hint: requests that need the key go through `aiHttpRequest`, which
 * the backend signs.
 *
 * Migration: `useSettings.loadSettings()` hands any legacy `aiApiKey` it
 * finds to `stashLegacyAiApiKey()`, which moves it to the keychain and then
 * removes it from localStorage. Every settings writer also strips the field,
 * so it cannot be written back by a stale in-memory copy.
 */
import { computed, ref } from "vue";
import { aiApiKeyHint, aiApiKeySet } from "../utils/backend";

const SETTINGS_KEY = "gitwand-settings";

/** Masked form of the stored key, or null when none is configured. */
const hint = ref<string | null>(null);
/** Bumped on every change, so watchers can refetch (model lists…). */
const revision = ref(0);

let loading: Promise<void> | null = null;
let migrating: Promise<void> | null = null;

/** Remove `aiApiKey` from a settings object about to be persisted. */
export function stripAiApiKey<T extends object>(s: T): T {
  if (s && typeof s === "object" && "aiApiKey" in s) {
    const copy = { ...s } as Record<string, unknown>;
    delete copy.aiApiKey;
    return copy as T;
  }
  return s;
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
 * Move a key found in the legacy settings blob to the keychain. Idempotent:
 * only the first call migrates. An empty legacy value is just removed.
 */
export function stashLegacyAiApiKey(key: unknown): void {
  if (migrating) return;
  const trimmed = typeof key === "string" ? key.trim() : "";
  migrating = (async () => {
    if (!trimmed) {
      removeLegacyFromStorage();
      return;
    }
    try {
      hint.value = await aiApiKeySet(trimmed);
      revision.value++;
      removeLegacyFromStorage();
    } catch (e) {
      // Left in localStorage so the next launch retries.
      console.warn("[gitwand] could not move the AI API key to the keychain:", e);
    }
  })();
}

/** Load the hint once (after any pending migration). */
export function ensureAiApiKeyLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      await migrating;
      try {
        hint.value = await aiApiKeyHint();
      } catch {
        hint.value = null;
      }
      revision.value++;
    })();
  }
  return loading;
}

/** True once a key is known to be stored. Synchronous read for guards. */
export function isAiApiKeyConfigured(): boolean {
  return hint.value !== null;
}

export function useAiApiKey() {
  void ensureAiApiKeyLoaded();
  return {
    /** Masked form of the stored key, or null. */
    hint,
    configured: computed(() => hint.value !== null),
    revision,
    /** Store `key` (trimmed) in the keychain; an empty key clears it. */
    async save(key: string): Promise<void> {
      hint.value = await aiApiKeySet(key.trim());
      revision.value++;
    },
    async clear(): Promise<void> {
      hint.value = await aiApiKeySet("");
      revision.value++;
    },
  };
}
