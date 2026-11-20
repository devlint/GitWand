// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { ADVENT_DISMISS_KEY, adventCardState, parisDayKey, useAdventCard } from "../useAdventCard";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));

describe("adventCardState", () => {
  it("is hidden before December (Paris time)", () => {
    expect(adventCardState(at(2026, 11, 30))).toBeNull();
    // 22:30 UTC on Nov 30 is still Nov 30 in Paris (UTC+1).
    expect(adventCardState(at(2026, 11, 30, 22, 30))).toBeNull();
  });

  it("shows today's door, from the shared content", () => {
    // 23:30 UTC on Nov 30 is already Dec 1 in Paris.
    expect(adventCardState(at(2026, 11, 30, 23, 30))).toMatchObject({ kind: "door", day: 1 });
    expect(adventCardState(at(2026, 12, 12))).toEqual({
      kind: "door",
      day: 12,
      command: "git reflog",
      problem: "I did a reset --hard and my commits are gone.",
      url: "https://gitwand.app/advent/12",
    });
    expect(adventCardState(at(2026, 12, 24))).toMatchObject({ kind: "door", day: 24 });
  });

  it("strips inline markup from the problem", () => {
    const state = adventCardState(at(2026, 12, 12));
    expect(state?.kind === "door" && state.problem).not.toMatch(/[`*]/);
  });

  it("links to the whole calendar on Christmas Day only", () => {
    expect(adventCardState(at(2026, 12, 25))).toEqual({ kind: "all", count: 24, url: "https://gitwand.app/advent" });
    expect(adventCardState(at(2026, 12, 26))).toBeNull();
    expect(adventCardState(at(2027, 12, 12))).toBeNull();
    expect(adventCardState(at(2027, 12, 25))).toBeNull();
  });
});

describe("parisDayKey", () => {
  it("uses the Paris calendar day", () => {
    expect(parisDayKey(at(2026, 12, 5))).toBe("2026-12-05");
    expect(parisDayKey(at(2026, 12, 4, 23, 30))).toBe("2026-12-05");
  });
});

describe("useAdventCard", () => {
  beforeEach(() => localStorage.clear());

  it("hides the card for the rest of the Paris day once dismissed", () => {
    const first = useAdventCard(() => at(2026, 12, 12));
    expect(first.card.value).toMatchObject({ day: 12 });
    first.dismiss();
    expect(first.card.value).toBeNull();
    expect(localStorage.getItem(ADVENT_DISMISS_KEY)).toBe("2026-12-12");

    expect(useAdventCard(() => at(2026, 12, 12, 20)).card.value).toBeNull();
    expect(useAdventCard(() => at(2026, 12, 13)).card.value).toMatchObject({ day: 13 });
  });

  it("shows nothing outside the season, dismissed or not", () => {
    expect(useAdventCard(() => at(2026, 11, 20)).card.value).toBeNull();
  });
});
