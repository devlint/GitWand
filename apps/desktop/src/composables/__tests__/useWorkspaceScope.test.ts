// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the backend IPC layer — no real Tauri / git.
vi.mock("../../utils/backend", () => ({
  workspaceRead: vi.fn(),
  workspaceWrite: vi.fn(),
  pathExists: vi.fn(),
}));

// Mock i18n so t() returns the key (deterministic, no locale load).
vi.mock("../useI18n", () => ({
  t: (key: string, ...args: Array<string | number>) =>
    args.length ? `${key}:${args.join(",")}` : key,
}));

// Capture pushLog calls to assert the one-time notice fires.
const pushLog = vi.fn();
vi.mock("../useLogs", () => ({
  useLogs: () => ({ pushLog }),
}));

import { workspaceRead, workspaceWrite, pathExists } from "../../utils/backend";
import { useWorkspaceScope, SCOPE_STORAGE_PREFIX } from "../useWorkspaceScope";

const mockRead = vi.mocked(workspaceRead);
const mockWrite = vi.mocked(workspaceWrite);
const mockPathExists = vi.mocked(pathExists);

const REPO = "/repos/monorepo";
const stored = () => localStorage.getItem(SCOPE_STORAGE_PREFIX + REPO);

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  // Reset the module-scoped singleton between tests by loading a clean repo
  // with no persisted scope.
  mockRead.mockRejectedValue(new Error("No workspace file found"));
  const { loadScope } = useWorkspaceScope();
  await loadScope(REPO);
  localStorage.clear();
  vi.clearAllMocks();
});

describe("useWorkspaceScope", () => {
  it("setScope updates activeScope and persists it locally, never in the repo", async () => {
    const { setScope, activeScope } = useWorkspaceScope();
    await setScope("packages/core");

    expect(activeScope.value).toBe("packages/core");
    expect(stored()).toBe("packages/core");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("clearScope resets activeScope and records the whole repo, without touching the repo", async () => {
    const { setScope, clearScope, activeScope } = useWorkspaceScope();
    await setScope("packages/core");
    await clearScope();

    expect(activeScope.value).toBeNull();
    // An empty value, not a missing key: the scope was decided, it is the whole repo.
    expect(stored()).toBe("");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("loadScope restores the locally persisted scope when the path still exists", async () => {
    localStorage.setItem(SCOPE_STORAGE_PREFIX + REPO, "packages/core");
    mockPathExists.mockResolvedValue(true);

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(mockPathExists).toHaveBeenCalledWith(REPO, "packages/core");
    expect(activeScope.value).toBe("packages/core");
    // The local value wins: the workspace file is not consulted.
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("loadScope keeps the whole repo when it was cleared locally, even if the file still has a scope", async () => {
    localStorage.setItem(SCOPE_STORAGE_PREFIX + REPO, "");
    mockRead.mockResolvedValue({ name: "ws", repos: [], scope: "packages/core" });

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(activeScope.value).toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("loadScope falls back to whole repo + one notice when the persisted path is gone", async () => {
    localStorage.setItem(SCOPE_STORAGE_PREFIX + REPO, "packages/deleted");
    mockPathExists.mockResolvedValue(false);

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(activeScope.value).toBeNull();
    expect(pushLog).toHaveBeenCalledTimes(1);
    expect(pushLog.mock.calls[0][0]).toBe("warn");
    expect(pushLog.mock.calls[0][1]).toContain("scope.invalidNotice");
    // The stale scope is dropped locally so the notice does not fire again.
    expect(stored()).toBe("");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("loadScope yields whole repo when nothing is persisted anywhere", async () => {
    mockRead.mockRejectedValue(new Error("No workspace file found"));

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(activeScope.value).toBeNull();
    expect(mockPathExists).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("migrates a scope from an older .gitwand-workspace.json once, leaving the file untouched", async () => {
    mockRead.mockResolvedValue({ name: "ws", repos: [], scope: "packages/core" });
    mockPathExists.mockResolvedValue(true);

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(activeScope.value).toBe("packages/core");
    expect(stored()).toBe("packages/core");
    expect(mockWrite).not.toHaveBeenCalled();

    // Next open reads the local value only.
    mockRead.mockClear();
    await loadScope(REPO);
    expect(mockRead).not.toHaveBeenCalled();
    expect(activeScope.value).toBe("packages/core");
  });

  it("scopes are kept per repository", async () => {
    const OTHER = "/repos/other";
    const { loadScope, setScope, activeScope } = useWorkspaceScope();
    await setScope("packages/core");

    mockRead.mockRejectedValue(new Error("No workspace file found"));
    await loadScope(OTHER);
    expect(activeScope.value).toBeNull();

    mockPathExists.mockResolvedValue(true);
    await loadScope(REPO);
    expect(activeScope.value).toBe("packages/core");
  });

  it("still works when storage is unavailable", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { setScope, activeScope } = useWorkspaceScope();
    await expect(setScope("packages/core")).resolves.toBeUndefined();
    expect(activeScope.value).toBe("packages/core");
    spy.mockRestore();
  });
});
