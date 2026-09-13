/**
 * v3.11.0 — looking up a pending split by bare hash (#128 follow-up).
 *
 * `split` is a GitWand-only action: the rebase todo serializes it as `edit`,
 * and this module remembers which commits were marked, so the UI can offer
 * "Split this commit…" when the rebase halts on one.
 *
 * Two callers need that lookup and they hold different things.
 * `RebaseEditor` has a `RebaseProgress`. The app shell that keeps the rebase
 * banner alive after the editor unmounts only has
 * `RepoOperationState.operationHead`, which the Rust backend reads from
 * `.git/REBASE_HEAD`. `getPendingSplitForHash` is the shared core and
 * `getPendingSplitAtHead` delegates to it, so the prefix-matching rule cannot
 * drift between the two surfaces.
 *
 * Why a bare hash is the right key, verified against real git rather than
 * assumed: at an `edit` stop `REBASE_HEAD` is the ORIGINAL pre-rebase commit,
 * while `HEAD` is the rewritten one. `pendingSplits` is keyed by the original,
 * so `operationHead` matches it directly. (That same probe is why B4 gates on
 * `!hasConflict`: at a conflict stop `HEAD` is the *parent*, the commit has
 * not been created yet, and splitting there would split the wrong commit.)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.mock` is hoisted above the file's top-level bindings, so the spy has to
// be created inside the factory and pulled back out afterwards.
vi.mock("../../utils/backend", () => ({
  gitExec: vi.fn(async () => ""),
  // `conflict: true` models a rebase that HALTED, which is the only state
  // these tests are about. A completed rebase correctly calls
  // `clearPendingSplits()`, so seeding through that path would wipe the set.
  gitInteractiveRebase: vi.fn(async () => ({ conflict: true })),
}));

import * as backend from "../../utils/backend";
const gitInteractiveRebase = backend.gitInteractiveRebase as unknown as ReturnType<typeof vi.fn>;

import {
  useInteractiveRebase,
  getPendingSplitAtHead,
  getPendingSplitForHash,
  resolvePendingSplit,
  clearPendingSplits,
} from "../useInteractiveRebase";

const FULL = "abcdef1234567890abcdef1234567890abcdef12";
const SHORT = "abcdef1";
const OTHER_FULL = "9999998888887777666655554444333322221111";
const OTHER_SHORT = "9999998";

/**
 * Populate `pendingSplits` through the real code path rather than a test-only
 * back door: mark an entry `split` and start the rebase.
 */
async function seedPendingSplit() {
  const rebase = useInteractiveRebase();
  await rebase.startRebase("/repo", "HEAD~2", [
    { action: "split", hash: SHORT, fullHash: FULL, message: "the commit to split" },
    { action: "pick", hash: OTHER_SHORT, fullHash: OTHER_FULL, message: "untouched" },
  ] as never);
}

beforeEach(async () => {
  clearPendingSplits();
  gitInteractiveRebase.mockClear();
  await seedPendingSplit();
});

describe("getPendingSplitForHash", () => {
  it("matches the truncated hash git reports", () => {
    // `currentHash` / `operationHead` are commonly 7 chars.
    expect(getPendingSplitForHash(SHORT)?.fullHash).toBe(FULL);
  });

  it("matches the full hash", () => {
    expect(getPendingSplitForHash(FULL)?.fullHash).toBe(FULL);
  });

  it("matches any prefix length git might hand us", () => {
    for (const n of [4, 8, 12, 40]) {
      expect(getPendingSplitForHash(FULL.slice(0, n))?.fullHash, `prefix of ${n}`).toBe(FULL);
    }
  });

  it("returns null for a commit that was not marked for splitting", () => {
    expect(getPendingSplitForHash(OTHER_SHORT)).toBeNull();
  });

  it("returns null for null, so callers can pass an absent head straight through", () => {
    expect(getPendingSplitForHash(null)).toBeNull();
  });

  it("returns null for the empty string rather than matching everything", () => {
    // `"abc".startsWith("")` is true, so an unguarded prefix match would return
    // the first pending split for *any* halt. That would offer to split a
    // commit the user never marked.
    expect(getPendingSplitForHash("")).toBeNull();
  });
});

describe("getPendingSplitAtHead delegates without changing behaviour", () => {
  const progress = (over: Record<string, unknown> = {}) =>
    ({ inProgress: true, currentHash: SHORT, ...over }) as never;

  it("finds the split at a halted rebase", () => {
    expect(getPendingSplitAtHead(progress())?.fullHash).toBe(FULL);
  });

  it("returns null when no rebase is in progress", () => {
    expect(getPendingSplitAtHead(progress({ inProgress: false }))).toBeNull();
  });

  it("returns null for a null progress", () => {
    expect(getPendingSplitAtHead(null)).toBeNull();
  });

  it("returns null when the halt carries no hash", () => {
    expect(getPendingSplitAtHead(progress({ currentHash: undefined }))).toBeNull();
  });

  it("agrees with the bare-hash lookup on the same input", () => {
    expect(getPendingSplitAtHead(progress())).toBe(getPendingSplitForHash(SHORT));
  });
});

describe("lifecycle", () => {
  it("resolvePendingSplit removes only that commit", async () => {
    resolvePendingSplit(FULL);
    expect(getPendingSplitForHash(SHORT)).toBeNull();
  });

  it("clearPendingSplits empties the set", () => {
    clearPendingSplits();
    expect(getPendingSplitForHash(SHORT)).toBeNull();
  });

  it("a rebase with no split marks leaves nothing pending", async () => {
    clearPendingSplits();
    const rebase = useInteractiveRebase();
    await rebase.startRebase("/repo", "HEAD~1", [
      { action: "pick", hash: SHORT, fullHash: FULL, message: "just a pick" },
    ] as never);
    expect(getPendingSplitForHash(SHORT)).toBeNull();
  });

  it("a rebase that runs to completion clears what was pending", async () => {
    // Not incidental: if the set survived a finished rebase, the next halt on
    // an unrelated commit could offer to split a commit from a previous run.
    (backend.gitInteractiveRebase as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ conflict: false });
    const rebase = useInteractiveRebase();
    await rebase.startRebase("/repo", "HEAD~2", [
      { action: "split", hash: SHORT, fullHash: FULL, message: "split me" },
    ] as never);
    expect(getPendingSplitForHash(SHORT)).toBeNull();
  });

  it("serializes split as edit, since git's sequencer has no split verb", async () => {
    const todo = gitInteractiveRebase.mock.calls[gitInteractiveRebase.mock.calls.length - 1]?.[2] as unknown as string[];
    expect(todo.some((l) => l.startsWith(`edit ${SHORT}`))).toBe(true);
    // The VERB, not the whole line: this fixture's commit message legitimately
    // contains the word "split".
    expect(todo.some((l) => l.split(" ")[0] === "split")).toBe(false);
  });
});
