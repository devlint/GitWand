import { describe, it, expect } from "vitest";
import { ref } from "vue";
import type { FileLogEntry } from "../../utils/backend";
import { useFileHistoryLists, type FileHistoryLoaders } from "../useFileHistoryLists";

const e = (hashFull: string, path?: string): FileLogEntry => ({
  ...(path !== undefined ? { path } : {}),
  hashFull,
  hash: hashFull.slice(0, 7),
  author: "A",
  date: "2024-01-01T00:00:00Z",
  message: hashFull,
  body: "",
});

type Deferred = { resolve: (v: FileLogEntry[]) => void; reject: (e: Error) => void };

function setup() {
  const pending: Deferred[] = [];
  const next = () => new Promise<FileLogEntry[]>((resolve, reject) => pending.push({ resolve, reject }));
  const loaders: FileHistoryLoaders = { getPickaxe: next, getRange: next };
  const filePath = ref("a.txt");
  const lists = useFileHistoryLists({ cwd: ref("/repo"), filePath, loaders });
  lists.startFile();
  return { lists, pending, filePath };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("useFileHistoryLists", () => {
  it("writes a reply for the current file", async () => {
    const { lists, pending } = setup();
    void lists.runPickaxe("needle", "S");
    expect(lists.pickaxeLoading.value).toBe(true);
    pending[0]!.resolve([e("p", "a.txt")]);
    await tick();
    expect(lists.pickaxeResults.value?.map((x) => x.hashFull)).toEqual(["p"]);
    expect(lists.pickaxeLoading.value).toBe(false);
  });

  it("drops pickaxe and range replies that land after a file change", async () => {
    const { lists, pending, filePath } = setup();
    void lists.runPickaxe("needle", "S");
    void lists.showRangeHistory(1, 3);
    filePath.value = "b.txt";
    lists.startFile();
    // The new file starts clean, nothing stuck loading.
    expect(lists.rangeLogLoading.value).toBe(false);
    expect(lists.pickaxeLoading.value).toBe(false);
    expect(lists.rangeLogLines.value).toBeNull();
    pending[0]!.resolve([e("old-pickaxe", "a.txt")]);
    pending[1]!.reject(new Error("old range failure"));
    await tick();
    expect(lists.pickaxeResults.value).toBeNull();
    expect(lists.rangeLogResults.value).toBeNull();
    expect(lists.rangeLogError.value).toBeNull();
    expect(lists.rangeLogLoading.value).toBe(false);
  });

  it("clears the previous file's log, so it cannot name the new file's commits", () => {
    const { lists } = setup();
    lists.fileLog.value = [e("x", "a.txt")];
    const before = lists.token();
    const after = lists.startFile();
    expect(lists.fileLog.value).toEqual([]);
    expect(lists.isCurrent(before)).toBe(false);
    expect(lists.isCurrent(after)).toBe(true);
  });
});
