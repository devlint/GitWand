export type DateBucket = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

const DAY = 86_400_000;

export function dateBucket(ts: number, now: number): DateBucket {
  const diff = now - ts;
  if (diff < DAY) return "today";
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return "thisWeek";
  if (diff < 30 * DAY) return "thisMonth";
  return "older";
}
