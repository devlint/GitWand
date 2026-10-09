/**
 * The AI API key moved from the localStorage settings blob to the OS
 * keychain. These pin the migration and the "never written back" guarantee.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { aiApiKeySet, aiApiKeyHint } = vi.hoisted(() => ({
  aiApiKeySet: vi.fn(async (key: string): Promise<string | null> => (key ? "sk-a••••wxyz" : null)),
  aiApiKeyHint: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../../utils/backend", () => ({ aiApiKeySet, aiApiKeyHint }));

const SETTINGS_KEY = "gitwand-settings";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("useAiApiKey migration", () => {
  it("moves a legacy key to the keychain and removes it from localStorage", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-ant-legacy-wxyz", aiEnabled: true }));
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded, isAiApiKeyConfigured } = await import("../useAiApiKey");
    aiApiKeyHint.mockResolvedValueOnce("sk-a••••wxyz");
    stashLegacyAiApiKey("sk-ant-legacy-wxyz");
    await ensureAiApiKeyLoaded();
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-ant-legacy-wxyz");
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)!);
    expect(stored).not.toHaveProperty("aiApiKey");
    expect(stored.aiEnabled).toBe(true);
    expect(isAiApiKeyConfigured()).toBe(true);
  });

  it("keeps the legacy key when the keychain write fails, so the next launch retries", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-x" }));
    aiApiKeySet.mockRejectedValueOnce(new Error("keychain locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    stashLegacyAiApiKey("sk-x");
    await ensureAiApiKeyLoaded();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).aiApiKey).toBe("sk-x");
    warn.mockRestore();
  });

  it("loadSettings hands the legacy key over and saveSettings never writes it back", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-legacy-1234567" }));
    const { loadSettings, saveSettings } = await import("../useSettings");
    const s = loadSettings();
    expect(s).not.toHaveProperty("aiApiKey");
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-legacy-1234567");
    saveSettings({ ...s, aiApiKey: "sneaky" } as typeof s);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).not.toHaveProperty("aiApiKey");
  });
});
