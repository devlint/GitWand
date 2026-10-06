/**
 * Headless VT emulator — the state half of GitWand's built-in terminal.
 *
 * Parses the PTY byte stream (already decoded to a string by the backend) and
 * maintains the screen grid, scrollback, cursor and terminal modes. It knows
 * nothing about the DOM: `DomTerminal` renders it. Scope is the subset of
 * xterm the AI CLIs actually emit — Ink (claude, gemini, copilot), ratatui /
 * crossterm (codex), bubbletea (opencode) — plus what a login shell needs:
 * cursor addressing, erase, SGR colours (16 / 256 / truecolor), scroll
 * regions, the alternate screen, bracketed paste, mouse + focus reporting,
 * synchronized output (DEC 2026) and the device queries those libraries block
 * on at startup (DA1, DSR 6n, OSC 10/11, DECRQM).
 *
 * Deliberately absent: line reflow on resize (the CLIs redraw themselves on
 * SIGWINCH), sixel / kitty graphics, DECLRMM left/right margins, and a
 * printer. Unknown sequences are consumed and ignored.
 */
import { charWidth } from "./wcwidth";

// ─── Cell attributes ─────────────────────────────────────

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const BLINK = 16;
export const INVERSE = 32;
export const HIDDEN = 64;
export const STRIKE = 128;

/** Colour encoding: -1 default, 0..255 palette index, TRUECOLOR | 0xRRGGBB. */
export const DEFAULT_COLOR = -1;
export const TRUECOLOR = 0x1000000;

/** One screen row. Struct-of-arrays so scrollback stays cheap. */
export class Line {
  /** Cell text; "" marks the right half of a wide character. */
  ch: string[];
  fg: Int32Array;
  bg: Int32Array;
  fl: Uint16Array;
  /** True when the row continues on the next one (soft wrap) — used for copy. */
  wrapped = false;

  constructor(cols: number, bg = DEFAULT_COLOR) {
    this.ch = new Array<string>(cols).fill(" ");
    this.fg = new Int32Array(cols).fill(DEFAULT_COLOR);
    this.bg = new Int32Array(cols).fill(bg);
    this.fl = new Uint16Array(cols);
  }

  get length(): number {
    return this.ch.length;
  }

  clear(from: number, to: number, bg: number): void {
    const end = Math.min(to, this.ch.length);
    for (let i = Math.max(0, from); i < end; i++) {
      this.ch[i] = " ";
      this.fg[i] = DEFAULT_COLOR;
      this.bg[i] = bg;
      this.fl[i] = 0;
    }
  }

  resize(cols: number): void {
    const old = this.ch.length;
    if (cols === old) return;
    if (cols < old) {
      // Never leave the left half of a wide char without its right half.
      if (cols > 0 && this.ch[cols] === "") this.ch[cols - 1] = " ";
      this.ch.length = cols;
      this.fg = this.fg.slice(0, cols);
      this.bg = this.bg.slice(0, cols);
      this.fl = this.fl.slice(0, cols);
      return;
    }
    for (let i = old; i < cols; i++) this.ch.push(" ");
    const fg = new Int32Array(cols).fill(DEFAULT_COLOR);
    fg.set(this.fg);
    const bg = new Int32Array(cols).fill(DEFAULT_COLOR);
    bg.set(this.bg);
    const fl = new Uint16Array(cols);
    fl.set(this.fl);
    this.fg = fg;
    this.bg = bg;
    this.fl = fl;
  }

  /** Plain text, wide-char continuations skipped. */
  text(from = 0, to = this.ch.length): string {
    let s = "";
    for (let i = from; i < to && i < this.ch.length; i++) s += this.ch[i];
    return s;
  }
}

// ─── Emulator ────────────────────────────────────────────

export type MouseTracking = 0 | 9 | 1000 | 1002 | 1003;

export interface VtModes {
  /** DECCKM — arrow keys send SS3 (ESC O A) instead of CSI. */
  appCursor: boolean;
  /** DECKPAM — numeric keypad application mode. */
  appKeypad: boolean;
  bracketedPaste: boolean;
  mouseTracking: MouseTracking;
  sgrMouse: boolean;
  focusEvents: boolean;
  /** DEC 2026 — the app is mid-frame; the renderer should hold off. */
  syncOutput: boolean;
  cursorVisible: boolean;
}

export interface VtOptions {
  scrollback?: number;
  /** Bytes the terminal must send back to the PTY (query replies). */
  onResponse?: (data: string) => void;
  onTitle?: (title: string) => void;
  onBell?: () => void;
}

interface SavedCursor {
  x: number;
  y: number;
  fg: number;
  bg: number;
  fl: number;
  originMode: boolean;
  wrapPending: boolean;
  g0Graphics: boolean;
}

const enum State {
  Ground,
  Escape,
  EscapeIntermediate,
  Csi,
  Osc,
  OscEscape,
  /** DCS / SOS / PM / APC payload — swallowed until ST. */
  Ignore,
  IgnoreEscape,
}

// DEC Special Graphics (ESC ( 0) — line drawing used by some ncurses apps.
const DEC_GRAPHICS: Record<string, string> = {
  "`": "◆", a: "▒", f: "°", g: "±", j: "┘", k: "┐", l: "┌", m: "└", n: "┼",
  o: "⎺", p: "⎻", q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬",
  x: "│", y: "≤", z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·",
};

