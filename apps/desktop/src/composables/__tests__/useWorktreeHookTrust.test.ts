/**
 * The composable's flow is tested through `createWorktreeHookTrust` with
 * injected fakes, not by mocking `utils/backend` (apps/desktop/CLAUDE.md:
 * no Tauri command mocks). The backend side has its own real-repo tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookTrustStatus } from "../../utils/backend";
import { createWorktreeHookTrust } from "../useWorktreeHookTrust";

const trustMock = vi.fn<(cwd: string) => Promise<HookTrustStatus>>();
const setMock = vi.fn<(cwd: string, hash: string) => Promise<void>>();
let useWorktreeHookTrust: () => ReturnType<typeof createWorktreeHookTrust>;

function status(over: { trusted: boolean; hash: string | null }) {
  trustMock.mockResolvedValue({
    hooks: { setup: "bin/up", teardown: null, url: null },
    repoRoot: "/r",
    ...over,
  });
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useWorktreeHookTrust", () => {
  beforeEach(() => {
    trustMock.mockReset();
    setMock.mockReset();
    const instance = createWorktreeHookTrust({ status: trustMock, trust: setMock });
    useWorktreeHookTrust = () => instance;
  });

  it("returns run without prompting when trusted", async () => {
    const { ensureTrusted, pending } = useWorktreeHookTrust();
    status({ trusted: true, hash: null });
    expect((await ensureTrusted("/r")).choice).toBe("run");
    expect(pending.value).toBeNull();
  });

  it("prompts, then trust stores the hash and runs", async () => {
    const { ensureTrusted, pending, answer } = useWorktreeHookTrust();
    status({ trusted: false, hash: "h1" });
    setMock.mockResolvedValue(undefined);
    const p = ensureTrusted("/r");
    await flush();
    expect(pending.value?.hash).toBe("h1");
    await answer("trust");
    expect(setMock).toHaveBeenCalledWith("/r", "h1");
    expect((await p).choice).toBe("run");
    expect(pending.value).toBeNull();
  });

  it("skip and cancel resolve without storing", async () => {
    const { ensureTrusted, answer } = useWorktreeHookTrust();
    status({ trusted: false, hash: "h1" });
    const p1 = ensureTrusted("/r");
    await flush();
    await answer("skip");
    expect((await p1).choice).toBe("skip");
    const p2 = ensureTrusted("/r");
    await flush();
    await answer("cancel");
    expect((await p2).choice).toBe("cancel");
    expect(setMock).not.toHaveBeenCalled();
  });

  it("a stale hash keeps the modal open with the fresh hooks", async () => {
    const { ensureTrusted, pending, error, answer } = useWorktreeHookTrust();
    status({ trusted: false, hash: "h1" });
    setMock.mockRejectedValueOnce(new Error("The worktree hooks changed since you reviewed them. Review them again."));
    const p = ensureTrusted("/r");
    await flush();
    status({ trusted: false, hash: "h2" });
    await answer("trust");
    expect(error.value).toContain("changed since you reviewed");
    expect(pending.value?.hash).toBe("h2");
    setMock.mockResolvedValueOnce(undefined);
    await answer("trust");
    expect(setMock).toHaveBeenLastCalledWith("/r", "h2");
    expect((await p).choice).toBe("run");
    expect(error.value).toBeNull();
  });

  it("a second request while one is pending is cancelled", async () => {
    const { ensureTrusted, answer } = useWorktreeHookTrust();
    status({ trusted: false, hash: "h1" });
    const p1 = ensureTrusted("/r");
    await flush();
    expect((await ensureTrusted("/r")).choice).toBe("cancel");
    await answer("skip");
    expect((await p1).choice).toBe("skip");
  });

  it("returns the exact status the user approved, so the caller runs those hooks", async () => {
    const { ensureTrusted, answer } = useWorktreeHookTrust();
    status({ trusted: false, hash: "h1" });
    setMock.mockResolvedValue(undefined);
    const p = ensureTrusted("/r");
    await flush();
    await answer("trust");
    const d = await p;
    expect(d.choice).toBe("run");
    expect(d.status?.hash).toBe("h1");
    expect(d.status?.hooks.setup).toBe("bin/up");
  });

  it("ignores answers while a trust is in flight and exposes busy", async () => {
    const { ensureTrusted, answer, busy, pending } = useWorktreeHookTrust();
    status({ trusted: false, hash: "h1" });
    let release!: () => void;
    setMock.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const p = ensureTrusted("/r");
    await flush();
    const first = answer("trust");
    expect(busy.value).toBe(true);
    await answer("cancel");
    await answer("trust");
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(pending.value).not.toBeNull();
    release();
    await first;
    expect((await p).choice).toBe("run");
    expect(busy.value).toBe(false);
  });
});
