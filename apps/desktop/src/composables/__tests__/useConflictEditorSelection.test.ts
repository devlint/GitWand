/**
 * useConflictEditorSelection — whether the Changes view shows the merge
 * editor for the selected file. Loading a repo's conflicts is async, and
 * during that gap the view must not fall back to the plain diff, whose
 * "Stage this hunk" would stage raw conflict markers.
 */
import { describe, it, expect, afterEach } from "vitest";
import { effectScope, nextTick, ref, type EffectScope } from "vue";
import { useConflictEditorSelection } from "../useConflictEditorSelection";

/** A promise the test resolves by hand, to hold `openConflicts` mid-flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let scope: EffectScope | null = null;
afterEach(() => {
  scope?.stop();
  scope = null;
});

function setup() {
  const isConflicted = ref(false);
  const filePath = ref<string | null>(null);
  const repoPath = ref<string | null>("/repo");
  const loads: Array<ReturnType<typeof deferred>> = [];
  const selected: string[] = [];
  scope = effectScope();
  const sel = scope.run(() =>
    useConflictEditorSelection({
      isConflicted,
      filePath,
      repoPath,
      openConflicts: () => {
        const d = deferred();
        loads.push(d);
        return d.promise;
      },
      selectConflict: (p) => {
        selected.push(p);
      },
    }),
  )!;
  return { isConflicted, filePath, repoPath, loads, selected, sel };
}

/** Let the watcher's continuation after `await openConflicts()` run. */
async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("useConflictEditorSelection", () => {
  it("is pending, not showing, while a conflicted file's conflicts load", async () => {
    const { isConflicted, filePath, loads, selected, sel } = setup();
    filePath.value = "docs/guide.md";
    isConflicted.value = true;
    await nextTick();

    expect(sel.pending.value).toBe(true);
    expect(sel.showing.value).toBe(false);
    expect(selected).toEqual([]);

    loads[0].resolve();
    await flush();
    expect(sel.pending.value).toBe(false);
    expect(sel.showing.value).toBe(true);
    expect(selected).toEqual(["docs/guide.md"]);
  });

  it("is neither pending nor showing for a file that is not conflicted", async () => {
    const { isConflicted, filePath, loads, sel } = setup();
    filePath.value = "src/a.ts";
    isConflicted.value = false;
    await nextTick();
    expect(loads).toHaveLength(0);
    expect(sel.pending.value).toBe(false);
    expect(sel.showing.value).toBe(false);
  });

  it("drops a load that finishes after the selection moved to a clean file", async () => {
    const { isConflicted, filePath, loads, selected, sel } = setup();
    filePath.value = "docs/guide.md";
    isConflicted.value = true;
    await nextTick();

    // The user moves on before the conflicts finish loading.
    filePath.value = "src/a.ts";
    isConflicted.value = false;
    await nextTick();
    expect(sel.pending.value).toBe(false);

    loads[0].resolve();
    await flush();
    expect(sel.showing.value).toBe(false);
    expect(sel.pending.value).toBe(false);
    expect(selected).toEqual([]);
  });

  it("only the latest of two conflicted selections wins", async () => {
    const { isConflicted, filePath, loads, selected, sel } = setup();
    isConflicted.value = true;
    filePath.value = "a.md";
    await nextTick();
    filePath.value = "b.md";
    await nextTick();

    loads[1].resolve();
    await flush();
    loads[0].resolve();
    await flush();
    expect(selected).toEqual(["b.md"]);
    expect(sel.showing.value).toBe(true);
    expect(sel.pending.value).toBe(false);
  });

  it("stops pending when loading fails, so the view can fall back", async () => {
    const isConflicted = ref(false);
    const filePath = ref<string | null>(null);
    scope = effectScope();
    const sel = scope.run(() =>
      useConflictEditorSelection({
        isConflicted,
        filePath,
        repoPath: ref("/repo"),
        openConflicts: () => Promise.reject(new Error("boom")),
        selectConflict: () => {},
      }),
    )!;
    filePath.value = "docs/guide.md";
    isConflicted.value = true;
    await flush();
    expect(sel.pending.value).toBe(false);
    expect(sel.showing.value).toBe(false);
  });
});
