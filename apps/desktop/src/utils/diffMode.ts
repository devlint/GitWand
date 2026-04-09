export type DiffMode = "inline" | "side-by-side";

const SETTINGS_KEY = "gitwand-settings";

/** Read current diffMode from persisted settings */
export function getPersistedDiffMode(): DiffMode {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.diffMode === "side-by-side") return "side-by-side";
    }
  } catch { /* ignore */ }
  return "inline";
}

/** Persist diffMode into the shared settings object */
export function persistDiffMode(mode: DiffMode): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const settings = raw ? JSON.parse(raw) : {};
    settings.diffMode = mode;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}
