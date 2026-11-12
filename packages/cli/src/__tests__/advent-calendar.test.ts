import { describe, expect, it } from "vitest";

import {
  calendarState,
  doorUrl,
  isUnlocked,
  opensOn,
  parseDateOverride,
} from "../advent/calendar.js";

describe("calendarState", () => {
  it("is not-started before 1 December (Paris)", () => {
    expect(calendarState(new Date("2026-11-30T22:59:59Z"))).toEqual({ phase: "not-started" });
    expect(calendarState(new Date("2025-12-10T12:00:00Z"))).toEqual({ phase: "not-started" });
  });

  it("is running from 1 to 24 December (Paris)", () => {
    expect(calendarState(new Date("2026-11-30T23:00:00Z"))).toEqual({ phase: "running", today: 1 });
    expect(calendarState(new Date("2026-12-12T10:00:00Z"))).toEqual({ phase: "running", today: 12 });
    expect(calendarState(new Date("2026-12-24T22:59:59Z"))).toEqual({ phase: "running", today: 24 });
  });

  it("is over from 25 December, and stays over in later years", () => {
    expect(calendarState(new Date("2026-12-24T23:00:00Z"))).toEqual({ phase: "over" });
    expect(calendarState(new Date("2027-12-05T12:00:00Z"))).toEqual({ phase: "over" });
  });
});

describe("isUnlocked", () => {
  it("unlocks doors up to today", () => {
    const dec12 = new Date("2026-12-12T10:00:00Z");
    expect(isUnlocked(12, dec12)).toBe(true);
    expect(isUnlocked(13, dec12)).toBe(false);
    expect(isUnlocked(24, new Date("2026-11-20T12:00:00Z"))).toBe(false);
    expect(isUnlocked(1, new Date("2027-01-02T12:00:00Z"))).toBe(true);
  });
});

describe("parseDateOverride", () => {
  it("parses YYYY-MM-DD at 12:00 UTC", () => {
    const d = parseDateOverride("2026-12-12");
    expect(d).not.toBeNull();
    expect(calendarState(d as Date)).toEqual({ phase: "running", today: 12 });
  });

  it("rejects anything else", () => {
    for (const v of ["foo", "2026-13-40", "2026-02-31", "12/12/2026", "", null, undefined]) {
      expect(parseDateOverride(v)).toBeNull();
    }
  });
});

describe("urls", () => {
  it("builds door urls and opening dates", () => {
    expect(doorUrl()).toBe("https://gitwand.app/advent");
    expect(doorUrl(7)).toBe("https://gitwand.app/advent/7");
    expect(opensOn(18)).toBe("2026-12-18");
    expect(opensOn(3)).toBe("2026-12-03");
  });
});
