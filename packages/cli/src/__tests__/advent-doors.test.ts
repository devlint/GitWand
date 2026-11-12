import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DOORS } from "../advent/doors.js";
import { TIP_EVIDENCE } from "../advent/evidence.js";
import { parseInline } from "../advent/inline.js";

const ROOT = new URL("../../../../", import.meta.url);
const exists = (rel: string): boolean => existsSync(new URL(rel, ROOT));

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
        const found =
          exists(path) || exists(`apps/desktop/src/${path}`) || exists(`apps/desktop/${path}`);
        expect(found, `day ${d.day} evidence path "${path}"`).toBe(true);
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
