import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DOORS } from "../advent/doors.js";
import { TIP_EVIDENCE } from "./fixtures/advent-evidence.js";
import { parseInline } from "../advent/inline.js";

const ROOT = new URL("../../../../", import.meta.url);
const exists = (rel: string): boolean => existsSync(new URL(rel, ROOT));
const resolveEvidencePath = (path: string): string | null =>
  [path, `apps/desktop/src/${path}`, `apps/desktop/${path}`].find(exists) ?? null;
/** Lines in `text`; a trailing newline ends the last line, it does not start a new one. */
const countLines = (text: string): number =>
  text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
const lineCount = (rel: string): number => countLines(readFileSync(new URL(rel, ROOT), "utf8"));

describe("countLines", () => {
  it("does not count a trailing newline as a line", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\n\n")).toBe(2);
    expect(countLines("")).toBe(0);
  });
});

describe("advent doors content", () => {
  it("has 24 doors numbered 1..24", () => {
    expect(DOORS.length).toBe(24);
    DOORS.forEach((d, i) => expect(d.day).toBe(i + 1));
  });

  it("fills the required fields", () => {
    for (const d of DOORS) {
      expect(d.command.trim(), `day ${d.day} command`).not.toBe("");
      expect(d.problem.trim(), `day ${d.day} problem`).not.toBe("");
      expect(d.snippet.trim(), `day ${d.day} snippet`).not.toBe("");
      expect(d.explanation.trim(), `day ${d.day} explanation`).not.toBe("");
    }
  });

  it("backs every tip with evidence that still resolves", () => {
    for (const d of DOORS) {
      if (d.tip === undefined) continue;
      const evidence = TIP_EVIDENCE[d.day] ?? [];
      expect(evidence.length, `day ${d.day} evidence`).toBeGreaterThan(0);
      for (const entry of evidence) {
        const path = entry.split(/[ :]/)[0];
        const resolved = resolveEvidencePath(path);
        expect(resolved, `day ${d.day} evidence path "${path}"`).not.toBeNull();
        const line = /^[^ :]+:(\d+)/.exec(entry)?.[1];
        if (line !== undefined && resolved !== null) {
          expect(
            Number(line),
            `day ${d.day} evidence "${entry}" points past the end of ${resolved}`,
          ).toBeLessThanOrEqual(lineCount(resolved));
        }
      }
    }
  });

  it("has no evidence for a door without a tip", () => {
    const withTip = new Set(DOORS.filter((d) => d.tip !== undefined).map((d) => d.day));
    for (const key of Object.keys(TIP_EVIDENCE)) {
      expect(withTip.has(Number(key)), `TIP_EVIDENCE[${key}] without a tip`).toBe(true);
    }
  });

  it("keeps evidence off the doors themselves", () => {
    for (const d of DOORS) expect("tipEvidence" in d, `day ${d.day}`).toBe(false);
  });

  it("keeps tips and explanations free of ad copy", () => {
    const hype = /revolution|game[- ]?changer|seamless|effortless|supercharge|blazing/i;
    for (const d of DOORS) {
      if (d.tip !== undefined) {
        expect(d.tip.includes("!"), `day ${d.day} tip has !`).toBe(false);
        expect(hype.test(d.tip), `day ${d.day} tip hype`).toBe(false);
      }
      expect(hype.test(d.explanation), `day ${d.day} explanation hype`).toBe(false);
    }
  });

  it("points readMore at an existing website page", () => {
    for (const d of DOORS) {
      if (d.readMore === undefined) continue;
      const ok = exists(`website${d.readMore}.md`) || exists(`website${d.readMore}/index.md`);
      expect(ok, `day ${d.day} readMore ${d.readMore}`).toBe(true);
    }
  });

  it("has balanced inline markup", () => {
    for (const d of DOORS) {
      for (const text of [d.explanation, d.tip]) {
        if (text === undefined) continue;
        for (const seg of parseInline(text)) {
          expect(seg.text.includes("`") || seg.text.includes("**"), `day ${d.day}: ${text}`).toBe(
            false,
          );
        }
      }
    }
  });
});