const MAX_PARAMS = 32;

/** `#rrggbb` → X11 `rgb:rrrr/gggg/bbbb`. */
function xrgb(hex: string): string {
  const h = (i: number) => hex.slice(i, i + 2).repeat(2);
  return `rgb:${h(1)}/${h(3)}/${h(5)}`;
}

const ASCII: string[] = Array.from({ length: 0x80 }, (_, i) => String.fromCharCode(i));

export class VtEmulator {
  cols: number;
  rows: number;

  /** Active screen rows (normal or alternate). */
  lines: Line[];
  /** Lines scrolled off the top of the normal screen, oldest first. */
  readonly scrollback: Line[] = [];
  readonly maxScrollback: number;
  /** Lines dropped off the head of `scrollback` since creation (for selection anchoring). */
  scrollbackTrimmed = 0;

  cursorX = 0;
  cursorY = 0;
  altScreen = false;
  readonly modes: VtModes = {
    appCursor: false,
    appKeypad: false,
    bracketedPaste: false,
    mouseTracking: 0,
    sgrMouse: false,
    focusEvents: false,
    syncOutput: false,
    cursorVisible: true,
  };
  title = "";
  /** Default colours reported to OSC 10 / 11 queries (`#rrggbb`). */
  defaultFg = "#e5e5e5";
  defaultBg = "#000000";

  // Dirty tracking for the renderer.
  private dirtyRows = new Set<number>();
  private allDirty = true;

  private normalLines: Line[];
  private altLines: Line[] | null = null;

  private fg = DEFAULT_COLOR;
  private bg = DEFAULT_COLOR;
  private fl = 0;
  private wrapPending = false;
  private autoWrap = true;
  private originMode = false;
  private insertMode = false;
  private newlineMode = false;
  private scrollTop = 0;
  private scrollBottom: number;
  private tabStops = new Set<number>();
  private g0Graphics = false;
  private g1Graphics = false;
  private shiftOut = false;
  private savedNormal: SavedCursor | null = null;
  private savedAlt: SavedCursor | null = null;
  private lastPrinted = "";

  // Parser state.
  private state = State.Ground;
  private params: number[] = [];
  /** colon[i] — param i was followed by ':' (a sub-parameter follows). */
  private colon: boolean[] = [];
  private curParam = -1;
  private prefix = "";
  private intermediates = "";
  private oscBuf = "";

  private readonly opts: VtOptions;

