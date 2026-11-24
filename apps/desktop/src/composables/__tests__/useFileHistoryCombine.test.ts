import { describe, it, expect } from "vitest";
import { computed, effectScope, nextTick, ref } from "vue";
import type { FileLineageEntry, FileLogEntry } from "../../utils/backend";
import type { CombinedRequest } from "../useCombinedDiff";
import { useCommitSelection, hasSelectionState } from "../useCommitSelection";
import { useFileHistoryCombine } from "../useFileHistoryCombine";

const e = (hashFull: string, path?: string): FileLogEntry => ({
  ...(path !== undefined ? { path } : {}),
  hashFull,
  hash: hashFull.slice(0, 7),
  author: "A",
  date: "2024-01-01T00:00:00Z",
  message: hashFull,
  body: "",
});

let n = 0;
function setup(loadLineage: (cwd: string, path: string) => Promise<FileLineageEntry[]>) {
  const cwd = ref(`/repo-combine-${n++}`);
  const filePath = ref("b.txt");
  const key = computed(() => `${cwd.value}::file:${filePath.value}`);
  const displayedLog = ref<FileLogEntry[]>([e("c3", "b.txt"), e("c2", "b.txt"), e("c1", "a.txt")]);
  const opened: CombinedRequest[] = [];
  const scope = effectScope();
  const { selection, combine } = scope.run(() => {
    const selection = useCommitSelection(key);
    const combine = useFileHistoryCombine({
      cwd, filePath, selectionKey: key, selection, displayedLog, loadLineage, onOpen: (r) => opened.push(r),
    });
    return { selection, combine };
  })!;
  return { cwd, filePath, key, selection, combine, opened, scope };
}

const fullLog: FileLineageEntry[] = [
  { hash: "c3", path: "b.txt" },
  { hash: "c2", path: "b.txt" },
  { hash: "c1", path: "a.txt" },
  { hash: "c0", path: "a.txt" },
];

function pendingLoad() {
  let resolve!: (v: FileLineageEntry[]) => void;
  const load = () => new Promise<FileLineageEntry[]>((r) => (resolve = r));
  return { load, resolve: (v: FileLineageEntry[]) => resolve(v) };
}

describe("useFileHistoryCombine", () => {
  it("opens with the lineage's names and clears the selection", async () => {
    const t = setup(async () => fullLog);
    t.selection.toggle("c3", null);
    t.selection.toggle("c1", null);
    await t.combine.open();
    expect(t.opened).toEqual([{ hashes: ["c3", "c1"], paths: ["b.txt", "a.txt"] }]);
    expect(hasSelectionState(t.key.value)).toBe(false);
    expect(t.combine.busy.value).toBe(false);
    t.scope.stop();
  });

  it("drops a reply for a file the viewer no longer shows", async () => {
    const p = pendingLoad();
    const t = setup(p.load);
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    const pending = t.combine.open();
    t.filePath.value = "other.txt";
    p.resolve(fullLog);
    await pending;
    expect(t.opened).toEqual([]);
    t.scope.stop();
  });

  it("forgets the previous file's selection when the viewer shows another file", async () => {
    const t = setup(async () => fullLog);
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    const oldKey = t.key.value;
    t.filePath.value = "other.txt";
    await nextTick();
    expect(hasSelectionState(oldKey)).toBe(false);
    t.filePath.value = "b.txt";
    await nextTick();
    expect(t.selection.selected.value).toEqual([]);
    t.scope.stop();
  });

  it("a selection changed during the load opens as it is now, and stays", async () => {
    const p = pendingLoad();
    const t = setup(p.load);
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    const pending = t.combine.open();
    t.selection.toggle("c1", null);
    p.resolve(fullLog);
    await pending;
    expect(t.opened).toEqual([{ hashes: ["c3", "c2", "c1"], paths: ["b.txt", "a.txt"] }]);
    expect(t.selection.selected.value).toEqual(["c3", "c2", "c1"]);
    t.scope.stop();
  });

  it("a selection that fell below two during the load opens nothing", async () => {
    const p = pendingLoad();
    const t = setup(p.load);
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    const pending = t.combine.open();
    t.selection.toggle("c2", null);
    p.resolve(fullLog);
    await pending;
    expect(t.opened).toEqual([]);
    expect(t.selection.selected.value).toEqual(["c3"]);
    expect(t.combine.busy.value).toBe(false);
    t.scope.stop();
  });

  it("keeps an error for the current file only", async () => {
    const t = setup(async () => {
      throw new Error("boom");
    });
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    await t.combine.open();
    expect(t.combine.error.value).toBe("boom");
    expect(hasSelectionState(t.key.value)).toBe(true);
    t.filePath.value = "other.txt";
    await Promise.resolve();
    expect(t.combine.error.value).toBe(null);
    t.scope.stop();
  });

  it("shows the lineage's errors in the user's language (English by default)", async () => {
    const t = setup(async () => {
      throw "File history too long: more than 200000 commits.";
    });
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    await t.combine.open();
    expect(t.combine.error.value).toBe("File history too long: more than 200000 commits."); // combined.errHistoryTooLong (en)
    const u = setup(async () => {
      throw new Error("Combined diffs do not support the file name: a/./b");
    });
    u.selection.toggle("c3", null);
    u.selection.toggle("c2", null);
    await u.combine.open();
    expect(u.combine.error.value).toBe("Unsupported file name: a/./b");
    t.scope.stop();
    u.scope.stop();
  });

  it("forgets the selection when the viewer goes", () => {
    const t = setup(async () => fullLog);
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    expect(hasSelectionState(t.key.value)).toBe(true);
    t.scope.stop();
    expect(hasSelectionState(t.key.value)).toBe(false);
  });
});
