/**
 * Pure state helpers for the Git Advent Calendar page. No DOM access here:
 * the components pass in `location.search`, `localStorage` and the clock.
 */
import {
  ADVENT_YEAR,
  DOOR_COUNT,
  calendarState,
  isUnlocked,
  parisYmd,
  parseDateOverride,
} from '@gitwand/advent'

export const STORAGE_KEY = 'gitwand-advent-2026-opened'

/** Site path of the calendar index (canonical form, with the trailing slash). */
export const ADVENT_INDEX_PATH = '/advent/'

export function isDoorDay(day: unknown): day is number {
  return typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= DOOR_COUNT
}

/** `?date=YYYY-MM-DD` overrides the clock (for previews); anything else keeps `real`. */
export function resolveNow(search: string, real: Date): Date {
  let value: string | null = null
  try {
    value = new URLSearchParams(search).get('date')
  } catch {
    value = null
  }
  return parseDateOverride(value) ?? real
}

/** Doors already opened on this browser. Never throws: unreadable storage is an empty set. */
export function readOpened(storage: Pick<Storage, 'getItem'> | null): Set<number> {
  const out = new Set<number>()
  if (!storage) return out
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return out
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return out
    for (const day of parsed) if (isDoorDay(day)) out.add(day)
  } catch {
    return new Set<number>()
  }
  return out
}

/**
 * Records `day` as opened and returns the resulting set. If storage is missing
 * or fails, the returned set still contains `day` (in memory only).
 */
export function markOpened(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  day: number,
): Set<number> {
  const opened = readOpened(storage)
  if (!isDoorDay(day)) return opened
  opened.add(day)
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify([...opened].sort((a, b) => a - b)))
    } catch {
      // Private mode, quota, disabled storage: keep the in-memory set.
    }
  }
  return opened
}

export function lockedMessage(day: number): string {
  return `Patience — opens on December ${day}`
}

/** What to do on mount for a `/advent/<day>` URL. */
export function initialDoorAction(day: number | undefined, now: Date): 'open' | 'locked' | 'none' {
  if (!isDoorDay(day)) return 'none'
  return isUnlocked(day, now) ? 'open' : 'locked'
}

/** Home/nav announcement, shown from 1 to 25 December of the edition year (Paris time). */
export function adventBadge(now: Date): { text: string; href: typeof ADVENT_INDEX_PATH } | null {
  const state = calendarState(now)
  if (state.phase === 'running') {
    return { text: `Git Advent Calendar — door ${state.today} is open`, href: ADVENT_INDEX_PATH }
  }
  const { year, month, day } = parisYmd(now)
  if (year === ADVENT_YEAR && month === 12 && day === 25) {
    return { text: `Git Advent Calendar — all ${DOOR_COUNT} doors are open`, href: ADVENT_INDEX_PATH }
  }
  return null
}
