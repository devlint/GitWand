// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isEditableTarget } from "../editableTarget";

describe("isEditableTarget — the one 'is the user typing here' rule", () => {
  it("covers fields and contenteditable", () => {
    for (const tag of ["input", "textarea", "select"]) expect(isEditableTarget(document.createElement(tag))).toBe(true);
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isEditableTarget(div)).toBe(true);
  });

  it("covers the terminal (keys go to the shell)", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const inner = document.createElement("textarea-not");
    term.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it("is false elsewhere and for non-elements", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
