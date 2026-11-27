import { describe, it, expect, vi, beforeEach } from "vitest";

let stored: string[] = [];
const aiAllowedEndpoints = vi.fn(async () => [...stored]);
const aiRevokeEndpoint = vi.fn(async (origin: string) => {
  stored = stored.filter((o) => o !== origin);
});

vi.mock("../../utils/backend", () => ({
  aiAllowedEndpoints: () => aiAllowedEndpoints(),
  aiRevokeEndpoint: (o: string) => aiRevokeEndpoint(o),
}));

import { useAllowedAiEndpoints } from "../useAllowedAiEndpoints";

describe("useAllowedAiEndpoints", () => {
  beforeEach(() => {
    stored = ["https://a.example", "https://b.example"];
    aiAllowedEndpoints.mockClear();
    aiRevokeEndpoint.mockClear();
  });

  it("loads the allowed origins", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    expect(e.origins.value).toEqual(["https://a.example", "https://b.example"]);
    expect(e.loading.value).toBe(false);
  });

  it("revokes one and shows what is stored after", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    await e.revoke("https://a.example");
    expect(aiRevokeEndpoint).toHaveBeenCalledWith("https://a.example");
    expect(e.origins.value).toEqual(["https://b.example"]);
    expect(e.revoking.value).toBeNull();
  });

  it("reports a failed revoke and still reloads the list", async () => {
    aiRevokeEndpoint.mockRejectedValueOnce(new Error("keychain locked"));
    const e = useAllowedAiEndpoints();
    await e.load();
    await e.revoke("https://a.example");
    expect(e.error.value).toBe("keychain locked");
    expect(e.origins.value).toEqual(["https://a.example", "https://b.example"]);
    expect(aiAllowedEndpoints).toHaveBeenCalledTimes(2);
  });

  it("keeps loading until the last load lands, and takes only the latest answer", async () => {
    let releaseOld!: (v: string[]) => void;
    aiAllowedEndpoints.mockImplementationOnce(() => new Promise<string[]>((r) => (releaseOld = r)));
    const e = useAllowedAiEndpoints();
    const old = e.load();
    let releaseNew!: (v: string[]) => void;
    aiAllowedEndpoints.mockImplementationOnce(() => new Promise<string[]>((r) => (releaseNew = r)));
    const fresh = e.load();
    releaseNew(["https://b.example"]);
    await fresh;
    expect(e.loading.value).toBe(true);
    releaseOld(["https://a.example", "https://b.example"]);
    await old;
    expect(e.loading.value).toBe(false);
    expect(e.origins.value).toEqual(["https://b.example"]);
  });

  it("clears an earlier error when a new load starts", async () => {
    aiAllowedEndpoints.mockRejectedValueOnce(new Error("keychain locked"));
    const e = useAllowedAiEndpoints();
    await e.load();
    expect(e.error.value).toBe("keychain locked");
    let release!: (v: string[]) => void;
    aiAllowedEndpoints.mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)));
    const next = e.load();
    expect(e.error.value).toBeNull();
    release([]);
    await next;
  });

  it("keeps a failed revoke's message through a load that ends after it", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    let releaseOther!: (v: string[]) => void;
    aiAllowedEndpoints.mockImplementationOnce(() => new Promise<string[]>((r) => (releaseOther = r)));
    aiRevokeEndpoint.mockRejectedValueOnce(new Error("keychain locked"));
    // The revoke fails; its reload is held.
    const revoke = e.revoke("https://a.example");
    await new Promise((r) => setTimeout(r, 0));
    // Settings reopened meanwhile: a later load answers first.
    await e.load();
    expect(e.error.value).toBe("keychain locked");
    // Then the revoke's own reload lands.
    releaseOther(["https://a.example", "https://b.example"]);
    await revoke;
    expect(e.error.value).toBe("keychain locked");
  });

  it("shows a failed revoke's message over a failed reload, until a later read succeeds", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    aiRevokeEndpoint.mockRejectedValueOnce(new Error("revoke denied"));
    aiAllowedEndpoints.mockRejectedValueOnce(new Error("keychain locked"));
    await e.revoke("https://a.example");
    expect(e.error.value).toBe("revoke denied");
    // Keychain unlocked, Settings reloads: the list is what is stored.
    await e.load();
    expect(e.error.value).toBeNull();
  });

  it("ignores a second revoke until the first one's reload has ended", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    let release!: (v: string[]) => void;
    aiAllowedEndpoints.mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)));
    const first = e.revoke("https://a.example");
    await new Promise((r) => setTimeout(r, 0));
    expect(e.revoking.value).toBe("https://a.example");
    await e.revoke("https://b.example");
    expect(aiRevokeEndpoint).toHaveBeenCalledTimes(1);
    release(["https://b.example"]);
    await first;
    expect(e.revoking.value).toBeNull();
  });

  it("shows an older load's answer when the newer load fails", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    let releaseOld!: (v: string[]) => void;
    aiAllowedEndpoints.mockImplementationOnce(() => new Promise<string[]>((r) => (releaseOld = r)));
    const old = e.load();
    aiAllowedEndpoints.mockRejectedValueOnce(new Error("keychain locked"));
    await e.load();
    releaseOld(["https://b.example"]);
    await old;
    expect(e.origins.value).toEqual(["https://b.example"]);
    expect(e.error.value).toBe("keychain locked");
  });

  it("clears an earlier revoke failure as soon as a new revoke starts", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    aiRevokeEndpoint.mockRejectedValueOnce(new Error("revoke denied"));
    await e.revoke("https://a.example");
    expect(e.error.value).toBe("revoke denied");
    let release!: () => void;
    aiRevokeEndpoint.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const next = e.revoke("https://b.example");
    expect(e.error.value).toBeNull();
    release();
    await next;
  });

  it("ignores a second revoke while one runs", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    const first = e.revoke("https://a.example");
    await e.revoke("https://b.example");
    await first;
    expect(aiRevokeEndpoint).toHaveBeenCalledTimes(1);
  });
});
