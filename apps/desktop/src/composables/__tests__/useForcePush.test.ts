import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// The git reads are covered against real repos in upstreamRewrite.git.test.ts;
// here they are controlled, to drive the decision's races.
const target = vi.fn();
vi.mock("../useBranchUpdatePrompt", () => ({
  fetchPushRemote: vi.fn(async () => {}),
  forcePushTarget: (...a: unknown[]) => target(...a),
}));

import { useForcePush } from "../useForcePush";

const SHA = "a".repeat(40);

function setup(branch = "feature") {
  const folderPath = ref<string | null>("/repo");
  const current = ref(branch);
  const isPushing = ref(false);
  const pushes: Array<string | null> = [];
  const fetch = vi.fn(async () => {});
  const publishing = ref(false);
  const fp = useForcePush({
    folderPath,
    currentBranch: () => current.value,
    isPushing,
    publishing: () => publishing.value,
    fetch,
    refresh: async () => {},
    push: async (lease) => {
      pushes.push(lease);
    },
  });
  return { fp, folderPath, current, isPushing, pushes, fetch, publishing };
}

beforeEach(() => {
  target.mockReset();
});

describe("useForcePush", () => {
  it("fetches, then pushes on the tip it read when nothing would be overwritten", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 0, branch: "feature" });
    const { fp, pushes, fetch } = setup();
    await fp.requestForcePush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pushes).toEqual([SHA]);
    expect(fp.forcePushConfirm.value).toBeNull();
  });

  it("asks first when the remote has commits the push overwrites, then pushes on that tip", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 3, branch: "feature" });
    const { fp, pushes } = setup();
    await fp.requestForcePush();
    expect(pushes).toEqual([]);
    expect(fp.forcePushConfirm.value).toMatchObject({ behind: 3, leaseSha: SHA, protected: false });
    await fp.confirmForcePush();
    expect(pushes).toEqual([SHA]);
  });

  it("protects a trunk under its remote name", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 0, branch: "main" });
    const { fp, pushes } = setup("mine");
    await fp.requestForcePush();
    expect(pushes).toEqual([]);
    expect(fp.forcePushConfirm.value).toMatchObject({ protected: true, protectedName: "main" });
  });

  // Without a remote branch name the backend would refuse the lease: none is
  // sent, and the backend falls back.
  it("sends no lease when the remote branch name cannot be read", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 0, branch: null });
    const { fp, pushes } = setup();
    await fp.requestForcePush();
    expect(pushes).toEqual([null]);
  });

  // A publish pushes to origin/<branch>: that is the ref judged.
  it("judges a publish against origin/<branch>", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 2, branch: "feature" });
    const { fp, publishing } = setup();
    publishing.value = true;
    await fp.requestForcePush();
    expect(target).toHaveBeenCalledWith("/repo", { publishBranch: "feature" });
    expect(fp.forcePushConfirm.value).toMatchObject({ behind: 2 });
  });

  it("announces nothing to overwrite when no destination can be read", async () => {
    target.mockResolvedValue(null);
    const { fp, pushes } = setup();
    await fp.requestForcePush();
    expect(pushes).toEqual([null]);
  });

  it("ignores a second request while the first is being decided", async () => {
    let release!: (v: unknown) => void;
    target.mockReturnValue(new Promise((r) => (release = r)));
    const { fp, pushes } = setup();
    const first = fp.requestForcePush();
    await fp.requestForcePush();
    release({ sha: SHA, behind: 0, branch: "feature" });
    await first;
    expect(pushes).toEqual([SHA]);
  });

  it("drops the request when the branch changes while the tip is read", async () => {
    let release!: (v: unknown) => void;
    target.mockReturnValue(new Promise((r) => (release = r)));
    const { fp, pushes, current } = setup();
    const first = fp.requestForcePush();
    current.value = "main";
    release({ sha: SHA, behind: 2, branch: "feature" });
    await first;
    expect(pushes).toEqual([]);
    expect(fp.forcePushConfirm.value).toBeNull();
  });

  it("drops a confirmation made after a branch or repository switch", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 1, branch: "feature" });
    const a = setup();
    await a.fp.requestForcePush();
    a.current.value = "other";
    await a.fp.confirmForcePush();
    expect(a.pushes).toEqual([]);
    expect(a.fp.forcePushConfirm.value).toBeNull();

    const b = setup();
    await b.fp.requestForcePush();
    b.folderPath.value = "/other-repo";
    await b.fp.confirmForcePush();
    expect(b.pushes).toEqual([]);
  });

  it("shows it is deciding while it fetches and reads the tip", async () => {
    let release!: (v: unknown) => void;
    target.mockReturnValue(new Promise((r) => (release = r)));
    const { fp } = setup();
    const req = fp.requestForcePush();
    await Promise.resolve();
    expect(fp.deciding.value).toBe(true);
    release({ sha: SHA, behind: 0, branch: "feature" });
    await req;
    expect(fp.deciding.value).toBe(false);
  });

  // Push clicked while the force push was deciding: they would overlap.
  it("drops the request when a push started meanwhile", async () => {
    let release!: (v: unknown) => void;
    target.mockReturnValue(new Promise((r) => (release = r)));
    const { fp, pushes, isPushing } = setup();
    const req = fp.requestForcePush();
    isPushing.value = true;
    release({ sha: SHA, behind: 0, branch: "feature" });
    await req;
    expect(pushes).toEqual([]);
  });

  it("keeps the confirmation open while a push runs", async () => {
    target.mockResolvedValue({ sha: SHA, behind: 1, branch: "feature" });
    const { fp, pushes, isPushing } = setup();
    await fp.requestForcePush();
    isPushing.value = true;
    await fp.confirmForcePush();
    expect(pushes).toEqual([]);
    expect(fp.forcePushConfirm.value).not.toBeNull();
    isPushing.value = false;
    await fp.confirmForcePush();
    expect(pushes).toEqual([SHA]);
  });
});
