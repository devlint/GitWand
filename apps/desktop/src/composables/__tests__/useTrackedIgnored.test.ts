// @vitest-environment jsdom
/**
 * useTrackedIgnored — state logic only. The two IPC wrappers are in-memory
 * stand-ins (not git: detection and untracking themselves are pinned on real
 * repos by the Rust tests in commands/tracked_ignored.rs and by
 * tests/parity/git-tracked-ignored.test.mjs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const gitTrackedIgnored = vi.fn();
const gitUntrackPaths = vi.fn();
vi.mock("../../utils/backend", () => ({
  gitTrackedIgnored: (...a: unknown[]) => gitTrackedIgnored(...a),
  gitUntrackPaths: (...a: unknown[]) => gitUntrackPaths(...a),
}));

import {
  isIgnoreFilePath,
  shouldRecheckTrackedIgnored,
  signatureOf,
  useTrackedIgnored,
} from "../useTrackedIgnored";

const info = (paths: string[], total = paths.length) => ({
  paths,
  total,
  truncated: total > paths.length,
});

describe("isIgnoreFilePath", () => {
  it("matches .gitignore at any depth and .git/info/exclude", () => {
    expect(isIgnoreFilePath(".gitignore")).toBe(true);
    expect(isIgnoreFilePath("pkg/sub/.gitignore")).toBe(true);
    expect(isIgnoreFilePath("pkg\\sub\\.gitignore")).toBe(true);
    expect(isIgnoreFilePath(".git/info/exclude")).toBe(true);
  });
  it("rejects look-alikes", () => {
    expect(isIgnoreFilePath("my.gitignore")).toBe(false);
    expect(isIgnoreFilePath(".gitignore.bak")).toBe(false);
    expect(isIgnoreFilePath("src/gitignore")).toBe(false);
    expect(isIgnoreFilePath(".git/info/refs")).toBe(false);
  });
});

describe("shouldRecheckTrackedIgnored", () => {
  it("reacts to ignore files, HEAD moves and truncated batches only", () => {
    const ev = (kinds: string[], paths: string[], truncated = false) => ({ kinds, paths, truncated });
    expect(shouldRecheckTrackedIgnored(ev(["worktree"], ["a/.gitignore"]))).toBe(true);
    expect(shouldRecheckTrackedIgnored(ev(["config"], [".git/info/exclude"]))).toBe(true);
    expect(shouldRecheckTrackedIgnored(ev(["head"], [".git/HEAD"]))).toBe(true);
    expect(shouldRecheckTrackedIgnored(ev(["worktree"], ["a.ts"], true))).toBe(true);
    expect(shouldRecheckTrackedIgnored(ev(["worktree"], ["a.ts", "src/b.ts"]))).toBe(false);
    expect(shouldRecheckTrackedIgnored(ev(["config"], [".git/config"]))).toBe(false);
  });
});

describe("signatureOf", () => {
  it("is order-independent and changes with the set or the total", () => {
    expect(signatureOf(info(["a", "b"]))).toBe(signatureOf(info(["b", "a"])));
    expect(signatureOf(info(["a", "b"]))).not.toBe(signatureOf(info(["a", "c"])));
    expect(signatureOf(info(["a"], 1))).not.toBe(signatureOf(info(["a"], 900)));
    // Boundary-safe: ["ab"] and ["a","b"] are different sets.
    expect(signatureOf(info(["ab"]))).not.toBe(signatureOf(info(["a", "b"])));
  });
});

describe("useTrackedIgnored", () => {
  const api = useTrackedIgnored();

  beforeEach(() => {
    localStorage.clear();
    gitTrackedIgnored.mockReset();
    gitUntrackPaths.mockReset();
    api.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the notice when tracked ignored files exist, hides it when none", async () => {
    gitTrackedIgnored.mockResolvedValue(info(["a.log"]));
    await api.check("/repo");
    expect(api.visible.value).toBe(true);
    expect(api.info.value?.total).toBe(1);

    gitTrackedIgnored.mockResolvedValue(info([]));
    await api.check("/repo");
    expect(api.visible.value).toBe(false);
  });

  it("remembers a dismissal per repo until the set of paths changes", async () => {
    gitTrackedIgnored.mockResolvedValue(info(["a.log", "b.log"]));
    await api.check("/repo");
    api.dismiss();
    expect(api.visible.value).toBe(false);

    // Same set, fresh session (state wiped, storage kept): still dismissed.
    api.reset();
    await api.check("/repo");
    expect(api.visible.value).toBe(false);

    // Another repo is unaffected.
    await api.check("/other");
    expect(api.visible.value).toBe(true);

    // The set changes: the notice returns.
    gitTrackedIgnored.mockResolvedValue(info(["a.log", "b.log", "c.log"]));
    await api.check("/repo");
    expect(api.visible.value).toBe(true);
  });

  it("forgets the dismissal once the list is empty, so a recurrence is shown", async () => {
    gitTrackedIgnored.mockResolvedValue(info(["a.log"]));
    await api.check("/repo");
    api.dismiss();
    gitTrackedIgnored.mockResolvedValue(info([]));
    await api.check("/repo");
    gitTrackedIgnored.mockResolvedValue(info(["a.log"]));
    await api.check("/repo");
    expect(api.visible.value).toBe(true);
  });

  it("survives a localStorage that throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    gitTrackedIgnored.mockResolvedValue(info(["a.log"]));
    await api.check("/repo");
    expect(() => api.dismiss()).not.toThrow();
    expect(api.visible.value).toBe(false); // dismissed for this session anyway
    spy.mockRestore();
    set.mockRestore();
  });

  it("a failing check clears the notice instead of surfacing an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gitTrackedIgnored.mockResolvedValue(info(["a.log"]));
    await api.check("/repo");
    gitTrackedIgnored.mockRejectedValue(new Error("boom"));
    await api.check("/repo");
    expect(api.visible.value).toBe(false);
    expect(api.error.value).toBeNull();
    warn.mockRestore();
  });

  it("ignores a stale response when the repo changed meanwhile", async () => {
    let resolveSlow!: (v: unknown) => void;
    gitTrackedIgnored.mockImplementationOnce(
      () => new Promise((r) => { resolveSlow = r; }),
    );
    const slow = api.check("/slow");
    gitTrackedIgnored.mockResolvedValue(info([]));
    await api.check("/fast");
    resolveSlow(info(["late.log"]));
    await slow;
    expect(api.visible.value).toBe(false);
  });

  it("untrack calls the backend then re-checks", async () => {
    gitTrackedIgnored.mockResolvedValue(info(["a.log", "b.log"]));
    await api.check("/repo");
    gitUntrackPaths.mockResolvedValue(undefined);
    gitTrackedIgnored.mockResolvedValue(info(["b.log"]));
    const ok = await api.untrack(["a.log"]);
    expect(ok).toBe(true);
    expect(gitUntrackPaths).toHaveBeenCalledWith("/repo", ["a.log"]);
    expect(api.info.value?.paths).toEqual(["b.log"]);
  });

  it("untrack failure reports the message and leaves the list alone", async () => {
    gitTrackedIgnored.mockResolvedValue(info(["a.log"]));
    await api.check("/repo");
    gitUntrackPaths.mockRejectedValue(new Error("index.lock exists"));
    const ok = await api.untrack(["a.log"]);
    expect(ok).toBe(false);
    expect(api.error.value).toBe("index.lock exists");
    expect(api.info.value?.paths).toEqual(["a.log"]);
    expect(api.untracking.value).toBe(false);
  });

  it("scheduleCheck debounces bursts into one backend call", async () => {
    vi.useFakeTimers();
    gitTrackedIgnored.mockResolvedValue(info([]));
    await api.check("/repo");
    gitTrackedIgnored.mockClear();
    api.scheduleCheck();
    api.scheduleCheck();
    api.scheduleCheck();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gitTrackedIgnored).toHaveBeenCalledTimes(1);
  });
});
