import { describe, it, expect } from "vitest";
import { VtEmulator, BOLD, INVERSE, TRUECOLOR, DEFAULT_COLOR } from "../emulator";

function emu(cols = 10, rows = 4, scrollback = 100) {
  const replies: string[] = [];
  const titles: string[] = [];
  const e = new VtEmulator(cols, rows, {
    scrollback,
    onResponse: (s) => replies.push(s),
    onTitle: (t) => titles.push(t),
  });
  return { e, replies, titles };
}

/** Screen rows as trimmed strings. */
function screen(e: VtEmulator): string[] {
  return e.lines.map((l) => l.text().replace(/\s+$/, ""));
}

describe("VtEmulator — printing and wrapping", () => {
  it("prints text and moves the cursor", () => {
    const { e } = emu();
    e.write("hello");
    expect(screen(e)[0]).toBe("hello");
    expect([e.cursorX, e.cursorY]).toEqual([5, 0]);
  });

  it("CR LF start a new line", () => {
    const { e } = emu();
    e.write("ab\r\ncd");
    expect(screen(e).slice(0, 2)).toEqual(["ab", "cd"]);
  });

  it("defers the wrap until the next printable (pending-wrap)", () => {
    const { e } = emu(5, 3);
    e.write("abcde");
    expect([e.cursorX, e.cursorY]).toEqual([4, 0]);
    e.write("f");
    expect(screen(e).slice(0, 2)).toEqual(["abcde", "f"]);
    expect(e.lines[0].wrapped).toBe(true);
  });

  it("CR right after filling a line does not create an empty row", () => {
    const { e } = emu(5, 3);
    e.write("abcde\r\nx");
    expect(screen(e).slice(0, 2)).toEqual(["abcde", "x"]);
  });

  it("scrolls into scrollback when the screen is full", () => {
    const { e } = emu(10, 2);
    e.write("1\r\n2\r\n3");
    expect(screen(e)).toEqual(["2", "3"]);
    expect(e.scrollback.map((l) => l.text().trim())).toEqual(["1"]);
  });

  it("places wide characters on two cells and wraps them as a unit", () => {
    const { e } = emu(5, 3);
    e.write("ab中");
    expect(e.lines[0].ch.slice(0, 4)).toEqual(["a", "b", "中", ""]);
    expect(e.cursorX).toBe(4);
    e.write("x文");
    // "文" does not fit in the last column → padded, wrapped to the next row.
    expect(e.lines[0].text().trim()).toBe("ab中x");
    expect(e.lines[1].ch.slice(0, 2)).toEqual(["文", ""]);
  });

  it("joins combining marks onto the previous cell", () => {
    const { e } = emu();
    e.write("éx");
    expect(e.lines[0].ch[0]).toBe("é");
    expect(e.lines[0].ch[1]).toBe("x");
  });

  it("decodes astral characters (emoji) from surrogate pairs", () => {
    const { e } = emu();
    e.write("🚀a");
    expect(e.lines[0].ch[0]).toBe("🚀");
    expect(e.lines[0].ch[1]).toBe("");
    expect(e.lines[0].ch[2]).toBe("a");
  });
});

