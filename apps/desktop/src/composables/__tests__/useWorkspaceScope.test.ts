import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceConfig } from "../../utils/backend";

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
import { useWorkspaceScope } from "../useWorkspaceScope";

const mockRead = vi.mocked(workspaceRead);
const mockWrite = vi.mocked(workspaceWrite);
const mockPathExists = vi.mocked(pathExists);

const REPO = "/repos/monorepo";

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset the module-scoped singleton between tests by loading a clean repo
  // with no persisted scope.
  mockRead.mockResolvedValue({ name: "ws", repos: [] });
  const { loadScope } = useWorkspaceScope();
  await loadScope(REPO);
  vi.clearAllMocks();
});

describe("useWorkspaceScope", () => {
  it("setScope updates activeScope and persists the scope field (round-trip)", async () => {
    const existing: WorkspaceConfig = {
      name: "ws",
      repos: [{ path: "/repos/monorepo", name: "monorepo" }],
    };
    mockRead.mockResolvedValue(existing);
    mockWrite.mockResolvedValue(undefined);

    const { setScope, activeScope } = useWorkspaceScope();
    await setScope("packages/core");

    expect(activeScope.value).toBe("packages/core");
    // Persisted by merging scope into the existing config (name + repos kept).
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenConfig] = mockWrite.mock.calls[0];
    expect(writtenPath).toBe(REPO);
    expect(writtenConfig).toEqual({
      name: "ws",
      repos: [{ path: "/repos/monorepo", name: "monorepo" }],
      scope: "packages/core",
    });
  });

  it("clearScope resets activeScope to null and drops the scope field", async () => {
    mockRead.mockResolvedValue({ name: "ws", repos: [], scope: "packages/core" });
    mockWrite.mockResolvedValue(undefined);

    const { setScope, clearScope, activeScope } = useWorkspaceScope();
    await setScope("packages/core");
    expect(activeScope.value).toBe("packages/core");

    await clearScope();
    expect(activeScope.value).toBeNull();
    // The last write must NOT carry a scope field (whole repo === absent).
    const calls = mockWrite.mock.calls;
    const lastWrite = calls[calls.length - 1];
    expect(lastWrite[1]).not.toHaveProperty("scope");
  });

  it("loadScope restores a persisted scope when the path still exists", async () => {
    mockRead.mockResolvedValue({ name: "ws", repos: [], scope: "packages/core" });
    mockPathExists.mockResolvedValue(true);

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(mockPathExists).toHaveBeenCalledWith(REPO, "packages/core");
    expect(activeScope.value).toBe("packages/core");
  });

  it("loadScope falls back to whole repo + notice when the persisted path is gone", async () => {
    mockRead.mockResolvedValue({ name: "ws", repos: [], scope: "packages/deleted" });
    mockPathExists.mockResolvedValue(false);
    mockWrite.mockResolvedValue(undefined);

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    // Invalid scope → whole repo.
    expect(activeScope.value).toBeNull();
    // One-time non-blocking notice surfaced.
    expect(pushLog).toHaveBeenCalledTimes(1);
    expect(pushLog.mock.calls[0][0]).toBe("warn");
    expect(pushLog.mock.calls[0][1]).toContain("scope.invalidNotice");
    // Stale scope scrubbed from the persisted config.
    expect(mockWrite).toHaveBeenCalled();
    const writeCalls = mockWrite.mock.calls;
    expect(writeCalls[writeCalls.length - 1][1]).not.toHaveProperty("scope");
  });

  it("loadScope yields whole repo when no workspace file exists (read throws)", async () => {
    mockRead.mockRejectedValue(new Error("No workspace file found"));

    const { loadScope, activeScope } = useWorkspaceScope();
    await loadScope(REPO);

    expect(activeScope.value).toBeNull();
    // No existence check needed when there's no persisted scope.
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it("setScope starts from a minimal config when no workspace file exists yet", async () => {
    mockRead.mockRejectedValue(new Error("No workspace file found"));
    mockWrite.mockResolvedValue(undefined);

    const { setScope } = useWorkspaceScope();
    await setScope("apps/web");

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const writtenConfig = mockWrite.mock.calls[0][1];
    // Falls back to the repo dir basename as the workspace name.
    expect(writtenConfig.name).toBe("monorepo");
    expect(writtenConfig.repos).toEqual([]);
    expect(writtenConfig.scope).toBe("apps/web");
  });
});
