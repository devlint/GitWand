import { describe, it, expect } from "vitest";
import { toTimeline } from "../useTimeMachine";
import type { SnapshotMeta } from "../../utils/backend";
import type { UndoEntry } from "../useUndoStack";

const snap = (id: string, ts: number, kind: SnapshotMeta["kind"] = "discard"): SnapshotMeta => ({
  id,
  commit: "a".repeat(40),
  kind,
  label: `snapshot ${id}`,
  timestampMs: ts,
  headSha: "b".repeat(40),
  headRef: "main",
  mergeHead: null,
});

const reflog = (hash: string, ts: number, type: UndoEntry["type"] = "commit"): UndoEntry => ({
  index: 0,
  hash,
  prevHash: "c".repeat(7),
  type,
  summary: `reflog ${hash}`,
  raw: "commit: x",
  date: "2 hours ago",
  timestampMs: ts,
});

describe("toTimeline", () => {
  it("merges both sources newest first", () => {
    const items = toTimeline([snap("s1", 3000), snap("s2", 1000)], [reflog("r1", 2000)]);
    expect(items.map((i) => i.key)).toEqual(["snapshot:s1", "reflog:r1", "snapshot:s2"]);
  });

  it("marks snapshots restorable and non-undoable reflog entries not", () => {
    // A "manual" snapshot supersedes nothing, so the checkout line survives.
    // (With a "discard" snapshot it would be deduped away — see below.)
    const items = toTimeline([snap("s1", 2000, "manual")], [reflog("r1", 1000, "checkout")]);
    expect(items[0].restorable).toBe(true);
    // "checkout" is not in useUndoStack's UNDOABLE set.
    expect(items[1].restorable).toBe(false);
  });

  it("marks a reflog entry with no parent as not restorable", () => {
    const orphan = { ...reflog("r1", 1000, "commit"), prevHash: "" };
    expect(toTimeline([], [orphan])[0].restorable).toBe(false);
  });

  it("hides reflog entries with no message", () => {
    // A bare `git update-ref` writes a reflog line with an empty subject.
    // GitWand labels its own now, but third-party tooling may not, and a row
    // with nothing in it tells the user nothing.
    const blank = { ...reflog("r1", 1000, "other"), summary: "", raw: "" };
    const items = toTimeline([], [blank, reflog("r2", 900)]);
    expect(items.map((i) => i.key)).toEqual(["reflog:r2"]);
  });

  it("hides pre-restore snapshots from the timeline", () => {
    const items = toTimeline([snap("s1", 2000, "pre-restore"), snap("s2", 1000)], []);
    expect(items.map((i) => i.key)).toEqual(["snapshot:s2"]);
  });

  it("drops the reflog entry a snapshot already covers, within 2s", () => {
    // A hard reset produces BOTH a snapshot (ours) and a reflog line (git's).
    // Showing both would read as two separate operations.
    const items = toTimeline([snap("s1", 10_000, "reset")], [reflog("r1", 9_000, "reset")]);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("snapshot");
  });

  it("maps a discard snapshot onto git's checkout reflog line", () => {
    // `git checkout -- <path>` is what a discard actually runs.
    const items = toTimeline([snap("s1", 10_000, "discard")], [reflog("r1", 9_500, "checkout")]);
    expect(items).toHaveLength(1);
  });

  it("keeps a reflog entry that falls outside the dedupe window", () => {
    const items = toTimeline([snap("s1", 10_000, "reset")], [reflog("r1", 3_000, "reset")]);
    expect(items).toHaveLength(2);
  });

  it("keeps git's own reflog order when two entries share a second", () => {
    // Found in manual QA: `git reflog` reports whole seconds, so two commits
    // made in the same second tie on timestamp. Falling back to an
    // alphabetical key put the OLDER commit first. The reflog index (0 =
    // most recent) is the only truth about their order.
    const newer = { ...reflog("b048e48", 1_787_587_442_000), index: 0 };
    const older = { ...reflog("709994f", 1_787_587_442_000), index: 1 };
    const items = toTimeline([], [newer, older]);
    expect(items.map((i) => i.key)).toEqual(["reflog:b048e48", "reflog:709994f"]);
  });

  it("keeps snapshot order when two share a millisecond", () => {
    const items = toTimeline([snap("100-bbbb", 5000, "manual"), snap("100-aaaa", 5000, "manual")], []);
    expect(items.map((i) => i.key)).toEqual(["snapshot:100-bbbb", "snapshot:100-aaaa"]);
  });

  it("puts the snapshot first when it ties with an unrelated reflog entry", () => {
    // Same instant, different operations: the snapshot restores strictly
    // more, so it reads first.
    const items = toTimeline([snap("s1", 7000, "manual")], [reflog("r1", 7000, "commit")]);
    expect(items.map((i) => i.source)).toEqual(["snapshot", "reflog"]);
  });

  it("keeps an unrelated reflog entry of a different type at the same instant", () => {
    const items = toTimeline([snap("s1", 10_000, "reset")], [reflog("r1", 10_000, "commit")]);
    expect(items).toHaveLength(2);
  });
});
