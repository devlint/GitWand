/**
 * v3.11.0 — `--min-confidence-score` on the CLI.
 *
 * Without a CLI and MCP surface the numeric bar is reachable from exactly one
 * of the engine's four consumers, which would make it an app preference rather
 * than an engine option.
 *
 * The parsing is deliberately forgiving in one direction only: a value that
 * cannot be used falls through to `.gitwandrc` and then to "bar off". It never
 * aborts the command, and it never guesses a different number. A bar that
 * silently became something other than what was typed is worse than one that
 * stayed off, because the user would only find out from the result.
 */

import { describe, expect, it } from "vitest";
import { parseMinConfidenceScore } from "../commands/resolve.js";

describe("parseMinConfidenceScore", () => {
  it.each([
    ["a plain number", "90", 90],
    ["zero", "0", 0],
    ["the upper bound", "100", 100],
    ["surrounding space", "  75  ", 75],
    ["a fractional value", "82.5", 82.5],
    ["an already-numeric value", 60, 60],
  ])("accepts %s", (_label, input, expected) => {
    expect(parseMinConfidenceScore(input)).toBe(expected);
  });

  it.each([
    ["below zero", "-1"],
    ["above one hundred", "101"],
    ["not a number", "high"],
    ["empty", ""],
    ["a bare flag with no value", true],
    ["undefined", undefined],
    ["null", null],
  ])("ignores %s, leaving the bar to .gitwandrc or off", (_label, input) => {
    expect(parseMinConfidenceScore(input)).toBeUndefined();
  });
});
