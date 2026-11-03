import { describe, it, expect } from "vitest";
import { ref } from "vue";
import type { FileLogEntry, GitDiff } from "../../utils/backend";
import { useFileCompare, type FileDiffLoader } from "../useFileCompare";

const e = (hashFull: string, path?: string): FileLogEntry => ({
  ...(path !== undefined ? { path } : {}),
  hashFull,
  hash: hashFull.slice(0, 7),
  author: "A",
  date: "2024-01-01T00:00:00Z",
  message: hashFull,
  body: "",
});

const okDiff = (path: string): GitDiff => ({ path, hunks: [] });

/** A loader that records its calls and resolves when told to. */
function controlledLoader() {
  const calls: Parameters<FileDiffLoader>[] = [];
  const pending: { resolve: (d: GitDiff) => void; reject: (e: Error) => void }[] = [];
  const getDiff: FileDiffLoader = (...args) => {
    calls.push(args);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { calls, pending, getDiff };
}

function setup(history: FileLogEntry[], extra: (FileLogEntry[] | null)[] = []) {
  const loader = controlledLoader();
  const filePath = ref("new.txt");
  const c = useFileCompare({
    cwd: ref("/repo"),
    filePath,
    history: ref(history),
    extra: ref(extra),
    getDiff: loader.getDiff,
  });
  return { c, loader, filePath };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("useFileCompare", () => {
  it("passes each side's name from the history", async () => {
    const { c, loader } = setup([e("b", "new.txt"), e("a", "old.txt")]);
    c.select("a");
    c.select("b");
    expect(loader.calls[0]).toEqual(["/repo", "new.txt", "a", "b", "old.txt", "new.txt"]);
    loader.pending[0]!.resolve(okDiff("new.txt"));
    await tick();
    expect(c.diff.value?.path).toBe("new.txt");
    expect(c.error.value).toBeNull();
    expect(c.nameUnknown.value).toBe(false);
  });

  it("keeps a failure in its own error, cleared by the next selection", async () => {
    const { c, loader } = setup([e("b", "new.txt"), e("a", "new.txt")]);
    c.select("a");
    c.select("b");
    loader.pending[0]!.reject(new Error("new.txt not found at either commit"));
    await tick();
    expect(c.error.value).toBe("new.txt not found at either commit");
    expect(c.loading.value).toBe(false);
    c.select("a"); // third click starts over
    expect(c.error.value).toBeNull();
    expect(c.to.value).toBeNull();
  });

  it("sends no side name for a commit beyond the loaded history, and says so", async () => {
    const { c, loader } = setup([e("b", "new.txt")], [[e("ancient")]]);
    c.select("ancient");
    c.select("b");
    expect(loader.calls[0]![4]).toBeUndefined();
    expect(c.nameUnknown.value).toBe(true);
  });

  it("reset clears the selection and drops a reply still in flight", async () => {
    const { c, loader } = setup([e("b", "new.txt"), e("a", "new.txt")]);
    c.select("a");
    c.select("b");
    c.reset();
    loader.pending[0]!.resolve(okDiff("stale"));
    await tick();
    expect(c.from.value).toBeNull();
    expect(c.to.value).toBeNull();
    expect(c.diff.value).toBeNull();
    expect(c.loading.value).toBe(false);
  });
});
