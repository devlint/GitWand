import { ref, computed, readonly } from "vue";
import {
  detectLocale,
  loadLocale,
  getLoadedLocale,
  isSupportedLocale,
  DEFAULT_LOCALE,
  type SupportedLocale,
  type Locale,
  type LocaleKey,
} from "../locales";

// ─── Persisted locale preference ────────────────────────
const STORAGE_KEY = "gitwand-locale";

function loadSavedLocale(): SupportedLocale | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isSupportedLocale(saved)) return saved;
  } catch {
    // localStorage unavailable
  }
  return null;
}

function saveLocale(locale: SupportedLocale | null) {
  try {
    if (locale === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, locale);
    }
  } catch {
    // ignore
  }
}

// ─── Singleton reactive state ───────────────────────────
// "auto" means OS detection, otherwise it's a forced override.
const isAuto = ref(loadSavedLocale() === null);
const currentLocale = ref<SupportedLocale>(loadSavedLocale() ?? detectLocale());

// `en` is always in the main chunk; other locales stream in via loadLocale().
// `activeMessages` holds whatever is currently available for `currentLocale`,
// falling back to `en` until the requested chunk resolves. Templates re-render
// reactively when the chunk lands, so a non-en cold start briefly shows English.
const activeMessages = ref<Locale>(getLoadedLocale(DEFAULT_LOCALE)!);
const messages = computed<Locale>(() => activeMessages.value);

/**
 * Make `activeMessages` reflect `locale`. If the locale is already loaded the
 * swap is synchronous; otherwise we keep the current (en) fallback and swap
 * once the chunk resolves — guarding against a newer switch in the meantime.
 */
function applyLocale(locale: SupportedLocale) {
  const ready = getLoadedLocale(locale);
  if (ready) {
    activeMessages.value = ready;
    return;
  }
  void loadLocale(locale).then((msgs) => {
    if (currentLocale.value === locale) activeMessages.value = msgs;
  });
}

// Kick off the initial (possibly non-en) load.
applyLocale(currentLocale.value);

/**
 * Resolve a dotted key ("header.open") into the translated string.
 * Supports positional interpolation: t("sidebar.commitButton", 3) → "Commit (3)"
 */
function t(key: LocaleKey, ...args: Array<string | number>): string {
  const parts = key.split(".");
  let value: unknown = messages.value;

  for (const part of parts) {
    if (value && typeof value === "object" && part in (value as Record<string, unknown>)) {
      value = (value as Record<string, unknown>)[part];
    } else {
      // Key not found — return the key itself (helps spot missing translations)
      console.warn(`[i18n] Missing key: ${key}`);
      return key;
    }
  }

  if (typeof value !== "string") return key;

  // Replace {0}, {1}, ... with positional args
  let result = value;
  for (let i = 0; i < args.length; i++) {
    result = result.replace(`{${i}}`, String(args[i]));
  }
  return result;
}

/**
 * Change the active locale. Pass null to revert to OS detection.
 */
function setLocale(locale: SupportedLocale | null) {
  if (locale === null) {
    isAuto.value = true;
    currentLocale.value = detectLocale();
    saveLocale(null);
  } else {
    isAuto.value = false;
    currentLocale.value = locale;
    saveLocale(locale);
  }
  applyLocale(currentLocale.value);
}

/**
 * Main i18n composable.
 *
 * Usage in a component:
 * ```ts
 * const { t, locale, isAuto, setLocale } = useI18n();
 * ```
 *
 * In template:
 * ```vue
 * <span>{{ t('header.open') }}</span>
 * <span>{{ t('sidebar.commitButton', repoStats.staged) }}</span>
 * ```
 */
export function useI18n() {
  return {
    /** Translate a key. Supports positional args: t('key', value) */
    t,
    /** Active locale messages (reactive). For non-string values like arrays
     *  that `t()` can't return — e.g. EmptyState's rotating tips. */
    messages,
    /** Current locale code (reactive). */
    locale: readonly(currentLocale),
    /** Whether locale is auto-detected from OS. */
    isAuto: readonly(isAuto),
    /** Change locale. Pass null for OS auto-detection. */
    setLocale,
  };
}

/**
 * Standalone `t` — same function as `useI18n().t`, exported for use outside
 * Vue components (composables, utilities) where you just need to translate a
 * string. Reads the current singleton locale.
 */
export { t };
