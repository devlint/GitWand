/**
 * The per-folder remote store (#301, part 4): one source for the commit panel's
 * `#` list and the created-issue notice.
 */
import { describe, it, expect, vi } from "vitest";
import type { RemoteInfo } from "../../utils/backend";
import { createRemoteStore } from "../useRepoRemote";

const GH: RemoteInfo = { name: "origin", url: "git@github.com:me/app.git", provider: "github", owner: "me", repo: "app" };
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

describe("createRemoteStore", () => {
  it("reads a folder's remote and gives its slug", async () => {
    const store = createRemoteStore({ read: async () => GH });
    await store.load("/r");
    expect(store.info("/r")).toEqual(GH);
    expect(store.slug("/r")).toBe("me/app");
  });

  it("keeps the known remote on a transient failure, forgets one that is gone", async () => {
    const read = vi.fn<(cwd: string) => Promise<RemoteInfo>>().mockResolvedValueOnce(GH).mockRejectedValueOnce(new Error("timeout"));
    const store = createRemoteStore({ read });
    await store.load("/r");
    await store.load("/r");
    expect(store.info("/r")).toEqual(GH);
    read.mockRejectedValueOnce(new Error("No remote found"));
    await store.load("/r");
    expect(store.info("/r")).toBeNull();
  });

  it("an empty unknown answer (the dev server on an error) keeps the known remote", async () => {
    const read = vi.fn<(cwd: string) => Promise<RemoteInfo>>().mockResolvedValueOnce(GH)
      .mockResolvedValueOnce({ name: "", url: "", provider: "unknown", owner: "", repo: "" });
    const store = createRemoteStore({ read });
    await store.load("/r");
    await store.load("/r");
    expect(store.info("/r")).toEqual(GH);
  });

  it("an older read landing after a newer one is dropped", async () => {
    let first!: (v: RemoteInfo) => void;
    const read = vi.fn<(cwd: string) => Promise<RemoteInfo>>()
      .mockImplementationOnce(() => new Promise((r) => { first = r; }))
      .mockResolvedValueOnce({ ...GH, url: "git@github.com:me/new.git", repo: "new" });
    const store = createRemoteStore({ read });
    const a = store.load("/r");
    await store.load("/r");
    first(GH);
    await a;
    expect(store.slug("/r")).toBe("me/new");
  });

  it("the same remote again keeps its object (nothing watching it re-runs)", async () => {
    const store = createRemoteStore({ read: async () => ({ ...GH }) });
    await store.load("/r");
    const before = store.info("/r");
    await store.load("/r");
    expect(store.info("/r")).toBe(before);
  });

  it("loadIfOlder reads again only past the age given", async () => {
    let t = 0;
    const read = vi.fn(async () => GH);
    const store = createRemoteStore({ read, now: () => t });
    await store.load("/r");
    store.loadIfOlder("/r", 10_000);
    t = 10_001;
    store.loadIfOlder("/r", 10_000);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
