/**
 * The AI API key moved from the localStorage settings blob to the OS
 * keychain. These pin the migration, the "never written back" guarantee, and
 * that a failed migration never loses the only copy of the key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Info = { hint: string; origin: string | null };
const { aiApiKeySet, aiApiKeyHint } = vi.hoisted(() => ({
  aiApiKeySet: vi.fn(async (key: string, endpoint?: string): Promise<Info | null> =>
    key ? { hint: "sk-a••••wxyz", origin: endpoint ? new URL(endpoint).origin : null } : null),
  aiApiKeyHint: vi.fn(async (): Promise<Info | null> => null),
}));
vi.mock("../../utils/backend", () => ({ aiApiKeySet, aiApiKeyHint }));

const SETTINGS_KEY = "gitwand-settings";
const stored = () => JSON.parse(localStorage.getItem(SETTINGS_KEY)!);

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("useAiApiKey migration", () => {
  it("moves a legacy key to the keychain, bound to its endpoint, and removes it from localStorage", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-ant-legacy-wxyz", aiEnabled: true }));
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded, isAiApiKeyConfigured } = await import("../useAiApiKey");
    aiApiKeyHint.mockResolvedValueOnce({ hint: "sk-a••••wxyz", origin: "https://api.anthropic.com" });
    stashLegacyAiApiKey("sk-ant-legacy-wxyz", "https://api.anthropic.com");
    await ensureAiApiKeyLoaded();
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-ant-legacy-wxyz", "https://api.anthropic.com");
    expect(stored()).not.toHaveProperty("aiApiKey");
    expect(stored().aiEnabled).toBe(true);
    expect(isAiApiKeyConfigured()).toBe(true);
  });

  it("binds a legacy key to the endpoint it was used with, Anthropic by default", async () => {
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    stashLegacyAiApiKey("sk-x", "");
    await ensureAiApiKeyLoaded();
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-x", "https://api.anthropic.com");
  });

  it("keeps the legacy key when the keychain write fails, so the next launch retries", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-x" }));
    aiApiKeySet.mockRejectedValueOnce(new Error("keychain locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    stashLegacyAiApiKey("sk-x");
    await ensureAiApiKeyLoaded();
    expect(stored().aiApiKey).toBe("sk-x");
    warn.mockRestore();
  });

  it("a settings save after a failed migration keeps the legacy key (its only copy)", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-only-copy-1234", aiEnabled: true }));
    aiApiKeySet.mockRejectedValueOnce(new Error("libsecret missing"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadSettings, saveSettings } = await import("../useSettings");
    const { ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    const s = loadSettings();
    expect(s).not.toHaveProperty("aiApiKey");
    await ensureAiApiKeyLoaded();
    // Any later write of the settings — a toggle flipped anywhere in the app.
    saveSettings({ ...s, aiEnabled: false });
    expect(stored().aiApiKey).toBe("sk-only-copy-1234");
    expect(stored().aiEnabled).toBe(false);
    warn.mockRestore();
  });

  it("a settings save while the migration is still in flight keeps the legacy key", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-inflight-1234" }));
    let fail!: (e: Error) => void;
    aiApiKeySet.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadSettings, saveSettings } = await import("../useSettings");
    const { ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    const s = loadSettings();
    saveSettings(s);
    expect(stored().aiApiKey).toBe("sk-inflight-1234");
    fail(new Error("keychain locked"));
    await ensureAiApiKeyLoaded();
    saveSettings(s);
    expect(stored().aiApiKey).toBe("sk-inflight-1234");
    warn.mockRestore();
  });

  it("a key entered after a failed migration supersedes the legacy one", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-old" }));
    aiApiKeySet.mockRejectedValueOnce(new Error("keychain locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadSettings, saveSettings } = await import("../useSettings");
    const { ensureAiApiKeyLoaded, useAiApiKey } = await import("../useAiApiKey");
    const s = loadSettings();
    await ensureAiApiKeyLoaded();
    await useAiApiKey().save("sk-new", "https://api.anthropic.com");
    expect(stored()).not.toHaveProperty("aiApiKey");
    saveSettings(s);
    expect(stored()).not.toHaveProperty("aiApiKey");
    warn.mockRestore();
  });

  it("loadSettings hands the legacy key over and saveSettings never writes it back", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-legacy-1234567" }));
    const { loadSettings, saveSettings } = await import("../useSettings");
    const { ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    const s = loadSettings();
    expect(s).not.toHaveProperty("aiApiKey");
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-legacy-1234567", "https://api.anthropic.com");
    await ensureAiApiKeyLoaded();
    saveSettings({ ...s, aiApiKey: "sneaky" } as typeof s);
    expect(stored()).not.toHaveProperty("aiApiKey");
  });
});

describe("useAiApiKey endpoint binding", () => {
  it("flags a key bound to another origin, or to none", async () => {
    const { useAiApiKey } = await import("../useAiApiKey");
    const k = useAiApiKey();
    expect(k.boundElsewhere("https://api.openai.com/v1")).toBe(false); // nothing stored
    await k.save("sk-1", "https://api.anthropic.com");
    expect(aiApiKeySet).toHaveBeenLastCalledWith("sk-1", "https://api.anthropic.com");
    expect(k.boundElsewhere("https://api.anthropic.com/")).toBe(false);
    expect(k.boundElsewhere("https://api.openai.com/v1")).toBe(true);
    expect(k.boundElsewhere("not a url")).toBe(true);
    aiApiKeySet.mockResolvedValueOnce({ hint: "••••••••", origin: null });
    await k.save("sk-2", "https://api.anthropic.com");
    expect(k.boundElsewhere("https://api.anthropic.com")).toBe(true);
  });
});

describe("useAiApiKeyDraft (Settings key input)", () => {
  it("saves a pending draft when its owner goes away (Settings closed before blur)", async () => {
    const { effectScope } = await import("vue");
    const { useAiApiKeyDraft, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    await ensureAiApiKeyLoaded();
    const scope = effectScope();
    const d = scope.run(() => useAiApiKeyDraft(() => "https://api.openai.com/v1"))!;
    d.draft.value = "  sk-pasted-1234  ";
    expect(aiApiKeySet).not.toHaveBeenCalled();
    scope.stop();
    await Promise.resolve();
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-pasted-1234", "https://api.openai.com/v1");
  });

  it("does nothing on dispose with an empty draft, and clears the draft once saved", async () => {
    const { effectScope } = await import("vue");
    const { useAiApiKeyDraft, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    await ensureAiApiKeyLoaded();
    const scope = effectScope();
    const d = scope.run(() => useAiApiKeyDraft(() => "https://api.anthropic.com"))!;
    d.draft.value = "sk-typed";
    await d.save();
    expect(d.draft.value).toBe("");
    expect(aiApiKeySet).toHaveBeenCalledTimes(1);
    scope.stop();
    await Promise.resolve();
    expect(aiApiKeySet).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and reports the error when the keychain refuses it", async () => {
    const { useAiApiKeyDraft, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    await ensureAiApiKeyLoaded();
    aiApiKeySet.mockRejectedValueOnce(new Error("keychain locked"));
    const d = useAiApiKeyDraft(() => "https://api.anthropic.com");
    d.draft.value = "sk-typed";
    await d.save();
    expect(d.draft.value).toBe("sk-typed");
    expect(d.error.value).toBe("keychain locked");
  });
});

describe("useAiApiKey — permanent migration failures and ordering", () => {
  it("repairs a legacy endpoint saved without a scheme", async () => {
    const { repairLegacyEndpoint } = await import("../useAiApiKey");
    expect(repairLegacyEndpoint("")).toBe("https://api.anthropic.com");
    expect(repairLegacyEndpoint(undefined)).toBe("https://api.anthropic.com");
    expect(repairLegacyEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(repairLegacyEndpoint("localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(repairLegacyEndpoint("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(repairLegacyEndpoint("api.example.com/v1")).toBe("https://api.example.com/v1");
    // localhost.evil.com is not loopback.
    expect(repairLegacyEndpoint("localhost.evil.com/v1")).toBe("https://localhost.evil.com/v1");
    expect(repairLegacyEndpoint("host.docker.internal.evil.com")).toBe("https://host.docker.internal.evil.com");
    expect(repairLegacyEndpoint("ftp://x")).toBeNull();
    expect(repairLegacyEndpoint("not a url at all")).toBeNull();
    // Loopback, private, link-local and the Docker host are reached over http.
    for (const [raw, want] of [
      ["192.168.1.20:11434", "http://192.168.1.20:11434"],
      ["10.0.0.5/v1", "http://10.0.0.5/v1"],
      ["172.20.1.1:8080", "http://172.20.1.1:8080"],
      ["169.254.0.9", "http://169.254.0.9"],
      ["0.0.0.0:11434", "http://0.0.0.0:11434"],
      ["host.docker.internal:11434", "http://host.docker.internal:11434"],
      ["[::1]:8080", "http://[::1]:8080"],
      // Names that only look internal may be HTTPS-only gateways: https.
      ["gpu-box.local:8000/v1", "https://gpu-box.local:8000/v1"],
      ["llm.corp.internal/v1", "https://llm.corp.internal/v1"],
      ["ollama:11434", "https://ollama:11434"],
      ["ai-proxy:443/v1", "https://ai-proxy:443/v1"],
      // :443 means TLS, even on a private address.
      ["10.0.0.5:443/v1", "https://10.0.0.5:443/v1"],
      // Public hosts keep https, explicit port or not.
      ["172.32.0.1", "https://172.32.0.1"],
      ["8.8.8.8:8443", "https://8.8.8.8:8443"],
      ["api.example.com:8443/v1", "https://api.example.com:8443/v1"],
    ] as const) {
      expect(repairLegacyEndpoint(raw), raw).toBe(want);
    }
  });

  it("normalizeEndpointSetting repairs scheme-less endpoints only", async () => {
    const { normalizeEndpointSetting } = await import("../useAiApiKey");
    expect(normalizeEndpointSetting("localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(normalizeEndpointSetting("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeEndpointSetting("")).toBe("");
    expect(normalizeEndpointSetting("ftp://x")).toBe("ftp://x");
    expect(normalizeEndpointSetting(undefined)).toBe("");
  });

  it("migrates a key whose endpoint lacks a scheme, bound to the repaired endpoint", async () => {
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded } = await import("../useAiApiKey");
    stashLegacyAiApiKey("sk-local", "localhost:8080/v1");
    await ensureAiApiKeyLoaded();
    expect(aiApiKeySet).toHaveBeenCalledWith("sk-local", "http://localhost:8080/v1");
  });

  it("loadSettings repairs the scheme-less endpoint too", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiEndpoint: "localhost:8080/v1" }));
    const { loadSettings } = await import("../useSettings");
    expect(loadSettings().aiApiEndpoint).toBe("http://localhost:8080/v1");
  });

  it("an unusable endpoint is reported, not retried forever in silence; the user can remove the key", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-stuck", aiApiEndpoint: "ftp://x" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadSettings, saveSettings } = await import("../useSettings");
    const { ensureAiApiKeyLoaded, useAiApiKey } = await import("../useAiApiKey");
    const s = loadSettings();
    await ensureAiApiKeyLoaded();
    expect(aiApiKeySet).not.toHaveBeenCalled();
    const k = useAiApiKey();
    expect(k.legacyKeyStuck.value).toBe(true);
    expect(stored().aiApiKey).toBe("sk-stuck"); // still its only copy
    k.discardLegacyKey();
    expect(k.legacyKeyStuck.value).toBe(false);
    expect(stored()).not.toHaveProperty("aiApiKey");
    saveSettings(s);
    expect(stored()).not.toHaveProperty("aiApiKey");
    warn.mockRestore();
  });

  it("a keychain failure is reported as a stuck key too", async () => {
    aiApiKeySet.mockRejectedValueOnce(new Error("keychain locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stashLegacyAiApiKey, ensureAiApiKeyLoaded, useAiApiKey } = await import("../useAiApiKey");
    stashLegacyAiApiKey("sk-x");
    await ensureAiApiKeyLoaded();
    expect(useAiApiKey().legacyKeyStuck.value).toBe(true);
    warn.mockRestore();
  });

  it("a clear made while the migration is in flight is not undone by it", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ aiApiKey: "sk-legacy" }));
    let finish!: (v: Info) => void;
    aiApiKeySet.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const { stashLegacyAiApiKey, useAiApiKey } = await import("../useAiApiKey");
    stashLegacyAiApiKey("sk-legacy", "https://api.anthropic.com");
    const k = useAiApiKey();
    const cleared = k.clear();
    // The migration finishes after the user asked for the clear.
    finish({ hint: "sk-l••••gacy", origin: "https://api.anthropic.com" });
    await cleared;
    expect(aiApiKeySet.mock.calls.map((c) => c[0])).toEqual(["sk-legacy", ""]);
    expect(k.hint.value).toBeNull();
    expect(k.configured.value).toBe(false);
  });
});
