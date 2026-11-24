import { describe, it, expect } from "vitest";
import { computed, effectScope, ref } from "vue";
import type { FileLogEntry } from "../../utils/backend";
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
function setup(loadFullLog: (cwd: string, path: string) => Promise<FileLogEntry[]>) {
  const cwd = ref(`/repo-combine-${n++}`);
  const filePath = ref("b.txt");
  const key = computed(() => `${cwd.value}::file:${filePath.value}`);
  const displayedLog = ref<FileLogEntry[]>([e("c3", "b.txt"), e("c2", "b.txt"), e("c1", "a.txt")]);
  const opened: CombinedRequest[] = [];
  const scope = effectScope();
  const { selection, combine } = scope.run(() => {
    const selection = useCommitSelection(key);
    const combine = useFileHistoryCombine({
      cwd, filePath, selection, displayedLog, loadFullLog, onOpen: (r) => opened.push(r),
    });
    return { selection, combine };
  })!;
  return { cwd, filePath, key, selection, combine, opened, scope };
}

const fullLog = [e("c3", "b.txt"), e("c2", "b.txt"), e("c1", "a.txt"), e("c0", "a.txt")];

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
    let resolve!: (v: FileLogEntry[]) => void;
    const t = setup(() => new Promise((r) => (resolve = r)));
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    const pending = t.combine.open();
    const oldKey = t.key.value;
    t.filePath.value = "other.txt";
    resolve(fullLog);
    await pending;
    expect(t.opened).toEqual([]);
    expect(hasSelectionState(oldKey)).toBe(true);
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

  it("forgets the selection when the viewer goes", () => {
    const t = setup(async () => fullLog);
    t.selection.toggle("c3", null);
    t.selection.toggle("c2", null);
    expect(hasSelectionState(t.key.value)).toBe(true);
    t.scope.stop();
    expect(hasSelectionState(t.key.value)).toBe(false);
  });
});
