/**
 * v3.10.0 moved the resolution engine into a Web Worker, so `core.resolve` is
 * an async RPC and every resolution helper now has an await between reading a
 * file's content and writing the result back. These tests pin the three
 * behaviours that window requires:
 *
 *  1. a result whose file left the list is dropped, not written to a dead slot
 *  2. overlapping resolutions are serialized instead of losing one
 *  3. a hunk index that the queue made stale is refused, not misapplied
 *
 * The engine is mocked with a *gated* facade that delegates to the real
 * `@gitwand/core` resolver: the resolution logic stays real, only its timing
 * is under the test's control.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { gate, releaseAll, pendingCount, setHold } = vi.hoisted(() => {
  let hold = false;
  let waiters: Array<() => void> = [];
  return {
    gate: async () => {
      if (!hold) return;
      await new Promise<void>((r) => waiters.push(r));
    },
    releaseAll: () => {
      const current = waiters;
      waiters = [];
      for (const r of current) r();
    },
    pendingCount: () => waiters.length,
    setHold: (v: boolean) => { hold = v; },
  };
});

vi.mock("@/utils/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/backend")>();
  return {
    ...actual,
    pickFolder: vi.fn(),
    getConflictedFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(),
    readGitwandrc: vi.fn(async () => ""),
    getTreeConflicts: vi.fn(async () => []),
    resolveTreeConflict: vi.fn(),
    gitStage: vi.fn(),
  };
});

vi.mock("../../utils/coreEngine", () => ({
  engine: async () => {
    const core = await import("@gitwand/core");
    return {
      async resolve(content: string, filePath: string, options?: unknown) {
        await gate();
        return core.resolve(content, filePath, options as never);
      },
      async resolveAsync(content: string, filePath: string, options?: unknown) {
        await gate();
        return core.resolveAsync(content, filePath, options as never);
      },
      async parseConflictMarkers(content: string) {
        return core.parseConflictMarkers(content);
      },
    };
  },
}));

import { useGitWand, type ConflictFile } from "../useGitWand";
import { resolve as coreResolve } from "@gitwand/core";

/** Two independent conflicts, so a hunk index can be made stale. */
const TWO_HUNKS = [
  "head",
  "<<<<<<< ours",
  "ours1",
  "=======",
  "theirs1",
  ">>>>>>> theirs",
  "mid",
  "<<<<<<< ours",
  "ours2",
  "=======",
  "theirs2",
  ">>>>>>> theirs",
  "tail",
].join("\n");

/** Identical on both sides: the engine resolves this one on its own. */
const AUTO_RESOLVABLE = [
  "head",
  "<<<<<<< ours",
  "same",
  "=======",
  "same",
  ">>>>>>> theirs",
  "tail",
].join("\n");

function seed(path: string, content: string): ConflictFile {
  return { path, content, result: coreResolve(content, path) };
}

/** Wait until `n` resolve calls are parked on the gate. */
async function waitForPending(n: number) {
  await vi.waitFor(() => expect(pendingCount()).toBe(n));
}

beforeEach(() => {
  setHold(false);
  releaseAll();
});

