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

  it("ignores a second revoke while one runs", async () => {
    const e = useAllowedAiEndpoints();
    await e.load();
    const first = e.revoke("https://a.example");
    await e.revoke("https://b.example");
    await first;
    expect(aiRevokeEndpoint).toHaveBeenCalledTimes(1);
  });
});
