/**
 * Git Advent Calendar card on the Dashboard (1 to 25 December 2026, Paris time).
 *
 * The door content comes from the shared module the CLI and the website use
 * (`packages/cli/src/advent`, aliased as `@gitwand/advent`), so the app shows
 * the same command and problem as the other surfaces. The card opens the
 * door's page on gitwand.app; it can be dismissed until the next Paris day.
 */
import { computed, ref } from "vue";
import { ADVENT_YEAR, DOORS, DOOR_COUNT, calendarState, doorUrl, parisYmd, plainText } from "@gitwand/advent";
import { openExternalUrl } from "../utils/backend";

export type AdventCardState =
  | { kind: "door"; day: number; command: string; problem: string; url: string }
  | { kind: "all"; count: number; url: string };

/** What the card shows at `now`, or null outside 1–25 December 2026 (Paris). */
export function adventCardState(now: Date): AdventCardState | null {
  const state = calendarState(now);
  if (state.phase === "running") {
    const door = DOORS.find((d) => d.day === state.today);
    if (!door) return null;
    return {
      kind: "door",
      day: door.day,
      command: door.command,
      problem: plainText(door.problem),
      url: doorUrl(door.day),
    };
  }
  // Christmas Day itself: every door is open. Afterwards the calendar stays
  // online, but the app stops announcing it.
  const { year, month, day } = parisYmd(now);
  if (year === ADVENT_YEAR && month === 12 && day === 25) {
    return { kind: "all", count: DOOR_COUNT, url: doorUrl() };
  }
  return null;
}

/** Paris calendar day as YYYY-MM-DD, the unit a dismissal lasts. */
export function parisDayKey(now: Date): string {
  const { year, month, day } = parisYmd(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const ADVENT_DISMISS_KEY = "gitwand-advent-2026-dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(ADVENT_DISMISS_KEY);
  } catch {
    return null;
  }
}

export function useAdventCard(clock: () => Date = () => new Date()) {
  const dismissedOn = ref<string | null>(readDismissed());
  // Read once per mount: the card does not need to flip at midnight while open.
  const now = clock();
  const state = adventCardState(now);
  const today = parisDayKey(now);

  const card = computed(() => (state && dismissedOn.value !== today ? state : null));

  function dismiss(): void {
    dismissedOn.value = today;
    try {
      localStorage.setItem(ADVENT_DISMISS_KEY, today);
    } catch {
      /* storage unavailable: the card stays hidden for this mount only */
    }
  }

  function open(): void {
    if (state) void openExternalUrl(state.url);
  }

  return { card, dismiss, open };
}