describe("VtEmulator — cursor and erase", () => {
  it("CUP is 1-based and clamps", () => {
    const { e } = emu(10, 4);
    e.write("\x1b[2;3Hx\x1b[99;99Hy");
    expect(e.lines[1].ch[2]).toBe("x");
    expect(e.lines[3].ch[9]).toBe("y");
  });

  it("relative moves", () => {
    const { e } = emu(10, 4);
    e.write("\x1b[3;5H\x1b[2A\x1b[3D\x1b[B\x1b[4C");
    expect([e.cursorX, e.cursorY]).toEqual([5, 1]);
  });

  it("EL erases to end / start / whole line", () => {
    const { e } = emu(10, 3);
    e.write("abcdef\x1b[4G\x1b[K");
    expect(screen(e)[0]).toBe("abc");
    e.write("\r\nabcdef\x1b[3G\x1b[1K");
    expect(screen(e)[1]).toBe("   def");
    e.write("\x1b[2K");
    expect(screen(e)[1]).toBe("");
  });

  it("ED 2 clears the screen, ED 3 the scrollback", () => {
    const { e } = emu(10, 2);
    e.write("1\r\n2\r\n3\x1b[2J");
    expect(screen(e)).toEqual(["", ""]);
    expect(e.scrollback.length).toBe(1);
    e.write("\x1b[3J");
    expect(e.scrollback.length).toBe(0);
  });

  it("insert / delete characters", () => {
    const { e } = emu(10, 2);
    e.write("abcdef\x1b[3G\x1b[2@");
    expect(screen(e)[0]).toBe("ab  cdef");
    e.write("\x1b[3P");
    expect(screen(e)[0]).toBe("abdef");
  });

  it("ECH erases without moving text", () => {
    const { e } = emu(10, 2);
    e.write("abcdef\x1b[2G\x1b[3X");
    expect(screen(e)[0]).toBe("a   ef");
  });

  it("save / restore cursor (DECSC / DECRC) keeps attributes", () => {
    const { e } = emu(10, 3);
    e.write("\x1b[1m\x1b[2;4H\x1b7\x1b[0m\x1b[H\x1b8x");
    expect(e.lines[1].ch[3]).toBe("x");
    expect(e.lines[1].fl[3] & BOLD).toBe(BOLD);
  });

  it("REP repeats the last printed character", () => {
    const { e } = emu(10, 2);
    e.write("─\x1b[4b");
    expect(screen(e)[0]).toBe("─────");
  });

  it("tabs stop every 8 columns", () => {
    const { e } = emu(20, 2);
    e.write("a\tb");
    expect(e.lines[0].ch[8]).toBe("b");
  });
});

describe("VtEmulator — scroll regions", () => {
  it("LF at the bottom margin scrolls only the region", () => {
    const { e } = emu(10, 4);
    e.write("top\r\n1\r\n2\r\nbottom");
    e.write("\x1b[2;3r\x1b[3;1H\nnew");
    expect(screen(e)).toEqual(["top", "2", "new", "bottom"]);
    expect(e.scrollback.length).toBe(0); // region does not start at row 1
  });

  it("a region starting at the top feeds scrollback (codex inline history)", () => {
    const { e } = emu(10, 4);
    e.write("a\r\nb\r\nc\r\nprompt");
    e.write("\x1b[1;3r\x1b[3;1H\nd\x1b[r");
    expect(screen(e)).toEqual(["b", "c", "d", "prompt"]);
    expect(e.scrollback.map((l) => l.text().trim())).toEqual(["a"]);
  });

  it("RI at the top margin scrolls down", () => {
    const { e } = emu(10, 3);
    e.write("a\r\nb\r\nc\x1b[H\x1bM");
    expect(screen(e)).toEqual(["", "a", "b"]);
  });

  it("IL / DL", () => {
    const { e } = emu(10, 4);
    e.write("1\r\n2\r\n3\r\n4\x1b[2;1H\x1b[L");
    expect(screen(e)).toEqual(["1", "", "2", "3"]);
    e.write("\x1b[2M");
    expect(screen(e)).toEqual(["1", "3", "", ""]);
  });
});