  constructor(cols: number, rows: number, opts: VtOptions = {}) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.opts = opts;
    this.maxScrollback = opts.scrollback ?? 5000;
    this.normalLines = this.blankLines(this.rows);
    this.lines = this.normalLines;
    this.scrollBottom = this.rows - 1;
    this.resetTabStops();
  }

  // ─── Public API ──────────────────────────────────────

  write(data: string): void {
    const len = data.length;
    for (let i = 0; i < len; i++) {
      let code = data.charCodeAt(i);
      if (this.state === State.Ground) {
        if (code >= 0x20 && code !== 0x7f) {
          // Printable — decode surrogate pairs here, the hot path.
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
            const lo = data.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              code = ((code - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
              i++;
            }
          }
          this.print(code);
          continue;
        }
        this.control(code);
        continue;
      }
      this.parse(code, data[i]);
    }
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (cols === this.cols && rows === this.rows) return;

    for (const buf of [this.normalLines, this.altLines]) {
      if (!buf) continue;
      for (const l of buf) l.resize(cols);
    }
    // New lines created while resizing rows must already have the new width.
    this.cols = cols;

    if (rows !== this.rows) {
      this.resizeRows(this.normalLines, rows, !this.altScreen);
      if (this.altLines) this.resizeRows(this.altLines, rows, this.altScreen);
    }

    this.rows = rows;
    this.lines = this.altScreen && this.altLines ? this.altLines : this.normalLines;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.cursorX = Math.min(this.cursorX, cols - 1);
    this.cursorY = Math.min(Math.max(0, this.cursorY), rows - 1);
    this.wrapPending = false;
    this.resetTabStops();
    this.allDirty = true;
  }

  /** Like xterm's `clear()`: drop scrollback, keep the cursor line at the top. */
  clear(): void {
    const keep = this.lines[this.cursorY];
    this.scrollback.length = 0;
    const fresh = this.blankLines(this.rows);
    fresh[0] = keep;
    this.lines.splice(0, this.rows, ...fresh);
    this.cursorY = 0;
    this.allDirty = true;
  }

  /** Full reset (RIS). */
  reset(): void {
    this.altLines = null;
    this.altScreen = false;
    this.normalLines = this.blankLines(this.rows);
    this.lines = this.normalLines;
    this.scrollback.length = 0;
    this.cursorX = this.cursorY = 0;
    this.fg = this.bg = DEFAULT_COLOR;
    this.fl = 0;
    this.wrapPending = false;
    this.autoWrap = true;
    this.originMode = this.insertMode = this.newlineMode = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.g0Graphics = this.g1Graphics = this.shiftOut = false;
    this.savedNormal = this.savedAlt = null;
    Object.assign(this.modes, {
      appCursor: false, appKeypad: false, bracketedPaste: false, mouseTracking: 0,
      sgrMouse: false, focusEvents: false, syncOutput: false, cursorVisible: true,
    });
    this.resetTabStops();
    this.allDirty = true;
  }

  /** Rows changed since the last call (`all` = repaint everything). */
  takeDirty(): { all: boolean; rows: Set<number> } {
    const out = { all: this.allDirty, rows: this.dirtyRows };
    this.allDirty = false;
    this.dirtyRows = new Set();
    return out;
  }

  markAllDirty(): void {
    this.allDirty = true;
  }

  /** Total addressable lines: scrollback + screen. */
  get totalLines(): number {
    return this.scrollback.length + this.rows;
  }

  /** Line by absolute index into scrollback ++ screen. */
  lineAt(abs: number): Line | undefined {
    const sb = this.scrollback.length;
    return abs < sb ? this.scrollback[abs] : this.lines[abs - sb];
  }

  // ─── Printing ────────────────────────────────────────

  private print(code: number): void {
    let ch = code < 0x80 ? ASCII[code] : String.fromCodePoint(code);
    const graphics = this.shiftOut ? this.g1Graphics : this.g0Graphics;
    if (graphics && code < 0x7f) ch = DEC_GRAPHICS[ch] ?? ch;

    const w = charWidth(code);
    if (w === 0) {
      // Combining / zero-width: glue onto the previous cell.
      const line = this.lines[this.cursorY];
      let x = this.wrapPending ? this.cursorX : this.cursorX - 1;
      if (x >= 0 && line.ch[x] === "" && x > 0) x--;
      if (x >= 0) {
        line.ch[x] += ch;
        this.dirtyRows.add(this.cursorY);
      }
      return;
    }

    if (this.wrapPending) {
      if (this.autoWrap) {
        this.lines[this.cursorY].wrapped = true;
        this.cursorX = 0;
        this.lineFeed();
      }
      this.wrapPending = false;
    }

    if (w === 2 && this.cursorX === this.cols - 1) {
      // A wide char never straddles the edge: pad, then wrap.
      if (this.autoWrap) {
        this.lines[this.cursorY].clear(this.cursorX, this.cols, this.bg);
        this.lines[this.cursorY].wrapped = true;
        this.cursorX = 0;
        this.lineFeed();
      } else {
        return;
      }
    }
    if (w === 2 && this.cols < 2) return;

    const line = this.lines[this.cursorY];
    if (this.insertMode) this.shiftRight(line, this.cursorX, w);

    // Overwriting half of an existing wide char leaves the other half blank.
    if (line.ch[this.cursorX] === "" && this.cursorX > 0) line.ch[this.cursorX - 1] = " ";
    if (w === 1 && this.cursorX + 1 < this.cols && line.ch[this.cursorX + 1] === "") {
      line.ch[this.cursorX + 1] = " ";
    }

    this.setCell(line, this.cursorX, ch);
    if (w === 2) {
      if (this.cursorX + 2 < this.cols && line.ch[this.cursorX + 2] === "") line.ch[this.cursorX + 2] = " ";
      this.setCell(line, this.cursorX + 1, "");
    }
    this.lastPrinted = ch;
    this.dirtyRows.add(this.cursorY);

    const next = this.cursorX + w;
    if (next >= this.cols) {
      this.cursorX = this.cols - 1;
      this.wrapPending = true;
    } else {
      this.cursorX = next;
    }
  }

  private setCell(line: Line, x: number, ch: string): void {
    line.ch[x] = ch;
    line.fg[x] = this.fg;
    line.bg[x] = this.bg;
    line.fl[x] = this.fl;
  }

  private shiftRight(line: Line, x: number, n: number): void {
    for (let i = this.cols - 1; i >= x + n; i--) {
      line.ch[i] = line.ch[i - n];
      line.fg[i] = line.fg[i - n];
      line.bg[i] = line.bg[i - n];
      line.fl[i] = line.fl[i - n];
    }
    line.clear(x, Math.min(x + n, this.cols), this.bg);
  }

  // ─── C0 controls ─────────────────────────────────────

  private control(code: number): void {
    switch (code) {
      case 0x1b: this.enterEscape(); break;
      case 0x0d: this.cursorX = 0; this.wrapPending = false; break; // CR
      case 0x0a: case 0x0b: case 0x0c: // LF VT FF
        this.lineFeed();
        if (this.newlineMode) this.cursorX = 0;
        break;
      case 0x08: // BS
        if (this.wrapPending) this.wrapPending = false;
        else if (this.cursorX > 0) this.cursorX--;
        break;
      case 0x09: this.tab(1); break;
      case 0x07: this.opts.onBell?.(); break;
      case 0x0e: this.shiftOut = true; break; // SO → G1
      case 0x0f: this.shiftOut = false; break; // SI → G0
      default: break; // NUL, DEL and the rest are ignored
    }
  }

  private enterEscape(): void {
    this.state = State.Escape;
    this.intermediates = "";
  }

  // ─── Escape-sequence state machine ───────────────────

  private parse(code: number, ch: string): void {
    switch (this.state) {
      case State.Escape:
        this.escape(code, ch);
        return;
      case State.EscapeIntermediate:
        if (code >= 0x20 && code <= 0x2f) { this.intermediates += ch; return; }
        this.escDispatch(ch);
        this.state = State.Ground;
        return;
      case State.Csi:
        this.csiByte(code, ch);
        return;
      case State.Osc:
        if (code === 0x07) { this.oscDispatch(); this.state = State.Ground; return; }
        if (code === 0x1b) { this.state = State.OscEscape; return; }
        if (this.oscBuf.length < 4096) this.oscBuf += ch;
        return;
      case State.OscEscape:
        // ESC \ (ST) ends the string; any other ESC aborts it and starts anew.
        this.oscDispatch();
        if (ch === "\\") { this.state = State.Ground; return; }
        this.enterEscape();
        this.escape(code, ch);
        return;
      case State.Ignore:
        if (code === 0x1b) this.state = State.IgnoreEscape;
        else if (code === 0x07 || code === 0x9c) this.state = State.Ground;
        return;
      case State.IgnoreEscape:
        this.state = ch === "\\" ? State.Ground : State.Ignore;
        return;
      default:
        this.state = State.Ground;
    }
  }

  private escape(code: number, ch: string): void {
    if (code === 0x18 || code === 0x1a) { this.state = State.Ground; return; } // CAN / SUB
    if (code < 0x20) { this.control(code); return; }
    switch (ch) {
      case "[":
        this.state = State.Csi;
        this.params = [];
        this.colon = [];
        this.curParam = -1;
        this.prefix = "";
        this.intermediates = "";
        return;
      case "]":
        this.state = State.Osc;
        this.oscBuf = "";
        return;
      case "P": case "X": case "^": case "_":
        this.state = State.Ignore;
        return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediates += ch;
      this.state = State.EscapeIntermediate;
      return;
    }
    this.escDispatch(ch);
    this.state = State.Ground;
  }

  private escDispatch(ch: string): void {
    const inter = this.intermediates;
    if (inter === "(" || inter === ")") {
      const graphics = ch === "0";
      if (inter === "(") this.g0Graphics = graphics;
      else this.g1Graphics = graphics;
      return;
    }
    if (inter === "#") return; // DECALN & friends — ignore
    if (inter) return; // other charset designations (ESC * / ESC + …)
    switch (ch) {
      case "7": this.saveCursor(); break;
      case "8": this.restoreCursor(); break;
      case "D": this.index(); break;
      case "E": this.cursorX = 0; this.index(); break;
      case "M": this.reverseIndex(); break;
      case "H": this.tabStops.add(this.cursorX); break;
      case "c": this.reset(); break;
      case "=": this.modes.appKeypad = true; break;
      case ">": this.modes.appKeypad = false; break;
      case "\\": break; // stray ST
      default: break;
    }
  }

  // ─── CSI ─────────────────────────────────────────────

  private csiByte(code: number, ch: string): void {
    if (code >= 0x30 && code <= 0x39) {
      if (this.curParam < 0) this.curParam = 0;
      this.curParam = Math.min(this.curParam * 10 + (code - 0x30), 0xffff);
      return;
    }
    if (ch === ";" || ch === ":") {
      if (this.params.length < MAX_PARAMS) {
        this.params.push(this.curParam);
        this.colon.push(ch === ":");
      }
      this.curParam = -1;
      return;
    }
    if (code >= 0x3c && code <= 0x3f) { // < = > ?
      if (this.params.length === 0 && this.curParam < 0) this.prefix += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediates += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      if (this.curParam >= 0 || this.params.length > 0) {
        if (this.params.length < MAX_PARAMS) {
          this.params.push(this.curParam);
          this.colon.push(false);
        }
      }
      this.state = State.Ground;
      this.csiDispatch(ch);
      return;
    }
    if (code === 0x1b) { this.enterEscape(); return; }
    if (code < 0x20) { this.control(code); return; }
    // Anything else: malformed — abort the sequence.
    this.state = State.Ground;
  }

  /** Param `i`, with -1 (omitted) and 0 mapped to `def`. */
  private p(i: number, def = 1): number {
    const v = this.params[i];
    return v === undefined || v < 0 || v === 0 ? def : v;
  }

  /** Raw param `i`, omitted → `def` (0 stays 0). */
  private raw(i: number, def = 0): number {
    const v = this.params[i];
    return v === undefined || v < 0 ? def : v;
  }

  private csiDispatch(final: string): void {
    const pre = this.prefix;
    const inter = this.intermediates;

    if (pre === "?") {
      if (inter === "$" && final === "p") return this.reportMode(true);
      if (final === "h" || final === "l") return this.setPrivateModes(final === "h");
      if (final === "u") return; // kitty keyboard query — stay silent (unsupported)
      if (final === "J") return this.eraseDisplay(this.raw(0));
      if (final === "K") return this.eraseLine(this.raw(0));
      if (final === "n" && this.raw(0) === 6) {
        return this.respond(`\x1b[?${this.cursorY + 1};${this.cursorX + 1}R`);
      }
      return;
    }
    if (pre === ">") {
      if (final === "c") return this.respond("\x1b[>0;276;0c"); // DA2
      if (final === "q") return this.respond("\x1bP>|GitWand\x1b\\"); // XTVERSION
      return; // modifyOtherKeys etc.
    }
    if (pre) return; // `<` `=` private sequences we don't speak

    if (inter === " " && final === "q") return; // DECSCUSR cursor shape — ignored
    if (inter === "!" && final === "p") return this.softReset();
    if (inter === "$" && final === "p") return this.reportMode(false);
    if (inter) return;

    this.wrapPendingClearedBy(final);

    switch (final) {
      case "@": this.insertChars(this.p(0)); break;
      case "A": this.moveCursor(0, -this.p(0)); break;
      case "B": case "e": this.moveCursor(0, this.p(0)); break;
      case "C": case "a": this.moveCursor(this.p(0), 0); break;
      case "D": this.moveCursor(-this.p(0), 0); break;
      case "E": this.cursorX = 0; this.moveCursor(0, this.p(0)); break;
      case "F": this.cursorX = 0; this.moveCursor(0, -this.p(0)); break;
      case "G": case "`": this.cursorX = Math.min(this.p(0), this.cols) - 1; break;
      case "H": case "f": this.cup(this.p(0), this.p(1)); break;
      case "I": this.tab(this.p(0)); break;
      case "J": this.eraseDisplay(this.raw(0)); break;
      case "K": this.eraseLine(this.raw(0)); break;
      case "L": this.insertLines(this.p(0)); break;
      case "M": this.deleteLines(this.p(0)); break;
      case "P": this.deleteChars(this.p(0)); break;
      case "S": this.scrollUp(this.p(0)); break;
      case "T": if (this.params.length <= 1) this.scrollDown(this.p(0)); break;
      case "X": this.eraseChars(this.p(0)); break;
      case "Z": this.tab(-this.p(0)); break;
      case "b": this.repeat(this.p(0)); break;
      case "c": if (this.raw(0) === 0) this.respond("\x1b[?62;22c"); break; // DA1
      case "d": this.cup(this.p(0), this.cursorX + 1); break;
      case "g":
        if (this.raw(0) === 3) this.tabStops.clear();
        else if (this.raw(0) === 0) this.tabStops.delete(this.cursorX);
        break;
      case "h": case "l": this.setAnsiModes(final === "h"); break;
      case "m": this.sgr(); break;
      case "n": this.dsr(this.raw(0)); break;
      case "r": this.setScrollRegion(); break;
      case "s": this.saveCursor(); break;
      case "u": this.restoreCursor(); break;
      case "t": this.windowOp(); break;
      default: break;
    }
  }

  private wrapPendingClearedBy(final: string): void {
    // SGR, mode switches and reports leave the pending-wrap flag alone; every
    // cursor-affecting sequence clears it.
    if (final !== "m" && final !== "h" && final !== "l" && final !== "n" && final !== "t") {
      this.wrapPending = false;
    }
  }

  private respond(s: string): void {
    this.opts.onResponse?.(s);
  }

  // ─── Cursor ──────────────────────────────────────────

  private cup(row: number, col: number): void {
    const top = this.originMode ? this.scrollTop : 0;
    const bottom = this.originMode ? this.scrollBottom : this.rows - 1;
    this.cursorY = Math.min(Math.max(top + row - 1, top), bottom);
    this.cursorX = Math.min(Math.max(col - 1, 0), this.cols - 1);
  }

  private moveCursor(dx: number, dy: number): void {
    this.cursorX = Math.min(Math.max(this.cursorX + dx, 0), this.cols - 1);
    if (dy !== 0) {
      // Vertical moves stop at the scroll margins when starting inside them.
      const inRegion = this.cursorY >= this.scrollTop && this.cursorY <= this.scrollBottom;
      const top = inRegion ? this.scrollTop : 0;
      const bottom = inRegion ? this.scrollBottom : this.rows - 1;
      this.cursorY = Math.min(Math.max(this.cursorY + dy, top), bottom);
    }
  }

  private tab(n: number): void {
    this.wrapPending = false;
    if (n > 0) {
      for (let k = 0; k < n; k++) {
        let x = this.cursorX + 1;
        while (x < this.cols - 1 && !this.tabStops.has(x)) x++;
        this.cursorX = Math.min(x, this.cols - 1);
      }
    } else {
      for (let k = 0; k < -n; k++) {
        let x = this.cursorX - 1;
        while (x > 0 && !this.tabStops.has(x)) x--;
        this.cursorX = Math.max(x, 0);
      }
    }
  }

  private resetTabStops(): void {
    this.tabStops.clear();
    for (let x = 8; x < this.cols; x += 8) this.tabStops.add(x);
  }

  private saveCursor(): void {
    const s: SavedCursor = {
      x: this.cursorX, y: this.cursorY, fg: this.fg, bg: this.bg, fl: this.fl,
      originMode: this.originMode, wrapPending: this.wrapPending, g0Graphics: this.g0Graphics,
    };
    if (this.altScreen) this.savedAlt = s;
    else this.savedNormal = s;
  }

  private restoreCursor(): void {
    const s = this.altScreen ? this.savedAlt : this.savedNormal;
    if (!s) {
      this.cursorX = this.cursorY = 0;
      return;
    }
    this.cursorX = Math.min(s.x, this.cols - 1);
    this.cursorY = Math.min(s.y, this.rows - 1);
    this.fg = s.fg;
    this.bg = s.bg;
    this.fl = s.fl;
    this.originMode = s.originMode;
    this.wrapPending = s.wrapPending;
    this.g0Graphics = s.g0Graphics;
  }

  // ─── Scrolling ───────────────────────────────────────

  private lineFeed(): void {
    if (this.cursorY === this.scrollBottom) this.scrollUp(1);
    else if (this.cursorY < this.rows - 1) this.cursorY++;
  }

  private index(): void {
    this.wrapPending = false;
    this.lineFeed();
  }

  private reverseIndex(): void {
    this.wrapPending = false;
    if (this.cursorY === this.scrollTop) this.scrollDown(1);
    else if (this.cursorY > 0) this.cursorY--;
  }

  private scrollUp(n: number): void {
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    n = Math.min(n, bottom - top + 1);
    const toScrollback = top === 0 && !this.altScreen;
    for (let k = 0; k < n; k++) {
      const [gone] = this.lines.splice(top, 1);
      this.lines.splice(bottom, 0, new Line(this.cols, this.bg));
      if (toScrollback) this.pushScrollback(gone);
    }
    this.allDirty = true;
  }

  private scrollDown(n: number): void {
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    n = Math.min(n, bottom - top + 1);
    for (let k = 0; k < n; k++) {
      this.lines.splice(bottom, 1);
      this.lines.splice(top, 0, new Line(this.cols, this.bg));
    }
    this.allDirty = true;
  }

  private pushScrollback(line: Line): void {
    if (this.maxScrollback <= 0) return;
    this.scrollback.push(line);
    if (this.scrollback.length > this.maxScrollback) {
      // Trim in batches — Array#shift on every line is O(n) per scroll.
      const drop = Math.max(1, Math.floor(this.maxScrollback / 10));
      this.scrollback.splice(0, drop);
      this.scrollbackTrimmed += drop;
    }
  }

  private setScrollRegion(): void {
    const top = this.p(0) - 1;
    const bottom = this.p(1, this.rows) - 1;
    if (top < bottom && bottom < this.rows) {
      this.scrollTop = top;
      this.scrollBottom = bottom;
    } else if (this.params.length === 0) {
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
    } else {
      return;
    }
    this.cup(1, 1);
  }

  private insertLines(n: number): void {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;
    const saved = this.scrollTop;
    this.scrollTop = this.cursorY;
    this.scrollDown(n);
    this.scrollTop = saved;
    this.cursorX = 0;
  }

  private deleteLines(n: number): void {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;
    const top = this.cursorY;
    const bottom = this.scrollBottom;
    n = Math.min(n, bottom - top + 1);
    for (let k = 0; k < n; k++) {
      this.lines.splice(top, 1);
      this.lines.splice(bottom, 0, new Line(this.cols, this.bg));
    }
    this.cursorX = 0;
    this.allDirty = true;
  }

  // ─── Erase / edit ────────────────────────────────────

  private eraseDisplay(mode: number): void {
    const y = this.cursorY;
    switch (mode) {
      case 0:
        this.lines[y].clear(this.cursorX, this.cols, this.bg);
        this.lines[y].wrapped = false;
        for (let r = y + 1; r < this.rows; r++) this.resetLine(r);
        break;
      case 1:
        this.lines[y].clear(0, this.cursorX + 1, this.bg);
        for (let r = 0; r < y; r++) this.resetLine(r);
        break;
      case 2:
        for (let r = 0; r < this.rows; r++) this.resetLine(r);
        break;
      case 3:
        this.scrollback.length = 0;
        break;
    }
    this.allDirty = true;
  }

  private resetLine(r: number): void {
    this.lines[r] = new Line(this.cols, this.bg);
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.cursorY];
    if (mode === 0) {
      line.clear(this.cursorX, this.cols, this.bg);
      line.wrapped = false;
    } else if (mode === 1) {
      line.clear(0, this.cursorX + 1, this.bg);
    } else if (mode === 2) {
      line.clear(0, this.cols, this.bg);
      line.wrapped = false;
    }
    this.dirtyRows.add(this.cursorY);
  }

  private eraseChars(n: number): void {
    this.lines[this.cursorY].clear(this.cursorX, this.cursorX + n, this.bg);
    this.dirtyRows.add(this.cursorY);
  }

  private insertChars(n: number): void {
    this.shiftRight(this.lines[this.cursorY], this.cursorX, Math.min(n, this.cols - this.cursorX));
    this.dirtyRows.add(this.cursorY);
  }

  private deleteChars(n: number): void {
    const line = this.lines[this.cursorY];
    const x = this.cursorX;
    n = Math.min(n, this.cols - x);
    for (let i = x; i < this.cols - n; i++) {
      line.ch[i] = line.ch[i + n];
      line.fg[i] = line.fg[i + n];
      line.bg[i] = line.bg[i + n];
      line.fl[i] = line.fl[i + n];
    }
    line.clear(this.cols - n, this.cols, this.bg);
    this.dirtyRows.add(this.cursorY);
  }

  private repeat(n: number): void {
    if (!this.lastPrinted) return;
    const cp = this.lastPrinted.codePointAt(0)!;
    for (let k = 0; k < Math.min(n, 65535); k++) this.print(cp);
  }

  // ─── Modes ───────────────────────────────────────────

  private setAnsiModes(on: boolean): void {
    for (const m of this.params) {
      if (m === 4) this.insertMode = on;
      else if (m === 20) this.newlineMode = on;
    }
  }

  private setPrivateModes(on: boolean): void {
    for (const m of this.params) {
      switch (m) {
        case 1: this.modes.appCursor = on; break;
        case 6: this.originMode = on; this.cup(1, 1); break;
        case 7: this.autoWrap = on; break;
        case 25: this.modes.cursorVisible = on; this.dirtyRows.add(this.cursorY); break;
        case 9: case 1000: case 1002: case 1003:
          this.modes.mouseTracking = on ? (m as MouseTracking) : 0;
          break;
        case 1004: this.modes.focusEvents = on; break;
        case 1006: this.modes.sgrMouse = on; break;
        case 2004: this.modes.bracketedPaste = on; break;
        case 2026: this.modes.syncOutput = on; break;
        case 47: case 1047: this.setAltScreen(on, false); break;
        case 1049: this.setAltScreen(on, true); break;
        default: break;
      }
    }
  }

  private setAltScreen(on: boolean, saveCursor: boolean): void {
    if (on === this.altScreen) return;
    if (on) {
      if (saveCursor) this.saveCursor();
      this.altLines = this.blankLines(this.rows);
      this.lines = this.altLines;
      this.altScreen = true;
    } else {
      this.altScreen = false;
      this.altLines = null;
      this.lines = this.normalLines;
      if (saveCursor) this.restoreCursor();
    }
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.wrapPending = false;
    this.allDirty = true;
  }

  private reportMode(priv: boolean): void {
    const m = this.raw(0);
    let state = 0; // 0 = not recognized, 1 = set, 2 = reset
    if (priv) {
      const known: Record<number, boolean> = {
        1: this.modes.appCursor,
        6: this.originMode,
        7: this.autoWrap,
        25: this.modes.cursorVisible,
        1000: this.modes.mouseTracking === 1000,
        1002: this.modes.mouseTracking === 1002,
        1003: this.modes.mouseTracking === 1003,
        1004: this.modes.focusEvents,
        1006: this.modes.sgrMouse,
        1049: this.altScreen,
        2004: this.modes.bracketedPaste,
        2026: this.modes.syncOutput,
      };
      if (m in known) state = known[m] ? 1 : 2;
      this.respond(`\x1b[?${m};${state}$y`);
    } else {
      if (m === 4) state = this.insertMode ? 1 : 2;
      else if (m === 20) state = this.newlineMode ? 1 : 2;
      this.respond(`\x1b[${m};${state}$y`);
    }
  }

  private softReset(): void {
    this.modes.cursorVisible = true;
    this.modes.appCursor = false;
    this.modes.appKeypad = false;
    this.insertMode = false;
    this.originMode = false;
    this.autoWrap = true;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.fg = this.bg = DEFAULT_COLOR;
    this.fl = 0;
    this.savedNormal = this.savedAlt = null;
  }

  private dsr(n: number): void {
    if (n === 5) this.respond("\x1b[0n");
    else if (n === 6) this.respond(`\x1b[${this.cursorY + 1};${this.cursorX + 1}R`);
  }

  /** Size reports a cell-based app may ask for. Pixel sizes are approximations. */
  cellPixelWidth = 8;
  cellPixelHeight = 16;

  private windowOp(): void {
    switch (this.raw(0)) {
      case 14:
        this.respond(`\x1b[4;${this.rows * this.cellPixelHeight};${this.cols * this.cellPixelWidth}t`);
        break;
      case 16:
        this.respond(`\x1b[6;${this.cellPixelHeight};${this.cellPixelWidth}t`);
        break;
      case 18:
        this.respond(`\x1b[8;${this.rows};${this.cols}t`);
        break;
      default: break; // window manipulation / title stack — ignored
    }
  }

  // ─── SGR ─────────────────────────────────────────────

  private sgr(): void {
    const ps = this.params.length ? this.params : [0];
    let i = 0;
    while (i < ps.length) {
      // Colon-joined group (ITU T.416 form): 4:3, 38:2::r:g:b, 38:5:n …
      let j = i;
      while (this.colon[j] && j + 1 < ps.length) j++;
      if (j > i) {
        this.sgrGroup(ps.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      const v = ps[i] < 0 ? 0 : ps[i];
      if (v === 38 || v === 48 || v === 58) {
        // Semicolon form: 38;5;n or 38;2;r;g;b.
        const kind = ps[i + 1];
        let color: number | null = null;
        if (kind === 5) {
          color = this.paletteColor(ps[i + 2]);
          i += 3;
        } else if (kind === 2) {
          color = this.rgbColor(ps[i + 2], ps[i + 3], ps[i + 4]);
          i += 5;
        } else {
          i += 2;
        }
        this.applyColor(v, color);
        continue;
      }
      this.sgrSimple(v);
      i++;
    }
  }

  private sgrGroup(g: number[]): void {
    const v = g[0];
    if (v === 4) {
      // 4:0 = no underline; 4:1..5 = single/double/curly/… → plain underline.
      if (g[1] === 0) this.fl &= ~UNDERLINE;
      else this.fl |= UNDERLINE;
      return;
    }
    if (v === 38 || v === 48 || v === 58) {
      let color: number | null = null;
      if (g[1] === 5) color = this.paletteColor(g[2]);
      else if (g[1] === 2) {
        // 38:2:<colour-space>:r:g:b, or the common 38:2:r:g:b without it.
        const o = g.length >= 6 ? 3 : 2;
        color = this.rgbColor(g[o], g[o + 1], g[o + 2]);
      }
      this.applyColor(v, color);
      return;
    }
    this.sgrSimple(v < 0 ? 0 : v);
  }

  private paletteColor(n: number | undefined): number | null {
    return n === undefined || n < 0 ? null : n & 0xff;
  }

  private rgbColor(r?: number, g?: number, b?: number): number | null {
    if (r === undefined || g === undefined || b === undefined) return null;
    const c = (r < 0 ? 0 : r & 0xff) << 16 | (g < 0 ? 0 : g & 0xff) << 8 | (b < 0 ? 0 : b & 0xff);
    return TRUECOLOR | c;
  }

  private applyColor(which: number, color: number | null): void {
    if (color === null) return;
    if (which === 38) this.fg = color;
    else if (which === 48) this.bg = color;
    // 58 = underline colour — not rendered.
  }

  private sgrSimple(v: number): void {
    if (v === 0) { this.fg = this.bg = DEFAULT_COLOR; this.fl = 0; }
    else if (v === 1) this.fl |= BOLD;
    else if (v === 2) this.fl |= DIM;
    else if (v === 3) this.fl |= ITALIC;
    else if (v === 4 || v === 21) this.fl |= UNDERLINE;
    else if (v === 5 || v === 6) this.fl |= BLINK;
    else if (v === 7) this.fl |= INVERSE;
    else if (v === 8) this.fl |= HIDDEN;
    else if (v === 9) this.fl |= STRIKE;
    else if (v === 22) this.fl &= ~(BOLD | DIM);
    else if (v === 23) this.fl &= ~ITALIC;
    else if (v === 24) this.fl &= ~UNDERLINE;
    else if (v === 25) this.fl &= ~BLINK;
    else if (v === 27) this.fl &= ~INVERSE;
    else if (v === 28) this.fl &= ~HIDDEN;
    else if (v === 29) this.fl &= ~STRIKE;
    else if (v >= 30 && v <= 37) this.fg = v - 30;
    else if (v === 39) this.fg = DEFAULT_COLOR;
    else if (v >= 40 && v <= 47) this.bg = v - 40;
    else if (v === 49) this.bg = DEFAULT_COLOR;
    else if (v >= 90 && v <= 97) this.fg = v - 90 + 8;
    else if (v >= 100 && v <= 107) this.bg = v - 100 + 8;
  }

  // ─── OSC ─────────────────────────────────────────────

  private oscDispatch(): void {
    const s = this.oscBuf;
    this.oscBuf = "";
    const semi = s.indexOf(";");
    const id = semi < 0 ? s : s.slice(0, semi);
    const arg = semi < 0 ? "" : s.slice(semi + 1);
    switch (id) {
      case "0": case "2":
        this.title = arg;
        this.opts.onTitle?.(arg);
        break;
      case "10":
      case "11":
        // CLIs ask for the default colours to pick a light or dark theme.
        if (arg === "?") this.respond(`\x1b]${id};${xrgb(id === "10" ? this.defaultFg : this.defaultBg)}\x1b\\`);
        break;
      default:
        // OSC 8 hyperlinks, OSC 52 clipboard (never honoured — a PTY child must
        // not write the user's clipboard), OSC 7 cwd, OSC 133 marks… ignored.
        break;
    }
  }

  // ─── Helpers ─────────────────────────────────────────

  private blankLines(n: number): Line[] {
    const out: Line[] = [];
    for (let i = 0; i < n; i++) out.push(new Line(this.cols));
    return out;
  }

  private resizeRows(buf: Line[], rows: number, isActive: boolean): void {
    const old = buf.length;
    if (rows < old) {
      // Shrinking: keep the cursor on screen by pushing top lines to scrollback
      // (normal buffer only); drop blank lines from the bottom first.
      let excess = old - rows;
      if (isActive) {
        while (excess > 0 && buf.length - 1 > this.cursorY) {
          buf.pop();
          excess--;
        }
      } else {
        buf.splice(rows);
        excess = 0;
      }
      if (excess > 0) {
        const gone = buf.splice(0, excess);
        if (buf === this.normalLines) for (const l of gone) this.pushScrollback(l);
        this.cursorY = Math.max(0, this.cursorY - excess);
      }
    } else if (rows > old) {
      let add = rows - old;
      // Growing the normal screen pulls lines back from scrollback, as xterm does.
      if (isActive && buf === this.normalLines) {
        while (add > 0 && this.scrollback.length > 0) {
          const l = this.scrollback.pop()!;
          l.resize(this.cols);
          buf.unshift(l);
          this.cursorY++;
          add--;
        }
      }
      for (let i = 0; i < add; i++) buf.push(new Line(this.cols));
    }
  }
}
