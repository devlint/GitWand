import { describe, it, expect } from "vitest";
import { resolvePrReviewShortcut, isEditableTarget } from "../usePrReviewKeymap";

function kd(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...opts });
}

describe("resolvePrReviewShortcut", () => {
  const focused = { focused: true };

  it("maps each plain letter to its action", () => {
    expect(resolvePrReviewShortcut(kd("j"), focused)).toBe("next-hunk");
    expect(resolvePrReviewShortcut(kd("k"), focused)).toBe("prev-hunk");
    expect(resolvePrReviewShortcut(kd("v"), focused)).toBe("toggle-viewed");
    expect(resolvePrReviewShortcut(kd("t"), focused)).toBe("filter-files");
    expect(resolvePrReviewShortcut(kd("c"), focused)).toBe("comment-hunk");
    expect(resolvePrReviewShortcut(kd("?"), focused)).toBe("help");
    expect(resolvePrReviewShortcut(kd("n"), focused)).toBe("next-finding");
    expect(resolvePrReviewShortcut(kd("p"), focused)).toBe("prev-finding");
  });

  it("maps the Shift variants to file/hide-viewed actions", () => {
    expect(resolvePrReviewShortcut(kd("J"), focused)).toBe("next-file");
    expect(resolvePrReviewShortcut(kd("K"), focused)).toBe("prev-file");
    expect(resolvePrReviewShortcut(kd("V"), focused)).toBe("toggle-hide-viewed");
  });

  it("maps ⌘Enter and Ctrl+Enter to submit-review", () => {
    expect(resolvePrReviewShortcut(kd("Enter", { metaKey: true }), focused)).toBe("submit-review");
    expect(resolvePrReviewShortcut(kd("Enter", { ctrlKey: true }), focused)).toBe("submit-review");
  });

  it("returns null when unfocused, regardless of key", () => {
    expect(resolvePrReviewShortcut(kd("j"), { focused: false })).toBeNull();
    expect(resolvePrReviewShortcut(kd("Enter", { metaKey: true }), { focused: false })).toBeNull();
  });

  it("returns null for unmapped keys", () => {
    expect(resolvePrReviewShortcut(kd("x"), focused)).toBeNull();
    expect(resolvePrReviewShortcut(kd("Escape"), focused)).toBeNull();
    expect(resolvePrReviewShortcut(kd("l", { metaKey: true, shiftKey: true }), focused)).toBeNull();
  });

  it("treats an unrelated modifier as noise, not a shortcut", () => {
    expect(resolvePrReviewShortcut(kd("j", { ctrlKey: true }), focused)).toBeNull();
    expect(resolvePrReviewShortcut(kd("v", { altKey: true }), focused)).toBeNull();
    expect(resolvePrReviewShortcut(kd("j", { metaKey: true }), focused)).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("is true for input/textarea/select", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
  });

  it("is true for a contenteditable element", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.appendChild(div);
    expect(isEditableTarget(div)).toBe(true);
    div.remove();
  });

  it("is false for a plain div/null", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
