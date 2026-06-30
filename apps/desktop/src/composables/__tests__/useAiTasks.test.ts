import { describe, it, expect, beforeEach } from "vitest";
import { useAiTasks, type AiTask } from "../useAiTasks";

const STORAGE_KEY = "gitwand-ai-tasks";

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    path: "/repos/myrepo.worktrees/gitwand-scratch-123",
    originCwd: "/repos/myrepo",
    branch: "gitwand-scratch-123",
    createdAt: 123,
    ...overrides,
  };
}

describe("useAiTasks", () => {
  beforeEach(() => {
    // Clear both the persisted store and the in-memory singleton.
    localStorage.clear();
    const { tasks, unregister } = useAiTasks();
    for (const path of Object.keys(tasks.value)) unregister(path);
  });

  it("registers a task, exposes it via get, and reports isAiTask", () => {
    const { register, get, isAiTask } = useAiTasks();
    const task = makeTask();

    register(task);

    expect(get(task.path)).toMatchObject({ originCwd: "/repos/myrepo", branch: "gitwand-scratch-123" });
    expect(isAiTask(task.path)).toBe(true);
  });

  it("persists registered tasks to localStorage", () => {
    const { register } = useAiTasks();
    register(makeTask());

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed["/repos/myrepo.worktrees/gitwand-scratch-123"]).toMatchObject({
      originCwd: "/repos/myrepo",
    });
  });

  it("normalizes trailing slashes so lookups match regardless of form", () => {
    const { register, get } = useAiTasks();
    register(makeTask({ path: "/repos/myrepo.worktrees/gitwand-scratch-123/" }));

    expect(get("/repos/myrepo.worktrees/gitwand-scratch-123")).toBeTruthy();
  });

  it("unregisters a task and clears it from storage", () => {
    const { register, unregister, get, isAiTask } = useAiTasks();
    const task = makeTask();
    register(task);

    unregister(task.path);

    expect(get(task.path)).toBeUndefined();
    // No registry entry — but the basename fallback still flags scratch dirs.
    expect(isAiTask(task.path)).toBe(true);
  });

  it("treats unregistered gitwand-scratch-* paths as AI tasks (basename fallback)", () => {
    const { isAiTask } = useAiTasks();
    expect(isAiTask("/somewhere/gitwand-scratch-999")).toBe(true);
  });

  it("does not flag ordinary repo paths as AI tasks", () => {
    const { isAiTask } = useAiTasks();
    expect(isAiTask("/repos/myrepo")).toBe(false);
  });
});
