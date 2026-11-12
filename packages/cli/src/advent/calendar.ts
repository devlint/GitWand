/**
 * Pure date helpers for the Git Advent Calendar. No Node imports: the website
 * bundles this file for the browser.
 */

export const ADVENT_YEAR = 2026;
export const DOOR_COUNT = 24;
export const ADVENT_URL = "https://gitwand.app/advent";

export type CalendarState =
  | { phase: "not-started" }
  | { phase: "running"; today: number }
  | { phase: "over" };

/** Calendar date in Europe/Paris for the given instant. */
export function parisYmd(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function calendarState(now: Date): CalendarState {
  const { year, month, day } = parisYmd(now);
  if (year < ADVENT_YEAR) return { phase: "not-started" };
  if (year > ADVENT_YEAR) return { phase: "over" };
  if (month < 12) return { phase: "not-started" };
  if (day <= DOOR_COUNT) return { phase: "running", today: day };
  return { phase: "over" };
}

export function isUnlocked(day: number, now: Date): boolean {
  const state = calendarState(now);
  if (state.phase === "over") return true;
  if (state.phase === "not-started") return false;
  return day <= state.today;
}

/** "YYYY-MM-DD" becomes that date at 12:00 UTC; anything else is null. */
export function parseDateOverride(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

export function doorUrl(day?: number): string {
  return day === undefined ? ADVENT_URL : `${ADVENT_URL}/${day}`;
}

export function opensOn(day: number): string {
  return `${ADVENT_YEAR}-12-${String(day).padStart(2, "0")}`;
}
