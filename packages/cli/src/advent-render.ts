/**
 * ASCII rendering of an advent door and of the calendar status messages.
 * Pure string building: the caller passes the palette (so tests and CI can
 * use a blank one) and the terminal width.
 */

import { ADVENT_YEAR, DOOR_COUNT, doorUrl, parseInline, type AdventDoor } from "./advent/index.js";
import type { c } from "./ui.js";

export type Palette = typeof c;

/** Below this width the tree is dropped and the text uses the full line. */
export const TREE_MIN_WIDTH = 72;

const GUTTER = 19;
const TREE: string[] = ["        ★", "       /*\\", "      /*o*\\", "     /o*~*o\\", "    /*~o*~o*\\", "       |_|"];

interface Piece {
  kind: "text" | "code" | "strong";
  text: string;
}

/**
 * Split styled segments into whitespace-separated words (pieces kept for
 * styling). An inline code span is atomic: its inner spaces never break it.
 */
function tokenize(text: string): Piece[][] {
  const words: Piece[][] = [];
  let cur: Piece[] = [];
  for (const seg of parseInline(text)) {
    if (seg.kind === "code") {
      cur.push({ kind: "code", text: seg.text });
      continue;
    }
    let buf = "";
    const flush = (): void => {
      if (buf) cur.push({ kind: seg.kind, text: buf });
      buf = "";
    };
    for (const ch of seg.text) {
      if (/\s/.test(ch)) {
        flush();
        if (cur.length) words.push(cur);
        cur = [];
      } else {
        buf += ch;
      }
    }
    flush();
  }
  if (cur.length) words.push(cur);
  return words;
}

const wordLen = (w: Piece[]): number => w.reduce((n, p) => n + p.text.length, 0);

function styleWord(w: Piece[], p: Palette): string {
  return w
    .map((piece) => {
      if (piece.kind === "code") return `${p.cyan}${piece.text}${p.reset}`;
      if (piece.kind === "strong") return `${p.bold}${piece.text}${p.reset}`;
      return piece.text;
    })
    .join("");
}

/**
 * Wrap at word boundaries to `columns`. A word longer than the column
 * overflows on its own line rather than being split.
 */
function wrap(text: string, columns: number, p: Palette): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let len = 0;
  for (const word of tokenize(text)) {
    const wl = wordLen(word);
    if (line.length && len + 1 + wl > columns) {
      lines.push(line.join(" "));
      line = [];
      len = 0;
    }
    len += (line.length ? 1 : 0) + wl;
    line.push(styleWord(word, p));
  }
  if (line.length) lines.push(line.join(" "));
  return lines;
}

/** `$ ` + command in green; a trailing ` # comment` (or a whole `#` line) dimmed. */
function styleSnippetLine(line: string, p: Palette): string {
  if (line.startsWith("#")) return `${p.dim}$ ${line}${p.reset}`;
  const m = /\s+#/.exec(line);
  if (!m) return `${p.green}$ ${line}${p.reset}`;
  const cmd = line.slice(0, m.index);
  const comment = line.slice(m.index);
  return `${p.green}$ ${cmd}${p.reset}${p.dim}${comment}${p.reset}`;
}

export function renderDoor(door: AdventDoor, opts: { palette: Palette; width: number }): string {
  const { palette: p, width } = opts;
  const withTree = width >= TREE_MIN_WIDTH;
  const gutter = withTree ? GUTTER : 2;
  const textCols = withTree ? width - GUTTER : width - 4;
  const edge = withTree ? 3 : 2;

  // Text column, one entry per output row.
  const col: string[] = [];
  col.push(`${p.magenta}${p.bold}🪄 GitWand Advent Calendar${p.reset}`);
  col.push("");
  for (const l of wrap(`Day ${door.day} · ${door.command}`, textCols, p)) {
    col.push(`${p.bold}${l}${p.reset}`);
  }
  col.push("");
  const problem = wrap(`"${door.problem}"`, textCols, p);
  col.push(...problem);
  col.push("");
  for (const line of door.snippet.split("\n")) {
    const text = `$ ${line}`;
    col.push(styleSnippetLine(line, p));
  }
  col.push("");
  col.push(...wrap(door.explanation, textCols, p));

  const out: string[] = [];
  const rows = withTree ? Math.max(col.length, TREE.length) : col.length;
  for (let i = 0; i < rows; i++) {
    const text = col[i] ?? "";
    if (!withTree) {
      out.push(text ? " ".repeat(gutter) + text : "");
      continue;
    }
    const raw = TREE[i] ?? "";
    let tree = raw;
    if (raw.includes("★")) {
      tree = raw.replace("★", `${p.yellow}★${p.reset}${p.green}`);
      tree = `${p.green}${tree}${p.reset}`;
    } else if (raw) {
      tree = `${p.green}${raw}${p.reset}`;
    }
    const pad = " ".repeat(Math.max(0, GUTTER - raw.length));
    out.push(text ? tree + pad + text : tree);
  }

  out.push("");
  if (door.tip) {
    const lines = wrap(door.tip, width - edge - 3, p);
    lines.forEach((l, i) => out.push(" ".repeat(edge) + (i === 0 ? "🪄 " : "   ") + l));
    out.push("");
  }
  out.push(
    `${" ".repeat(edge)}${p.dim}${door.day}/${DOOR_COUNT} · all doors: ${doorUrl()}/${door.day}${p.reset}`,
  );
  return out.map((l) => l.replace(/\s+$/, "")).join("\n");
}

export function renderLocked(day: number, p: Palette): string {
  return `${p.yellow}Patience — door ${day} opens on December ${day} 🎁${p.reset}`;
}

export function renderNotStarted(p: Palette): string {
  return `The GitWand Advent Calendar starts on December 1, ${ADVENT_YEAR}. Meanwhile: ${p.cyan}${doorUrl()}${p.reset}`;
}

export function renderOver(p: Palette): string {
  return `The calendar is over — every door is open: ${p.cyan}gitwand advent <1-${DOOR_COUNT}>${p.reset} or ${p.cyan}${doorUrl()}${p.reset}`;
}

export function renderInvalid(arg: string, p: Palette): string {
  return `${p.red}Unknown door "${arg.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")}" — pick a day from 1 to ${DOOR_COUNT}.${p.reset}`;
}
