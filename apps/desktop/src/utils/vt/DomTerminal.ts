/**
 * GitWand's built-in terminal: `VtEmulator` state rendered as plain DOM rows.
 *
 * Why not xterm.js: its WebGL renderer is CPU-rasterized wherever the webview
 * falls back to software GL (common on Linux WebKitGTK), and its DOM renderer
 * rebuilds far more than a typing echo needs. Here each screen row is one
 * `<div>` whose HTML is rebuilt only when that row changed, at most once per
 * animation frame — a keystroke echo touches one row. The browser's own text
 * engine draws the glyphs.
 *
 * The public surface mirrors the slice of xterm.js `TerminalPanel` used, so the
 * panel stays renderer-agnostic.
 */
import {
  VtEmulator, Line, DEFAULT_COLOR, TRUECOLOR,
  BOLD, DIM, ITALIC, UNDERLINE, INVERSE, HIDDEN, STRIKE,
} from "./emulator";
import { keyToSequence } from "./keys";

export interface DomTerminalOptions {
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  /** Shift+Enter → ESC CR (newline in AI CLIs). */
  shiftEnterNewline?: boolean;
  /** Return false to stop the terminal from handling a keydown. */
  customKeyHandler?: (e: KeyboardEvent) => boolean;
  /** Clipboard bridge (the webview's own clipboard API is unreliable in Tauri). */
  readClipboard?: () => Promise<string | null | undefined>;
  writeClipboard?: (text: string) => void;
  /** Ctrl/Cmd+click on a URL. */
  onLinkOpen?: (url: string) => void;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}

type Listener<T> = (v: T) => void;

// xterm.js default (Tango) palette — keeps colours identical to the old renderer.
const ANSI16 = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];
const DEFAULT_FG = "#e5e5e5";
const DEFAULT_BG = "#000000";

const PALETTE: string[] = (() => {
  const out = [...ANSI16];
  const lv = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) out.push(`#${hex(lv[r])}${hex(lv[g])}${hex(lv[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = hex(8 + i * 10);
    out.push(`#${v}${v}${v}`);
  }
  return out;
})();

