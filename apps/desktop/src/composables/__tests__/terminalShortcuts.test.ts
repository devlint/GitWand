import { describe, it, expect } from "vitest";
import { resolveTerminalShortcut } from "../useTerminalSessions";

function key(k: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: k, metaKey: true, ctrlKey: false, shiftKey: false, ...opts } as KeyboardEvent;
}

describe("resolveTerminalShortcut", () => {
  it("ne fait rien si le terminal n'a pas le focus", () => {
    expect(resolveTerminalShortcut(key("t"), false)).toBeNull();
  });
  it("Cmd+T => new quand focus terminal", () => {
    expect(resolveTerminalShortcut(key("t"), true)).toBe("new");
  });
  it("Cmd+W => close quand focus terminal", () => {
    expect(resolveTerminalShortcut(key("w"), true)).toBe("close");
  });
  it("Cmd+3 => switch index 2 quand focus terminal", () => {
    expect(resolveTerminalShortcut(key("3"), true)).toEqual({ switch: 2 });
  });
  it("ignore les touches non gérées", () => {
    expect(resolveTerminalShortcut(key("q"), true)).toBeNull();
  });
});