describe("VtEmulator — SGR", () => {
  it("16 / 256 / truecolor, semicolon and colon forms", () => {
    const { e } = emu(10, 2);
    e.write("\x1b[31ma\x1b[38;5;208mb\x1b[38;2;1;2;3mc\x1b[38:2::4:5:6md\x1b[48:5:17me\x1b[0mf");
    const l = e.lines[0];
    expect(l.fg[0]).toBe(1);
    expect(l.fg[1]).toBe(208);
    expect(l.fg[2]).toBe(TRUECOLOR | 0x010203);
    expect(l.fg[3]).toBe(TRUECOLOR | 0x040506);
    expect(l.bg[4]).toBe(17);
    expect(l.fg[5]).toBe(DEFAULT_COLOR);
    expect(l.bg[5]).toBe(DEFAULT_COLOR);
  });

  it("colon sub-params do not leak into following params", () => {
    const { e } = emu(10, 2);
    e.write("\x1b[4:3;31mx");
    // "3" belongs to the underline style — it must not turn italic on.
    expect(e.lines[0].fl[0] & 4).toBe(0);
    expect(e.lines[0].fg[0]).toBe(1);
  });

  it("bright colours and attribute resets", () => {
    const { e } = emu(10, 2);
    e.write("\x1b[1;7;94mx\x1b[22;27my");
    expect(e.lines[0].fg[0]).toBe(12);
    expect(e.lines[0].fl[0] & (BOLD | INVERSE)).toBe(BOLD | INVERSE);
    expect(e.lines[0].fl[1]).toBe(0);
  });

  it("erase uses the current background (BCE)", () => {
    const { e } = emu(4, 2);
    e.write("\x1b[44m\x1b[2K");
    expect(Array.from(e.lines[0].bg)).toEqual([4, 4, 4, 4]);
  });
});

describe("VtEmulator — modes and screens", () => {
  it("alternate screen preserves the main screen and cursor", () => {
    const { e } = emu(10, 3);
    e.write("main\x1b[?1049h");
    expect(e.altScreen).toBe(true);
    expect(screen(e)).toEqual(["", "", ""]);
    e.write("\x1b[2;2Halt");
    e.write("\x1b[?1049l");
    expect(e.altScreen).toBe(false);
    expect(screen(e)[0]).toBe("main");
    expect([e.cursorX, e.cursorY]).toEqual([4, 0]);
  });

  it("the alternate screen never feeds scrollback", () => {
    const { e } = emu(10, 2);
    e.write("\x1b[?1049h1\r\n2\r\n3\r\n4");
    expect(e.scrollback.length).toBe(0);
  });

  it("tracks the private modes apps toggle", () => {
    const { e } = emu();
    e.write("\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l");
    expect(e.modes).toMatchObject({
      appCursor: true, bracketedPaste: true, mouseTracking: 1002,
      sgrMouse: true, focusEvents: true, cursorVisible: false,
    });
    e.write("\x1b[?1002l\x1b[?25h");
    expect(e.modes.mouseTracking).toBe(0);
    expect(e.modes.cursorVisible).toBe(true);
  });

  it("synchronized output flag (DEC 2026)", () => {
    const { e } = emu();
    e.write("\x1b[?2026h");
    expect(e.modes.syncOutput).toBe(true);
    e.write("\x1b[?2026l");
    expect(e.modes.syncOutput).toBe(false);
  });

  it("DEC special graphics charset draws lines", () => {
    const { e } = emu();
    e.write("\x1b(0lqk\x1b(Bq");
    expect(screen(e)[0]).toBe("┌─┐q");
  });
});