function colorCss(c: number): string {
  if (c >= TRUECOLOR) return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
  return PALETTE[c & 0xff];
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const WORD_RE = /[\p{L}\p{N}_\-./~:@%+#?=&]/u;

const STYLE_ID = "gw-vt-style";
const CSS = `
.gw-vt{position:relative;width:100%;height:100%;overflow:hidden;color:${DEFAULT_FG};cursor:text;user-select:none;-webkit-user-select:none;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;font-kerning:none;outline:none}
.gw-vt-rows{position:absolute;left:0;top:0;right:0}
.gw-vt-row{white-space:pre;overflow:hidden;contain:strict;width:100%}
.gw-vt-g{display:inline-block;text-align:center;vertical-align:top;overflow:visible}
.gw-vt-sel{background-image:linear-gradient(rgba(110,150,255,.45),rgba(110,150,255,.45))}
.gw-vt-cur{outline:1px solid ${DEFAULT_FG};outline-offset:-1px}
.gw-vt-input{position:absolute;width:1px;height:1px;opacity:0;padding:0;margin:0;border:0;resize:none;overflow:hidden;white-space:nowrap;caret-color:transparent;pointer-events:none}
.gw-vt-thumb{position:absolute;right:1px;width:6px;border-radius:3px;background:rgba(255,255,255,.22);display:none;cursor:default}
.gw-vt-thumb:hover{background:rgba(255,255,255,.4)}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

interface CellStyle {
  cls: string;
  css: string;
  /** `class="…" style="…"`, empty for a default cell. */
  attr: string;
}

interface Selection {
  /** Anchor / head as [line, col], line in "global" coordinates (see globalLine). */
  a: [number, number];
  b: [number, number];
}

export class DomTerminal {
  readonly emu: VtEmulator;
  private opts: DomTerminalOptions;

  private root!: HTMLDivElement;
  private rowsEl!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  private thumb!: HTMLDivElement;
  private rowEls: HTMLDivElement[] = [];
  private rowHtml: string[] = [];

  private cellW = 8;
  private cellH = 16;
  private fontSize: number;
  private fontFamily: string;

  /** Lines scrolled back from the bottom (0 = live view). */
  private viewOffset = 0;
  /** scrollback.length + scrollbackTrimmed at the last render. */
  private lastPushed = 0;
  private raf = 0;
  private syncSince = 0;
  private focused = false;
  private composing = false;
  private disposed = false;

  private sel: Selection | null = null;
  private searchHit: { line: number; from: number } | null = null;

  private dataListeners: Listener<string>[] = [];
  private titleListeners: Listener<string>[] = [];
  private selectionListeners: Listener<void>[] = [];

  private cleanups: Array<() => void> = [];
  private wheelAcc = 0;
  private mouseButtonDown = -1;

  constructor(opts: DomTerminalOptions = {}) {
    this.opts = opts;
    this.fontSize = opts.fontSize ?? 13;
    this.fontFamily = opts.fontFamily
      ?? 'var(--font-mono, "JetBrains Mono"), "DejaVu Sans Mono", Menlo, Consolas, monospace';
    this.emu = new VtEmulator(80, 24, {
      scrollback: opts.scrollback ?? 5000,
      onResponse: (s) => this.emit(this.dataListeners, s),
      onTitle: (t) => this.emit(this.titleListeners, t),
    });
  }

  // ─── xterm-shaped API ────────────────────────────────

  get cols(): number { return this.emu.cols; }
  get rows(): number { return this.emu.rows; }

  onData(cb: Listener<string>): void { this.dataListeners.push(cb); }
  onTitleChange(cb: Listener<string>): void { this.titleListeners.push(cb); }
  onSelectionChange(cb: Listener<void>): void { this.selectionListeners.push(cb); }

  open(parent: HTMLElement): void {
    ensureStyle();
    const root = document.createElement("div");
    root.className = "gw-vt";
    root.style.fontFamily = this.fontFamily;
    root.style.fontSize = this.fontSize + "px";
    const rows = document.createElement("div");
    rows.className = "gw-vt-rows";
    const input = document.createElement("textarea");
    input.className = "gw-vt-input";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("aria-label", "Terminal input");
    const thumb = document.createElement("div");
    thumb.className = "gw-vt-thumb";
    root.append(rows, input, thumb);
    parent.appendChild(root);
    this.root = root;
    this.rowsEl = rows;
    this.input = input;
    this.thumb = thumb;

    this.measure();
    this.bindEvents();
    // A web font finishing its load changes the cell metrics.
    document.fonts?.ready.then(() => {
      if (this.disposed) return;
      this.measure();
      this.fit();
    });
    this.fit();
  }

  write(data: string): void {
    if (this.disposed) return;
    const wasSync = this.emu.modes.syncOutput;
    this.emu.write(data);
    if (this.emu.modes.syncOutput && !wasSync) this.syncSince = performance.now();
    this.scheduleRender();
  }

  /** Paste text as the user would — bracketed when the app asked for it. */
  paste(text: string): void {
    if (!text) return;
    let data = text.replace(/\r?\n/g, "\r");
    if (this.emu.modes.bracketedPaste) {
      // Strip any embedded end marker so pasted text can't break out of the bracket.
      data = "\x1b[200~" + data.replace(/\x1b\[201~/g, "") + "\x1b[201~";
    }
    this.sendInput(data);
  }

  focus(): void { this.input?.focus({ preventScroll: true }); }

  clear(): void {
    this.emu.clear();
    this.viewOffset = 0;
    this.clearSelection();
    this.scheduleRender();
  }

  /** Measure the host and resize the grid. Returns true when it has a real size. */
  fit(): boolean {
    if (!this.root) return false;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (!w || !h) return false;
    const cols = Math.max(2, Math.floor(w / this.cellW));
    const rows = Math.max(1, Math.floor(h / this.cellH));
    if (cols !== this.emu.cols || rows !== this.emu.rows || this.rowEls.length !== rows) {
      this.emu.resize(cols, rows);
      this.buildRows();
      this.viewOffset = Math.min(this.viewOffset, this.emu.scrollback.length);
    }
    this.renderNow();
    return true;
  }

  setFontSize(px: number): void {
    if (px === this.fontSize || !this.root) return;
    this.fontSize = px;
    this.root.style.fontSize = px + "px";
    this.measure();
    this.fit();
  }

  getSelection(): string {
    const r = this.selRange();
    if (!r) return "";
    const out: string[] = [];
    for (let g = r.start[0]; g <= r.end[0]; g++) {
      const line = this.emu.lineAt(this.localLine(g));
      if (!line) continue;
      const from = g === r.start[0] ? r.start[1] : 0;
      const to = g === r.end[0] ? r.end[1] + 1 : line.length;
      let text = line.text(from, to);
      const continues = line.wrapped && g !== r.end[0];
      if (!continues) text = text.replace(/\s+$/, "");
      out.push(text + (continues || g === r.end[0] ? "" : "\n"));
    }
    return out.join("");
  }

  selectAll(): void {
    const last = this.emu.totalLines - 1;
    this.sel = { a: [this.globalLine(0), 0], b: [this.globalLine(last), this.emu.cols - 1] };
    this.emu.markAllDirty();
    this.scheduleRender();
    this.emit(this.selectionListeners, undefined);
  }

  clearSelection(): void {
    if (!this.sel) return;
    this.sel = null;
    this.emu.markAllDirty();
    this.scheduleRender();
  }

  findNext(query: string, opts: SearchOptions = {}): boolean { return this.find(query, opts, 1); }
  findPrevious(query: string, opts: SearchOptions = {}): boolean { return this.find(query, opts, -1); }

  /** Repaint everything (after re-show). */
  refresh(): void {
    this.emu.markAllDirty();
    this.renderNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.root?.remove();
    this.dataListeners = [];
    this.titleListeners = [];
    this.selectionListeners = [];
  }

  // ─── Layout ──────────────────────────────────────────

  private measure(): void {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;line-height:normal";
    probe.textContent = "W".repeat(64);
    this.root.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    if (rect.width > 0) this.cellW = rect.width / 64;
    if (rect.height > 0) this.cellH = Math.ceil(rect.height);
    this.emu.cellPixelWidth = Math.round(this.cellW);
    this.emu.cellPixelHeight = this.cellH;
    this.rowsEl.style.lineHeight = this.cellH + "px";
    for (const el of this.rowEls) el.style.height = this.cellH + "px";
    this.rowHtml.fill("");
  }

  private buildRows(): void {
    const n = this.emu.rows;
    while (this.rowEls.length < n) {
      const el = document.createElement("div");
      el.className = "gw-vt-row";
      el.style.height = this.cellH + "px";
      this.rowsEl.appendChild(el);
      this.rowEls.push(el);
      this.rowHtml.push("");
    }
    while (this.rowEls.length > n) {
      this.rowEls.pop()!.remove();
      this.rowHtml.pop();
    }
    this.rowHtml.fill("\0"); // force a repaint of every row
  }

  // ─── Rendering ───────────────────────────────────────

  private scheduleRender(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      // DEC 2026: the app is mid-frame. Hold the paint (bounded, in case the
      // end marker never comes) so a full-screen redraw never shows half-drawn.
      if (this.emu.modes.syncOutput && performance.now() - this.syncSince < 150) {
        this.scheduleRender();
        return;
      }
      this.renderNow();
    });
  }

  private renderNow(): void {
    if (this.disposed || !this.root) return;
    const emu = this.emu;
    const dirty = emu.takeDirty();

    // Keep a scrolled-back view anchored on the same text while output flows.
    const pushed = emu.scrollback.length + emu.scrollbackTrimmed;
    if (emu.altScreen) this.viewOffset = 0;
    else if (this.viewOffset > 0 && pushed !== this.lastPushed) {
      this.viewOffset = Math.min(this.viewOffset + (pushed - this.lastPushed), emu.scrollback.length);
      dirty.all = true;
    }
    this.lastPushed = pushed;

    const top = emu.scrollback.length - this.viewOffset;
    const showCursor = this.viewOffset === 0 && emu.modes.cursorVisible;
    const range = this.selRange();

    for (let y = 0; y < this.rowEls.length; y++) {
      const html = this.buildRow(emu.lineAt(top + y), top + y, showCursor && y === emu.cursorY ? emu.cursorX : -1, range);
      if (html !== this.rowHtml[y]) {
        this.rowHtml[y] = html;
        this.rowEls[y].innerHTML = html;
      }
    }

    // Park the hidden input on the cursor so IME popups appear in place.
    this.input.style.left = emu.cursorX * this.cellW + "px";
    this.input.style.top = emu.cursorY * this.cellH + "px";
    this.updateThumb();
  }

  private buildRow(
    line: Line | undefined,
    abs: number,
    cursorX: number,
    range: { start: [number, number]; end: [number, number] } | null,
  ): string {
    const cols = this.emu.cols;
    if (!line) return "";
    const g = this.globalLine(abs);
    let selFrom = -1;
    let selTo = -1;
    if (range && g >= range.start[0] && g <= range.end[0]) {
      selFrom = g === range.start[0] ? range.start[1] : 0;
      selTo = g === range.end[0] ? range.end[1] : cols - 1;
    }
    let hitFrom = -1;
    let hitTo = -1;
    const hit = this.searchHit;
    if (hit && hit.line === g && this.searchLen > 0) {
      hitFrom = hit.from;
      hitTo = hit.from + this.searchLen - 1;
    }

    let out = "";
    let runStyle = "";
    let runText = "";
    const flush = () => {
      if (!runText) return;
      out += runStyle ? `<span ${runStyle}>${escapeHtml(runText)}</span>` : escapeHtml(runText);
      runText = "";
    };

    for (let x = 0; x < cols; x++) {
      const inLine = x < line.length;
      const ch = inLine ? line.ch[x] : " ";
      if (ch === "") continue; // right half of a wide char
      const wide = inLine && x + 1 < line.length && line.ch[x + 1] === "";
      let fl = inLine ? line.fl[x] : 0;
      if (x === cursorX && this.focused) fl ^= INVERSE;
      const extra =
        (x >= selFrom && x <= selTo ? " gw-vt-sel" : "") +
        (x >= hitFrom && x <= hitTo ? " gw-vt-sel" : "") +
        (x === cursorX && !this.focused ? " gw-vt-cur" : "");
      const st = this.cellStyle(
        inLine ? line.fg[x] : DEFAULT_COLOR,
        inLine ? line.bg[x] : DEFAULT_COLOR,
        fl,
        extra,
      );
      // Glyphs outside the font's Latin coverage (box drawing, braille spinners,
      // symbols, CJK, emoji) often come from fallback fonts with a different
      // advance — pin each one to its cell so the grid never drifts.
      if (wide || ch.codePointAt(0)! >= 0x2000) {
        flush();
        const width = (wide ? 2 : 1) * this.cellW;
        out += `<span class="gw-vt-g${st.cls ? " " + st.cls : ""}" style="width:${width}px;${st.css}">${escapeHtml(ch)}</span>`;
        runStyle = "";
        continue;
      }
      const style = st.attr;
      if (style !== runStyle) {
        flush();
        runStyle = style;
      }
      runText += ch;
    }
    flush();
    return out;
  }

  private styleCache = new Map<string, CellStyle>();

  /** Class list, inline CSS and the combined attribute string for a cell (cached). */
  private cellStyle(fg: number, bg: number, fl: number, extra: string): CellStyle {
    const key = `${fg}|${bg}|${fl}|${extra}`;
    const hit = this.styleCache.get(key);
    if (hit) return hit;

    if (fl & BOLD && fg >= 0 && fg < 8) fg += 8; // bold-as-bright, like xterm.js
    let fgCss = fg === DEFAULT_COLOR ? "" : colorCss(fg);
    let bgCss = bg === DEFAULT_COLOR ? "" : colorCss(bg);
    if (fl & INVERSE) {
      const f = fgCss || DEFAULT_FG;
      fgCss = bgCss || DEFAULT_BG;
      bgCss = f;
    }
    if (fl & HIDDEN) fgCss = "transparent";
    let css = "";
    if (fgCss) css += `color:${fgCss};`;
    if (bgCss) css += `background-color:${bgCss};`;
    if (fl & BOLD) css += "font-weight:bold;";
    if (fl & ITALIC) css += "font-style:italic;";
    if (fl & DIM) css += "opacity:.6;";
    const deco = (fl & UNDERLINE ? " underline" : "") + (fl & STRIKE ? " line-through" : "");
    if (deco) css += `text-decoration:${deco.trim()};`;

    const cls = extra.trim();
    const attr = (cls ? `class="${cls}"` : "") + (cls && css ? " " : "") + (css ? `style="${css}"` : "");
    const st: CellStyle = { cls, css, attr };
    if (this.styleCache.size > 4096) this.styleCache.clear();
    this.styleCache.set(key, st);
    return st;
  }

  private updateThumb(): void {
    const sb = this.emu.scrollback.length;
    if (sb === 0 || this.emu.altScreen) {
      this.thumb.style.display = "none";
      return;
    }
    const total = sb + this.emu.rows;
    const h = this.root.clientHeight;
    const thumbH = Math.max(20, (this.emu.rows / total) * h);
    const topLine = sb - this.viewOffset;
    this.thumb.style.display = "block";
    this.thumb.style.height = thumbH + "px";
    this.thumb.style.top = (topLine / sb) * (h - thumbH) + "px";
  }

  // ─── Coordinates ─────────────────────────────────────

  /** Absolute (scrollback ++ screen) index → stable index that survives trimming. */
  private globalLine(abs: number): number { return abs + this.emu.scrollbackTrimmed; }
  private localLine(g: number): number { return g - this.emu.scrollbackTrimmed; }

  private cellAt(e: MouseEvent): { x: number; y: number } {
    const rect = this.rowsEl.getBoundingClientRect();
    return {
      x: Math.min(Math.max(Math.floor((e.clientX - rect.left) / this.cellW), 0), this.emu.cols - 1),
      y: Math.floor((e.clientY - rect.top) / this.cellH),
    };
  }

  private viewTop(): number {
    return this.emu.scrollback.length - this.viewOffset;
  }

  private scrollBy(lines: number): void {
    const max = this.emu.scrollback.length;
    const next = Math.min(Math.max(this.viewOffset + lines, 0), max);
    if (next === this.viewOffset) return;
    this.viewOffset = next;
    this.emu.markAllDirty();
    this.scheduleRender();
  }

  private scrollToBottom(): void {
    if (this.viewOffset !== 0) this.scrollBy(-this.viewOffset);
  }

  // ─── Selection ───────────────────────────────────────

  private selRange(): { start: [number, number]; end: [number, number] } | null {
    if (!this.sel) return null;
    const { a, b } = this.sel;
    const before = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
    return before ? { start: a, end: b } : { start: b, end: a };
  }

  private wordBounds(g: number, x: number): [number, number] {
    const line = this.emu.lineAt(this.localLine(g));
    if (!line) return [x, x];
    const isWord = (i: number) => i >= 0 && i < line.length && WORD_RE.test(line.ch[i] || "x");
    if (!isWord(x)) return [x, x];
    let s = x;
    let e = x;
    while (isWord(s - 1)) s--;
    while (isWord(e + 1)) e++;
    return [s, e];
  }

  // ─── Search ──────────────────────────────────────────

  private searchLen = 0;

  private find(query: string, opts: SearchOptions, dir: 1 | -1): boolean {
    if (!query) return false;
    const total = this.emu.totalLines;
    let re: RegExp;
    try {
      const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(src, opts.caseSensitive ? "g" : "gi");
    } catch {
      return false;
    }
    const prev = this.searchHit;
    let startAbs = prev ? this.localLine(prev.line) : dir === 1 ? 0 : total - 1;
    const startCol = prev ? prev.from : dir === 1 ? -1 : Number.MAX_SAFE_INTEGER;
    if (startAbs < 0 || startAbs >= total) startAbs = dir === 1 ? 0 : total - 1;

    for (let k = 0; k <= total; k++) {
      const abs = ((startAbs + k * dir) % total + total) % total;
      const line = this.emu.lineAt(abs);
      if (!line) continue;
      const { text, cols } = lineTextCols(line);
      const hits: Array<{ col: number; len: number }> = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const endIdx = m.index + m[0].length - 1;
        hits.push({ col: cols[m.index], len: cols[endIdx] - cols[m.index] + 1 });
      }
      if (!hits.length) continue;
      const candidates = k === 0
        ? hits.filter((h) => (dir === 1 ? h.col > startCol : h.col < startCol))
        : hits;
      if (!candidates.length) continue;
      const pick = dir === 1 ? candidates[0] : candidates[candidates.length - 1];
      this.searchHit = { line: this.globalLine(abs), from: pick.col };
      this.searchLen = pick.len;
      this.revealLine(abs);
      this.emu.markAllDirty();
      this.scheduleRender();
      return true;
    }
    this.searchHit = null;
    this.searchLen = 0;
    this.emu.markAllDirty();
    this.scheduleRender();
    return false;
  }

  private revealLine(abs: number): void {
    const top = this.viewTop();
    if (abs >= top && abs < top + this.emu.rows) return;
    const sb = this.emu.scrollback.length;
    // Centre the line in the viewport.
    const wantTop = Math.max(0, Math.min(abs - (this.emu.rows >> 1), sb));
    this.viewOffset = sb - wantTop;
  }

  // ─── Input ───────────────────────────────────────────

  private sendInput(data: string): void {
    this.scrollToBottom();
    if (this.searchHit) {
      this.searchHit = null;
      this.emu.markAllDirty();
      this.scheduleRender();
    }
    this.emit(this.dataListeners, data);
  }

  private emit<T>(list: Listener<T>[], v: T): void {
    for (const cb of list) cb(v);
  }

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement | Window,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private bindEvents(): void {
    const input = this.input;

    this.on(input, "keydown", (e) => this.onKeyDown(e));
    this.on(input, "compositionstart", () => { this.composing = true; });
    this.on(input, "compositionend", (e) => {
      this.composing = false;
      const data = (e as CompositionEvent).data;
      if (data) this.sendInput(data);
      input.value = "";
    });
    this.on(input, "input", (e) => {
      // Text the keydown path did not send itself (dead keys, on-screen keyboards).
      if (this.composing || (e as InputEvent).isComposing) return;
      const v = input.value;
      input.value = "";
      if (v) this.sendInput(v);
    });
    this.on(input, "paste", (e) => {
      e.preventDefault();
      const text = (e as ClipboardEvent).clipboardData?.getData("text/plain");
      if (text) this.paste(text);
    });
    this.on(input, "focus", () => this.setFocused(true));
    this.on(input, "blur", () => this.setFocused(false));

    this.on(this.root, "mousedown", (e) => this.onMouseDown(e));
    this.on(this.root, "wheel", (e) => this.onWheel(e), { passive: false });
    this.on(this.thumb, "mousedown", (e) => this.onThumbDown(e));
  }

  private setFocused(on: boolean): void {
    if (this.focused === on) return;
    this.focused = on;
    if (this.emu.modes.focusEvents) this.emit(this.dataListeners, on ? "\x1b[I" : "\x1b[O");
    this.emu.markAllDirty();
    this.scheduleRender();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.opts.customKeyHandler && this.opts.customKeyHandler(e) === false) return;
    const k = e.key.toLowerCase();

    // Copy / paste chords that must not reach the PTY.
    const copyChord = (IS_MAC && e.metaKey && !e.ctrlKey && k === "c") || (e.ctrlKey && e.shiftKey && k === "c");
    const pasteChord = (IS_MAC && e.metaKey && !e.ctrlKey && k === "v") || (e.ctrlKey && e.shiftKey && k === "v");
    if (copyChord) {
      e.preventDefault();
      const s = this.getSelection();
      if (s) this.opts.writeClipboard?.(s);
      return;
    }
    if (pasteChord) {
      e.preventDefault();
      this.opts.readClipboard?.().then((t) => { if (t) this.paste(t); });
      return;
    }

    // Shift+PageUp/PageDown/Home/End scroll the local scrollback.
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !this.emu.altScreen) {
      const page = Math.max(1, this.emu.rows - 1);
      const move =
        e.key === "PageUp" ? page :
        e.key === "PageDown" ? -page :
        e.key === "Home" ? this.emu.scrollback.length :
        e.key === "End" ? -this.viewOffset : 0;
      if (move !== 0 || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        this.scrollBy(move);
        return;
      }
    }

    const seq = keyToSequence(e, {
      appCursor: this.emu.modes.appCursor,
      isMac: IS_MAC,
      shiftEnterNewline: this.opts.shiftEnterNewline,
    });
    if (seq === null) return;
    e.preventDefault();
    this.sendInput(seq);
  }

  // ─── Mouse ───────────────────────────────────────────

  private mouseReport(button: number, x: number, y: number, release: boolean, e: MouseEvent): void {
    const mods = (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0) | (e.ctrlKey ? 16 : 0);
    const b = button | mods;
    if (this.emu.modes.sgrMouse) {
      this.emit(this.dataListeners, `\x1b[<${b};${x + 1};${y + 1}${release ? "m" : "M"}`);
      return;
    }
    const code = release ? 3 | mods | (button & 32) : b;
    const enc = (n: number) => String.fromCharCode(Math.min(n, 222) + 33);
    this.emit(this.dataListeners, `\x1b[M${String.fromCharCode(code + 32)}${enc(x)}${enc(y)}`);
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.target === this.thumb) return;
    const { x, y } = this.cellAt(e);
    const tracking = this.emu.modes.mouseTracking;

    if (tracking && !e.shiftKey && this.viewOffset === 0) {
      e.preventDefault();
      this.focus();
      if (e.button > 2) return;
      this.mouseReport(e.button, x, y, false, e);
      if (tracking === 9) return;
      this.mouseButtonDown = e.button;
      let lastX = x;
      let lastY = y;
      const move = (ev: MouseEvent) => {
        if (tracking !== 1002 && tracking !== 1003) return;
        const c = this.cellAt(ev);
        const cy = Math.min(Math.max(c.y, 0), this.emu.rows - 1);
        if (c.x === lastX && cy === lastY) return;
        lastX = c.x;
        lastY = cy;
        this.mouseReport(this.mouseButtonDown + 32, c.x, cy, false, ev);
      };
      const up = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const c = this.cellAt(ev);
        this.mouseReport(this.mouseButtonDown, c.x, Math.min(Math.max(c.y, 0), this.emu.rows - 1), true, ev);
        this.mouseButtonDown = -1;
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      return;
    }

    if (e.button !== 0) {
      this.focus();
      return;
    }
    e.preventDefault();
    this.focus();

    const abs = this.viewTop() + Math.min(Math.max(y, 0), this.emu.rows - 1);
    if ((e.ctrlKey || e.metaKey) && this.tryOpenLink(abs, x)) return;

    const g = this.globalLine(abs);
    if (e.detail === 2) {
      const [s, en] = this.wordBounds(g, x);
      this.sel = { a: [g, s], b: [g, en] };
      this.emu.markAllDirty();
      this.scheduleRender();
      this.emit(this.selectionListeners, undefined);
      return;
    }
    if (e.detail >= 3) {
      this.sel = { a: [g, 0], b: [g, this.emu.cols - 1] };
      this.emu.markAllDirty();
      this.scheduleRender();
      this.emit(this.selectionListeners, undefined);
      return;
    }

    const hadSel = this.sel !== null;
    this.sel = null;
    let moved = false;
    const anchor: [number, number] = [g, x];
    const move = (ev: MouseEvent) => {
      const c = this.cellAt(ev);
      // Dragging past the edge scrolls the scrollback.
      if (c.y < 0) this.scrollBy(1);
      else if (c.y >= this.emu.rows) this.scrollBy(-1);
      const cy = Math.min(Math.max(c.y, 0), this.emu.rows - 1);
      const head: [number, number] = [this.globalLine(this.viewTop() + cy), c.x];
      if (!moved && head[0] === anchor[0] && head[1] === anchor[1]) return;
      moved = true;
      this.sel = { a: anchor, b: head };
      this.emu.markAllDirty();
      this.scheduleRender();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved || hadSel) this.emit(this.selectionListeners, undefined);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    if (hadSel) {
      this.emu.markAllDirty();
      this.scheduleRender();
    }
  }

  private tryOpenLink(abs: number, x: number): boolean {
    if (!this.opts.onLinkOpen) return false;
    const line = this.emu.lineAt(abs);
    if (!line) return false;
    const { text, cols } = lineTextCols(line);
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text))) {
      const url = m[0].replace(/[.,;:!?)\]}>'"]+$/, "");
      const from = cols[m.index];
      const to = cols[m.index + url.length - 1];
      if (x >= from && x <= to) {
        this.opts.onLinkOpen(url);
        return true;
      }
    }
    return false;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * this.cellH : e.deltaMode === 2 ? e.deltaY * this.root.clientHeight : e.deltaY;
    this.wheelAcc += px;
    const lines = Math.trunc(this.wheelAcc / this.cellH);
    if (lines === 0) return;
    this.wheelAcc -= lines * this.cellH;

    const tracking = this.emu.modes.mouseTracking;
    if (tracking && !e.shiftKey) {
      const { x, y } = this.cellAt(e);
      const button = lines < 0 ? 64 : 65;
      const n = Math.min(Math.abs(lines), 10);
      for (let i = 0; i < n; i++) this.mouseReport(button, x, Math.min(Math.max(y, 0), this.emu.rows - 1), false, e);
      return;
    }
    if (this.emu.altScreen) {
      // Alternate-scroll: full-screen apps without mouse support get arrows.
      const seq = this.emu.modes.appCursor ? (lines < 0 ? "\x1bOA" : "\x1bOB") : (lines < 0 ? "\x1b[A" : "\x1b[B");
      this.emit(this.dataListeners, seq.repeat(Math.min(Math.abs(lines), 10)));
      return;
    }
    this.scrollBy(-lines);
  }

  private onThumbDown(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startOffset = this.viewOffset;
    const sb = this.emu.scrollback.length;
    const track = this.root.clientHeight - this.thumb.offsetHeight;
    const move = (ev: MouseEvent) => {
      if (track <= 0) return;
      const lines = Math.round(((ev.clientY - startY) / track) * sb);
      this.scrollBy(startOffset - lines - this.viewOffset);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
}

/** Line text plus, for each UTF-16 index, the cell column it came from. */
export function lineTextCols(line: Line): { text: string; cols: number[] } {
  let text = "";
  const cols: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const ch = line.ch[x];
    if (ch === "") continue;
    text += ch;
    for (let k = 0; k < ch.length; k++) cols.push(x);
  }
  return { text, cols };
}
