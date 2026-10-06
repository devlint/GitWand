import { describe, it, expect } from "vitest";
import { keyToSequence, type KeyEventLike } from "../keys";

function k(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}
const linux = { appCursor: false, isMac: false };
const mac = { appCursor: false, isMac: true };

describe("keyToSequence", () => {
  it("printable keys pass through", () => {
    expect(keyToSequence(k("a"), linux)).toBe("a");
    expect(keyToSequence(k("É", { shiftKey: true }), linux)).toBe("É");
  });

  it("control keys", () => {
    expect(keyToSequence(k("Enter"), linux)).toBe("\r");
    expect(keyToSequence(k("Backspace"), linux)).toBe("\x7f");
    expect(keyToSequence(k("Tab"), linux)).toBe("\t");
    expect(keyToSequence(k("Tab", { shiftKey: true }), linux)).toBe("\x1b[Z");
    expect(keyToSequence(k("Escape"), linux)).toBe("\x1b");
  });

  it("Ctrl+letter and Ctrl+symbol", () => {
    expect(keyToSequence(k("c", { ctrlKey: true }), linux)).toBe("\x03");
    expect(keyToSequence(k("C", { ctrlKey: true, shiftKey: true }), linux)).toBe("\x03");
    expect(keyToSequence(k(" ", { ctrlKey: true }), linux)).toBe("\x00");
    expect(keyToSequence(k("[", { ctrlKey: true }), linux)).toBe("\x1b");
    expect(keyToSequence(k("/", { ctrlKey: true }), linux)).toBe("\x1f");
  });

  it("Ctrl+letter on a non-Latin layout uses the physical key", () => {
    expect(keyToSequence(k("с", { ctrlKey: true, code: "KeyC" }), linux)).toBe("\x03");
  });

  it("arrows honour application cursor mode and modifiers", () => {
    expect(keyToSequence(k("ArrowUp"), linux)).toBe("\x1b[A");
    expect(keyToSequence(k("ArrowUp"), { ...linux, appCursor: true })).toBe("\x1bOA");
    expect(keyToSequence(k("ArrowLeft", { ctrlKey: true }), linux)).toBe("\x1b[1;5D");
    expect(keyToSequence(k("ArrowRight", { shiftKey: true }), linux)).toBe("\x1b[1;2C");
  });

  it("function / editing keys", () => {
    expect(keyToSequence(k("Delete"), linux)).toBe("\x1b[3~");
    expect(keyToSequence(k("PageUp"), linux)).toBe("\x1b[5~");
    expect(keyToSequence(k("F1"), linux)).toBe("\x1bOP");
    expect(keyToSequence(k("F5"), linux)).toBe("\x1b[15~");
    expect(keyToSequence(k("F12", { shiftKey: true }), linux)).toBe("\x1b[24;2~");
  });

  it("Alt prefixes ESC off macOS, composes on macOS", () => {
    expect(keyToSequence(k("b", { altKey: true }), linux)).toBe("\x1bb");
    expect(keyToSequence(k("∫", { altKey: true }), mac)).toBe("∫");
    expect(keyToSequence(k("Backspace", { altKey: true }), linux)).toBe("\x1b\x7f");
  });

  it("Shift+Enter is a newline only for AI CLI tabs", () => {
    expect(keyToSequence(k("Enter", { shiftKey: true }), linux)).toBe("\r");
    expect(keyToSequence(k("Enter", { shiftKey: true }), { ...linux, shiftEnterNewline: true })).toBe("\x1b\r");
    expect(keyToSequence(k("Enter", { altKey: true }), linux)).toBe("\x1b\r");
  });

  it("ignores Cmd chords, bare modifiers and IME composition", () => {
    expect(keyToSequence(k("c", { metaKey: true }), mac)).toBeNull();
    expect(keyToSequence(k("Shift", { shiftKey: true }), linux)).toBeNull();
    expect(keyToSequence(k("Dead"), linux)).toBeNull();
    expect(keyToSequence(k("a", { isComposing: true }), linux)).toBeNull();
    expect(keyToSequence(k("Process", { keyCode: 229 }), linux)).toBeNull();
  });
});
