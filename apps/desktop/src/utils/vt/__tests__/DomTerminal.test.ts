// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DomTerminal } from "../DomTerminal";

// jsdom has no layout: give every element a fixed box so fit() sees a 10×3
// grid of 8×16 cells, and run animation frames on demand.
let frames: FrameRequestCallback[] = [];
function flush() {
  const run = frames;
  frames = [];
  for (const f of run) f(0);
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(48);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 8 * 64, height: 16, left: 0, top: 0, right: 8 * 64, bottom: 16, x: 0, y: 0, toJSON() {},
  } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function setup(opts: ConstructorParameters<typeof DomTerminal>[0] = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new DomTerminal(opts);
  const sent: string[] = [];
  term.onData((d) => sent.push(d));
  term.open(host);
  const rows = () => [...host.querySelectorAll<HTMLElement>(".gw-vt-row")];
  const input = host.querySelector("textarea")!;
  return { term, host, sent, rows, input };
}

function key(input: HTMLElement, k: string, mods: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  input.dispatchEvent(e);
  return e;
}

describe("DomTerminal", () => {
  it("fits the grid to the host", () => {
    const { term, rows } = setup();
    expect([term.cols, term.rows]).toEqual([10, 3]);
    expect(rows()).toHaveLength(3);
  });

  it("renders escaped text and colours, one frame per batch of writes", () => {
    const { term, rows } = setup();
    term.write("<b>&");
    term.write("\x1b[31mR");
    expect(frames).toHaveLength(1);
    flush();
    const html = rows()[0].innerHTML;
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).toContain("color:#cc0000");
    expect(rows()[0].textContent).toBe("<b>&R" + " ".repeat(5));
  });

  it("only touches rows that changed", () => {
    const { term, rows } = setup();
    term.write("a\r\nb");
    flush();
    const before = rows()[0].innerHTML;
    const spy = vi.spyOn(rows()[0], "innerHTML", "set");
    term.write("c");
    flush();
    expect(spy).not.toHaveBeenCalled();
    expect(rows()[0].innerHTML).toBe(before);
  });

  it("pins non-Latin glyphs to their cell width", () => {
    const { term, rows } = setup();
    term.write("─中");
    flush();
    const glyphs = rows()[0].querySelectorAll<HTMLElement>(".gw-vt-g");
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].style.width).toBe("8px");
    expect(glyphs[1].style.width).toBe("16px");
  });

  it("answers device queries through onData", () => {
    const { term, sent } = setup();
    term.write("\x1b[6n");
    expect(sent).toEqual(["\x1b[1;1R"]);
  });

  it("sends typed keys, honouring application cursor mode", () => {
    const { term, sent, input } = setup();
    key(input, "a");
    key(input, "ArrowUp");
    term.write("\x1b[?1h");
    key(input, "ArrowUp");
    key(input, "c", { ctrlKey: true });
    expect(sent).toEqual(["a", "\x1b[A", "\x1bOA", "\x03"]);
  });

  it("lets the custom key handler veto a key", () => {
    const { sent, input } = setup({ customKeyHandler: (e) => e.key !== "t" });
    const e = key(input, "t", { ctrlKey: true });
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("Shift+Enter is a newline only when enabled", () => {
    const shell = setup();
    key(shell.input, "Enter", { shiftKey: true });
    expect(shell.sent).toEqual(["\r"]);
    const agent = setup({ shiftEnterNewline: true });
    key(agent.input, "Enter", { shiftKey: true });
    expect(agent.sent).toEqual(["\x1b\r"]);
  });

  it("brackets pastes when the app asked for it and strips smuggled end markers", () => {
    const { term, sent } = setup();
    term.paste("a\nb");
    term.write("\x1b[?2004h");
    term.paste("x\x1b[201~y");
    expect(sent).toEqual(["a\rb", "\x1b[200~xy\x1b[201~"]);
  });

  it("copies the selection with Ctrl+Shift+C instead of sending it", () => {
    const copied: string[] = [];
    const { term, sent, input } = setup({ writeClipboard: (t) => copied.push(t) });
    term.write("hello   \r\nworld");
    term.selectAll();
    key(input, "C", { ctrlKey: true, shiftKey: true });
    expect(copied).toEqual(["hello\nworld\n"]);
    expect(sent).toEqual([]);
  });

  it("joins soft-wrapped lines when copying", () => {
    const { term } = setup();
    term.write("0123456789ab");
    term.selectAll();
    expect(term.getSelection().startsWith("0123456789ab")).toBe(true);
  });

  it("finds text forward and backward, including in scrollback", () => {
    const { term } = setup();
    term.write("foo\r\nbar\r\nfoo\r\nbaz\r\nqux");
    expect(term.findNext("foo")).toBe(true);
    expect(term.findNext("foo")).toBe(true);
    expect(term.findPrevious("foo")).toBe(true);
    expect(term.findNext("nope")).toBe(false);
  });

  it("dispose removes the DOM and stops listening", () => {
    const { term, host, sent, input } = setup();
    term.dispose();
    expect(host.querySelector(".gw-vt")).toBeNull();
    key(input, "a");
    expect(sent).toEqual([]);
  });
});
