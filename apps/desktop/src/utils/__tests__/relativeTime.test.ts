import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeAge } from "../relativeTime";

/** Minimal stand-in for `useI18n().t` — mirrors positional {0} interpolation
 *  closely enough to assert which key + args were selected. */
function fakeT(key: string, ...args: Array<string | number>): string {
  return args.length ? `${key}:${args.join(",")}` : key;
}

describe("formatRelativeAge", () => {
  const NOW = new Date("2026-08-18T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty string for an empty date", () => {
    expect(formatRelativeAge("", fakeT)).toBe("");
    expect(formatRelativeAge(null, fakeT)).toBe("");
    expect(formatRelativeAge(undefined, fakeT)).toBe("");
  });

  it("returns an empty string instead of NaN for an unparseable date (#161)", () => {
    expect(formatRelativeAge("not-a-date", fakeT)).toBe("");
  });

  it("formats sub-minute as 'now'", () => {
    expect(formatRelativeAge(new Date(NOW - 30_000).toISOString(), fakeT)).toBe("date.now");
  });

  it("formats minutes", () => {
    expect(formatRelativeAge(new Date(NOW - 5 * 60_000).toISOString(), fakeT)).toBe("date.minutesAgo:5");
  });

  it("formats hours", () => {
    expect(formatRelativeAge(new Date(NOW - 3 * 3_600_000).toISOString(), fakeT)).toBe("date.hoursAgo:3");
  });

  it("formats days", () => {
    expect(formatRelativeAge(new Date(NOW - 3 * 86_400_000).toISOString(), fakeT)).toBe("date.daysAgo:3");
  });

  it("formats weeks once past 7 days", () => {
    expect(formatRelativeAge(new Date(NOW - 14 * 86_400_000).toISOString(), fakeT)).toBe("date.weeksAgo:2");
  });

  it("formats months once past 30 days", () => {
    expect(formatRelativeAge(new Date(NOW - 90 * 86_400_000).toISOString(), fakeT)).toBe("date.monthsAgo:3");
  });

  it("formats years once past 365 days", () => {
    expect(formatRelativeAge(new Date(NOW - 400 * 86_400_000).toISOString(), fakeT)).toBe("date.yearsAgo:1");
  });
});
