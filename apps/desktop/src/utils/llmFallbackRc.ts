import { normalizeHistoryConfig, type LlmFallbackConfig } from "@gitwand/core";

/**
 * v2.5 — Best-effort parse of the `llmFallback` block in a raw `.gitwandrc`.
 *
 * Mirrors the JSONC-tolerant logic in `SettingsPanel.vue#loadLlmFallback`
 * (single-line `//` + block `/* *\/` comments stripped before retry).
 * The endpoint field is never persisted, so it's stripped here too — it
 * gets injected programmatically by `loadRealFiles` later.
 *
 * Returns:
 *   - `null` if the file is empty, JSON-invalid, or has no `llmFallback` key
 *   - a clean `LlmFallbackConfig` (no `endpoint`) otherwise
 */
export function parseLlmFallbackFromRc(rawRc: string): LlmFallbackConfig | null {
  if (!rawRc || !rawRc.trim()) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawRc) as Record<string, unknown>;
  } catch {
    try {
      const stripped = rawRc
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const llm = parsed.llmFallback;
  if (!llm || typeof llm !== "object") return null;
  const obj = llm as Partial<LlmFallbackConfig> & { endpoint?: unknown };
  // Strip any (illegitimate) endpoint that may have slipped into the file —
  // it's never serialisable and must be injected programmatically.
  const { endpoint: _drop, enabled: rawEnabled, history: rawHistory, ...rest } = obj as typeof obj & { history?: unknown };
  void _drop;
  // `enabled` is required on the core type; default to false if absent so
  // the resolver simply skips LLM resolution (silent opt-out, by design).
  const cfg: LlmFallbackConfig = {
    enabled: typeof rawEnabled === "boolean" ? rawEnabled : false,
    ...rest,
  };
  const history = normalizeHistoryConfig(rawHistory);
  if (history) cfg.history = history;
  return cfg;
}