describe("useGitWand — resolution races across the worker boundary", () => {
  it("never writes to a dead slot when the list is replaced mid-resolution", async () => {
    const gw = useGitWand();
    gw.files.value = [seed("a.txt", TWO_HUNKS)];

    // No gate here: the list is replaced during the *engine load* await, which
    // is what makes the pre-fix `indexOf` resolve to -1 and write a dead
    // `"-1"` property onto the live array — swallowing the resolution with no
    // error anywhere. What replaces the list in practice: a fresh
    // loadRealFiles(), a tree-conflict resolution, an undo.
    const inFlight = gw.resolveHunkCustom("a.txt", 0, "PICKED");
    const replacement = seed("b.txt", TWO_HUNKS);
    gw.files.value = [replacement];
    await inFlight;

    expect(gw.files.value).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(gw.files.value, "-1")).toBe(false);
    // `files` is a deep ref, so entries read back as reactive proxies —
    // compare on value, not identity.
    expect(gw.files.value[0].path).toBe("b.txt");
    expect(gw.files.value[0].content).toBe(replacement.content);
  });

  it("drops a resolution whose file left the list while the worker was busy", async () => {
    const gw = useGitWand();
    gw.files.value = [seed("a.txt", TWO_HUNKS)];

    setHold(true);
    const inFlight = gw.resolveHunkCustom("a.txt", 0, "PICKED");
    await waitForPending(1); // the job read a.txt and is awaiting the worker

    const replacement = seed("b.txt", TWO_HUNKS);
    gw.files.value = [replacement];
    releaseAll();
    await inFlight;

    // Guards `commitResolved`'s post-await lookup: the result belongs to a
    // file that is no longer listed, so it must be discarded rather than
    // applied to whatever now sits at that index.
    expect(gw.files.value).toHaveLength(1);
    expect(gw.files.value[0].path).toBe("b.txt");
    expect(gw.files.value[0].content).not.toContain("PICKED");
    expect(Object.prototype.hasOwnProperty.call(gw.files.value, "-1")).toBe(false);
  });

  it("serializes overlapping resolutions on different files, losing neither", async () => {
    const gw = useGitWand();
    gw.files.value = [seed("a.txt", TWO_HUNKS), seed("b.txt", TWO_HUNKS)];

    setHold(true);
    const first = gw.resolveHunkCustom("a.txt", 0, "FROM_A");
    const second = gw.resolveHunkCustom("b.txt", 0, "FROM_B");

    // One at a time: the second job must not read its file until the first
    // has written its result.
    await waitForPending(1);
    releaseAll();
    await waitForPending(1);
    releaseAll();
    await Promise.all([first, second]);

    const byPath = Object.fromEntries(gw.files.value.map((f) => [f.path, f.content]));
    expect(byPath["a.txt"]).toContain("FROM_A");
    expect(byPath["b.txt"]).toContain("FROM_B");
  });

  /**
   * `resolveAll` is N worker round trips long and used to end with a wholesale
   * `files.value = ...` reassignment, discarding anything that changed while
   * it ran. It now merges per slot, keyed on object identity, so an entry
   * replaced meanwhile keeps its newer value while the untouched ones still
   * get their resolution.
   */
  it("resolveAll applies its results without clobbering an entry replaced mid-batch", async () => {
    const gw = useGitWand();
    const a = seed("a.txt", AUTO_RESOLVABLE);
    const b = seed("b.txt", AUTO_RESOLVABLE);
    expect(a.result.stats.autoResolved).toBeGreaterThan(0); // fixture sanity
    gw.files.value = [a, b];

    setHold(true);
    const batch = gw.resolveAll();
    await waitForPending(2); // both files are out at the worker

    // Something outside the queue replaces b.txt: an undo, a redo, or a fresh
    // loadRealFiles landing while the batch is in flight.
    const replacedB = seed("b.txt", TWO_HUNKS);
    gw.files.value = [gw.files.value[0], replacedB];

    releaseAll();
    await batch;

    const byPath = Object.fromEntries(gw.files.value.map((f) => [f.path, f.content]));
    expect(byPath["a.txt"]).not.toContain("<<<<<<<"); // resolved by the batch
    expect(byPath["b.txt"]).toBe(replacedB.content); // newer value survived
  });

  it("refuses a hunk index the queue made stale rather than rewriting the wrong hunk", async () => {
    const gw = useGitWand();
    gw.files.value = [seed("a.txt", TWO_HUNKS)];

    setHold(true);
    // Both clicks are issued against the content on screen, which still shows
    // two hunks. Resolving hunk 0 renumbers hunk 1 to 0, so the second index
    // no longer means what the caller meant by it.
    const first = gw.resolveHunkCustom("a.txt", 0, "FIRST");
    const second = gw.resolveHunkCustom("a.txt", 1, "SECOND");

    await waitForPending(1);
    releaseAll();
    await Promise.all([first, second]);

    const content = gw.files.value[0].content;
    expect(content).toContain("FIRST");
    // The stale request is dropped, not applied to a shifted hunk…
    expect(content).not.toContain("SECOND");
    // …and the second hunk is left intact and still conflicted, so the user
    // can act on it again from the re-rendered state.
    expect(content).toContain("ours2");
    expect(content).toContain("theirs2");
    expect(content).toContain("<<<<<<< ours");
  });
});
