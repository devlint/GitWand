import { describe, expect, it } from "vitest";

import { DOORS, parseInline } from "../advent/index.js";
import {
  renderDoor,
  renderInvalid,
  renderLocked,
  renderNotStarted,
  renderOver,
  type Palette,
} from "../advent-render.js";

const plain: Palette = {
  reset: "",
  bold: "",
  dim: "",
  green: "",
  yellow: "",
  red: "",
  cyan: "",
  magenta: "",
};
const ansi: Palette = {
  reset: "<R>",
  bold: "<B>",
  dim: "<D>",
  green: "<G>",
  yellow: "<Y>",
  red: "<E>",
  cyan: "<C>",
  magenta: "<M>",
};

const door12 = DOORS.find((d) => d.day === 12)!;
const door1 = DOORS.find((d) => d.day === 1)!;
const stripTip = (t: string): string =>
  parseInline(t)
    .map((s) => s.text)
    .join("");

describe("renderDoor", () => {
  it("renders the full layout at width 80", () => {
    const out = renderDoor(door12, { palette: plain, width: 80 });
    expect(out).toContain("★");
    expect(out).toContain(`Day 12 · ${door12.command}`);
    expect(out.replace(/\s+/g, " ")).toContain(`"${stripTip(door12.problem)}"`);
    for (const line of door12.snippet.split("\n")) expect(out).toContain(`$ ${line}`);
    // tip text, whitespace-normalised because it may wrap
    const flat = out.replace(/\s+/g, " ");
    expect(flat).toContain(`🪄 ${stripTip(door12.tip!)}`.replace(/\s+/g, " "));
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines[lines.length - 1].trim()).toBe("12/24 · all doors: https://gitwand.app/advent/12");
  });

  it("drops the tree below 72 columns", () => {
    expect(renderDoor(door12, { palette: plain, width: 60 })).not.toContain("★");
  });

  it("never exceeds the width, except snippets and the footer", () => {
    for (const width of [80, 60, 40]) {
      for (const door of DOORS) {
        const out = renderDoor(door, { palette: plain, width });
        for (const line of out.split("\n")) {
          if (line.trimStart().startsWith("$ ") || line.includes("all doors:")) continue;
          if (/\bhttps?:\/\/\S+/.test(line)) continue;
          expect(line.length, `day ${door.day} @${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("keeps snippet lines unbroken at width 40", () => {
    const out = renderDoor(door12, { palette: plain, width: 40 });
    for (const line of door12.snippet.split("\n")) expect(out).toContain(`$ ${line}`);
  });

  it("emits no escape with the plain palette", () => {
    expect(renderDoor(door12, { palette: plain, width: 80 })).not.toContain("\x1b");
  });

  it("wraps code segments in the palette cyan", () => {
    const out = renderDoor(door12, { palette: ansi, width: 80 });
    expect(out).toContain("<C>HEAD<R>");
  });

  it("has no wand line for a door without a tip", () => {
    const out = renderDoor(door1, { palette: plain, width: 80 });
    // only the header carries the wand
    expect(out.split("\n").filter((l) => l.includes("🪄"))).toHaveLength(1);
    expect(out.split("\n").some((l) => l.trimStart().startsWith("🪄"))).toBe(false);
  });
});

describe("status messages", () => {
  it("renders the fixed copy", () => {
    expect(renderLocked(18, plain)).toBe("Patience — door 18 opens on December 18 🎁");
    expect(renderNotStarted(plain)).toBe(
      "The GitWand Advent Calendar starts on December 1, 2026. Meanwhile: https://gitwand.app/advent",
    );
    expect(renderOver(plain)).toBe(
      "The calendar is over — every door is open: gitwand advent <1-24> or https://gitwand.app/advent",
    );
    expect(renderInvalid("31", plain)).toBe('Unknown door "31" — pick a day from 1 to 24.');
  });
});
