/**
 * Task 2 (v3.7.0) — pure keymap resolver for Commit Review finding
 * navigation. Mirrors `usePrReviewKeymap.test.ts`'s structure.
 */
import { describe, it, expect } from "vitest";
import { resolveCommitReviewShortcut } from "../commitReviewKeymap";

function kd(key: string, opts: Partial<KeyboardEventInit> = {}, target?: EventTarget): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, ...opts });
  if (target) Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("resolveCommitReviewShortcut", () => {
  const active = { active: true };

  it("maps n/p/x/? to their actions", () => {
    expect(resolveCommitReviewShortcut(kd("n"), active)).toBe("next-finding");
    expect(resolveCommitReviewShortcut(kd("p"), active)).toBe("prev-finding");
    expect(resolveCommitReviewShortcut(kd("x"), active)).toBe("dismiss-finding");
    expect(resolveCommitReviewShortcut(kd("?"), active)).toBe("help");
  });

  it("returns null for every mapped key when inactive", () => {
    const inactive = { active: false };
    expect(resolveCommitReviewShortcut(kd("n"), inactive)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("p"), inactive)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("x"), inactive)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("?"), inactive)).toBeNull();
  });

  it("returns null for INPUT/TEXTAREA/contenteditable targets — bare letters must be inert while typing", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(resolveCommitReviewShortcut(kd("n", {}, input), active)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("p", {}, textarea), active)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("x", {}, div), active)).toBeNull();
  });

  it("returns null when any modifier is held", () => {
    expect(resolveCommitReviewShortcut(kd("n", { metaKey: true }), active)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("n", { ctrlKey: true }), active)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("n", { altKey: true }), active)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("n", { shiftKey: true }), active)).toBeNull();
  });

  it("never maps Escape or ⌘⇧L — those stay owned by App.vue's global handlers", () => {
    expect(resolveCommitReviewShortcut(kd("Escape"), active)).toBeNull();
    expect(resolveCommitReviewShortcut(kd("l", { metaKey: true, shiftKey: true }), active)).toBeNull();
  });

  it("returns null for unmapped keys", () => {
    expect(resolveCommitReviewShortcut(kd("z"), active)).toBeNull();
  });
});