describe("VtEmulator — queries", () => {
  it("answers DSR cursor position, DA1, DA2, status", () => {
    const { e, replies } = emu();
    e.write("\x1b[2;3H\x1b[6n\x1b[c\x1b[>c\x1b[5n");
    expect(replies).toEqual(["\x1b[2;3R", "\x1b[?62;22c", "\x1b[>0;276;0c", "\x1b[0n"]);
  });

  it("answers OSC 10/11 colour queries (BEL and ST terminated)", () => {
    const { e, replies } = emu();
    e.write("\x1b]11;?\x07\x1b]10;?\x1b\\");
    expect(replies[0]).toContain("]11;rgb:");
    expect(replies[1]).toContain("]10;rgb:");
  });

  it("answers DECRQM for known and unknown modes", () => {
    const { e, replies } = emu();
    e.write("\x1b[?2026$p\x1b[?2004h\x1b[?2004$p\x1b[?9999$p");
    expect(replies).toEqual(["\x1b[?2026;2$y", "\x1b[?2004;1$y", "\x1b[?9999;0$y"]);
  });

  it("stays silent on the kitty keyboard query", () => {
    const { e, replies } = emu();
    e.write("\x1b[?u");
    expect(replies).toEqual([]);
  });

  it("reports the text area size (CSI 18 t)", () => {
    const { e, replies } = emu(80, 24);
    e.write("\x1b[18t");
    expect(replies).toEqual(["\x1b[8;24;80t"]);
  });

  it("sets the title from OSC 0 / 2", () => {
    const { e, titles } = emu();
    e.write("\x1b]0;hello\x07\x1b]2;world\x1b\\");
    expect(titles).toEqual(["hello", "world"]);
  });

  it("swallows DCS / APC payloads and unknown OSC without printing", () => {
    const { e } = emu();
    e.write("\x1bPq#0;2;0;0;0\x1b\\\x1b_Gf=24;AAAA\x1b\\\x1b]8;;https://x.y\x1b\\a\x1b]8;;\x1b\\b\x1b]52;c;aGk=\x07c");
    expect(screen(e)[0]).toBe("abc");
  });

  it("handles sequences split across writes", () => {
    const { e } = emu();
    e.write("\x1b[3");
    e.write("1mx\x1b");
    e.write("[0my");
    expect(e.lines[0].fg[0]).toBe(1);
    expect(e.lines[0].fg[1]).toBe(DEFAULT_COLOR);
  });
});

describe("VtEmulator — resize and scrollback", () => {
  it("shrinking rows keeps the cursor line visible", () => {
    const { e } = emu(10, 4);
    e.write("1\r\n2\r\n3\r\n4");
    e.resize(10, 2);
    expect(screen(e)).toEqual(["3", "4"]);
    expect(e.cursorY).toBe(1);
    expect(e.scrollback.map((l) => l.text().trim())).toEqual(["1", "2"]);
  });

  it("growing rows pulls lines back from scrollback", () => {
    const { e } = emu(10, 2);
    e.write("1\r\n2\r\n3");
    e.resize(10, 3);
    expect(screen(e)).toEqual(["1", "2", "3"]);
    expect(e.scrollback.length).toBe(0);
  });

  it("shrinking columns truncates and clamps the cursor", () => {
    const { e } = emu(10, 2);
    e.write("abcdefghij");
    e.resize(4, 2);
    expect(screen(e)[0]).toBe("abcd");
    expect(e.cursorX).toBe(3);
    e.write("\x1b[1;1Hz");
    expect(e.lines[0].length).toBe(4);
  });

  it("caps scrollback and counts trimmed lines", () => {
    const { e } = emu(10, 1, 10);
    for (let i = 0; i < 30; i++) e.write(`${i}\r\n`);
    expect(e.scrollback.length).toBeLessThanOrEqual(10);
    expect(e.scrollbackTrimmed + e.scrollback.length).toBe(30);
  });

  it("clear() drops scrollback and keeps the cursor line on top", () => {
    const { e } = emu(10, 3);
    e.write("1\r\n2\r\n3\r\n4\r\n$ ");
    e.clear();
    expect(e.scrollback.length).toBe(0);
    expect(screen(e)).toEqual(["$", "", ""]);
    expect(e.cursorY).toBe(0);
  });

  it("reports dirty rows, then nothing until the next change", () => {
    const { e } = emu(10, 3);
    e.takeDirty();
    e.write("\x1b[2;1Hx");
    const d = e.takeDirty();
    expect(d.all).toBe(false);
    expect([...d.rows]).toEqual([1]);
    expect(e.takeDirty().rows.size).toBe(0);
  });
});
