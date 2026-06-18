/**
 * F1 — Mode hors-ligne — composable + network guard.
 *
 * Tests the two surfaces that the rest of the app talks to:
 *
 *  - `useConnectivity` / `probeConnectivity` — flips `isOnline` based on the
 *    result of `checkRemoteReachable`, and emits a log entry on transitions.
 *  - `requireOnline` (`utils/networkGuard.ts`) — returns `false` + logs a
 *    `warn` entry when offline, returns `true` when online.
 *
 * We don't need integration coverage for the polling loop here — the poller
 * is unit-tested elsewhere; this file only proves the bridge between the
 * probe layer and the guard layer is wired correctly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock the backend module BEFORE importing the composable ──────────
//
// `useConnectivity` imports `checkRemoteReachable` and `gitRemoteInfo`
// from `../utils/backend` at module load. Mocking the module via
// `vi.mock` lets us swap the implementations without touching the
// network or starting a Tauri runtime.

const mockCheckRemoteReachable = vi.fn<
  (url: string, timeoutMs: number) => Promise<boolean>
>();
const mockGitRemoteInfo = vi.fn<(cwd: string) => Promise<{
  name: string;
  url: string;
  provider: string;
  owner: string;
  repo: string;
}>>();

vi.mock("../utils/backend", () => ({
  checkRemoteReachable: (url: string, timeoutMs: number) =>
    mockCheckRemoteReachable(url, timeoutMs),
  gitRemoteInfo: (cwd: string) => mockGitRemoteInfo(cwd),
}));

// Import AFTER vi.mock so the modules pick up the mocked backend.
// `isOnline` is the module-level singleton ref; we reset it before each test.
import {
  isOnline,
  lastCheckedAt,
  probeConnectivity,
  confirmOnline,
  _resetConnectivityState,
} from "../composables/useConnectivity";
import { requireOnline } from "../utils/networkGuard";
import { useLogs } from "../composables/useLogs";

const REMOTE = {
  name: "origin",
  url: "https://github.com/foo/bar.git",
  provider: "github",
  owner: "foo",
  repo: "bar",
};

describe("F1 — useConnectivity.probeConnectivity", () => {
  beforeEach(() => {
    // Reset singletons between tests so each case starts from a clean slate.
    isOnline.value = true;
    lastCheckedAt.value = null;
    _resetConnectivityState();
    mockCheckRemoteReachable.mockReset();
    mockGitRemoteInfo.mockReset();
    // Drain the shared log buffer so we can assert on what THIS test wrote.
    useLogs().clearLogs();
  });

  it("does NOT flip offline on a single failed probe (hysteresis)", async () => {
    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(false);

    // One dropped probe must not light the Offline pill — a transient hiccup
    // shouldn't block the user. Only OFFLINE_THRESHOLD (2) consecutive
    // failures do.
    await probeConnectivity("/tmp/repo");
    expect(isOnline.value).toBe(true);

    await probeConnectivity("/tmp/repo");
    expect(isOnline.value).toBe(false);
  });

  it("logs a WARN only once sustained failure flips us offline", async () => {
    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(false);

    await probeConnectivity("/tmp/repo"); // fail #1 — no transition yet
    await probeConnectivity("/tmp/repo"); // fail #2 — flips offline

    const warns = useLogs().entries.value.filter((e) => e.level === "warn");
    expect(warns.some((e) => /Connectivity lost/i.test(e.message))).toBe(true);
  });

  it("recovers online on the FIRST successful probe", async () => {
    isOnline.value = false;
    useLogs().clearLogs();

    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(true);

    await probeConnectivity("/tmp/repo");

    expect(isOnline.value).toBe(true);
    const infos = useLogs().entries.value.filter((e) => e.level === "info");
    expect(infos.some((e) => /restored/i.test(e.message))).toBe(true);
  });

  it("does not probe when no repo path is provided (stays optimistic)", async () => {
    await probeConnectivity(null);
    expect(mockCheckRemoteReachable).not.toHaveBeenCalled();
    expect(isOnline.value).toBe(true);
  });

  it("does not flip state when gitRemoteInfo throws (no remote configured)", async () => {
    mockGitRemoteInfo.mockRejectedValue(new Error("No remote found"));
    isOnline.value = true;

    await probeConnectivity("/tmp/repo");

    expect(mockCheckRemoteReachable).not.toHaveBeenCalled();
    expect(isOnline.value).toBe(true);
  });
});

describe("F1 — useConnectivity.confirmOnline (on-demand, authoritative)", () => {
  beforeEach(() => {
    isOnline.value = true;
    lastCheckedAt.value = null;
    _resetConnectivityState();
    mockCheckRemoteReachable.mockReset();
    mockGitRemoteInfo.mockReset();
    useLogs().clearLogs();
  });

  it("stays optimistic (true, no probe) when there's no known repo to test", async () => {
    expect(await confirmOnline()).toBe(true);
    expect(mockCheckRemoteReachable).not.toHaveBeenCalled();
  });

  it("re-probes and ALLOWS when reachable, even if the flag was stale-offline", async () => {
    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(true);
    // Seed _lastRepoPath via a probe, then simulate a stale offline flag.
    await probeConnectivity("/tmp/repo");
    isOnline.value = false;
    lastCheckedAt.value = Date.now() - 60_000; // force a fresh probe
    mockCheckRemoteReachable.mockClear();

    const ok = await confirmOnline();

    expect(ok).toBe(true); // fresh probe wins over the stale flag
    expect(mockCheckRemoteReachable).toHaveBeenCalledTimes(1);
    expect(isOnline.value).toBe(true);
  });

  it("re-probes and BLOCKS when a fresh probe confirms unreachable", async () => {
    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(false);
    await probeConnectivity("/tmp/repo"); // seeds _lastRepoPath
    mockCheckRemoteReachable.mockClear();

    expect(await confirmOnline()).toBe(false);
    expect(mockCheckRemoteReachable).toHaveBeenCalledTimes(1);
  });

  it("trusts a recent successful probe without re-probing", async () => {
    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(true);
    await probeConnectivity("/tmp/repo"); // success → fresh
    mockCheckRemoteReachable.mockClear();

    expect(await confirmOnline()).toBe(true);
    expect(mockCheckRemoteReachable).not.toHaveBeenCalled(); // fast path
  });
});

describe("F1 — networkGuard.requireOnline", () => {
  beforeEach(() => {
    isOnline.value = true;
    lastCheckedAt.value = null;
    _resetConnectivityState();
    mockCheckRemoteReachable.mockReset();
    mockGitRemoteInfo.mockReset();
    useLogs().clearLogs();
  });

  it("returns true when online (no repo seeded → optimistic)", async () => {
    expect(await requireOnline("push")).toBe(true);
    expect(useLogs().entries.value.length).toBe(0);
  });

  it("returns false when a fresh probe confirms offline", async () => {
    mockGitRemoteInfo.mockResolvedValue(REMOTE);
    mockCheckRemoteReachable.mockResolvedValue(false);
    // Drive fully offline first (2 failures past the hysteresis threshold) so
    // confirmOnline's own re-probe doesn't emit a fresh "Connectivity lost".
    await probeConnectivity("/tmp/repo");
    await probeConnectivity("/tmp/repo");
    useLogs().clearLogs(); // assert only on the guard's own log

    expect(await requireOnline("push")).toBe(false);

    const warns = useLogs().entries.value.filter((e) => e.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0].message).toContain("push");
    expect(warns[0].message).toMatch(/offline/i);
  });
});
