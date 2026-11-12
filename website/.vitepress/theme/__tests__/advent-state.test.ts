import { describe, it, expect } from 'vitest'
import {
  STORAGE_KEY,
  resolveNow,
  readOpened,
  markOpened,
  lockedMessage,
  initialDoorAction,
  adventBadge,
  openedUnlockedCount,
  showDoorArticle,
  buildTimeNow,
} from '../advent/advent-state'

const real = new Date(Date.UTC(2026, 10, 12, 9, 0, 0))
const dec12 = new Date(Date.UTC(2026, 11, 12, 12, 0, 0))
const nov20 = new Date(Date.UTC(2026, 10, 20, 12, 0, 0))

function fakeStorage(initial?: string) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(STORAGE_KEY, initial)
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

const throwing = {
  getItem: (): string | null => {
    throw new Error('SecurityError')
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError')
  },
}

describe('STORAGE_KEY', () => {
  it('is scoped to the 2026 edition', () => {
    expect(STORAGE_KEY).toBe('gitwand-advent-2026-opened')
  })
})

describe('resolveNow', () => {
  it('uses a valid ?date= override', () => {
    const d = resolveNow('?date=2026-12-12', real)
    expect(d.toISOString()).toBe('2026-12-12T12:00:00.000Z')
  })

  it('falls back to the real date on a bad override', () => {
    expect(resolveNow('?date=nope', real)).toBe(real)
    expect(resolveNow('', real)).toBe(real)
    expect(resolveNow('?other=1', real)).toBe(real)
  })
})

describe('readOpened / markOpened', () => {
  it('round-trips through storage', () => {
    const s = fakeStorage()
    expect([...readOpened(s)]).toEqual([])
    expect([...markOpened(s, 3)].sort((a, b) => a - b)).toEqual([3])
    expect([...markOpened(s, 1)].sort((a, b) => a - b)).toEqual([1, 3])
    expect([...readOpened(s)].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('does not duplicate a day', () => {
    const s = fakeStorage()
    markOpened(s, 5)
    markOpened(s, 5)
    expect([...readOpened(s)]).toEqual([5])
  })

  it('never throws when storage throws', () => {
    expect(() => readOpened(throwing)).not.toThrow()
    expect(readOpened(throwing).size).toBe(0)
    expect(() => markOpened(throwing, 4)).not.toThrow()
    expect([...markOpened(throwing, 4)]).toEqual([4])
  })

  it('works without storage', () => {
    expect(readOpened(null).size).toBe(0)
    expect([...markOpened(null, 7)]).toEqual([7])
  })

  it('treats a corrupt value as empty', () => {
    expect(readOpened(fakeStorage('{')).size).toBe(0)
    expect(readOpened(fakeStorage('{"a":1}')).size).toBe(0)
    expect(readOpened(fakeStorage('"12"')).size).toBe(0)
  })

  it('ignores days outside 1..24', () => {
    const s = fakeStorage(JSON.stringify([0, 1, 24, 25, -3, 2.5, '6', 12]))
    expect([...readOpened(s)].sort((a, b) => a - b)).toEqual([1, 12, 24])
    expect(markOpened(s, 25).has(25)).toBe(false)
    expect(markOpened(s, 0).has(0)).toBe(false)
  })
})

describe('lockedMessage', () => {
  it('names the opening date', () => {
    expect(lockedMessage(18)).toBe('Patience — opens on December 18')
    expect(lockedMessage(1)).toBe('Patience — opens on December 1')
  })
})

describe('initialDoorAction', () => {
  it('opens an unlocked door, refuses a locked one', () => {
    expect(initialDoorAction(18, dec12)).toBe('locked')
    expect(initialDoorAction(5, dec12)).toBe('open')
    expect(initialDoorAction(12, dec12)).toBe('open')
    expect(initialDoorAction(undefined, dec12)).toBe('none')
    expect(initialDoorAction(3, nov20)).toBe('locked')
  })

  it('ignores a day outside the calendar', () => {
    expect(initialDoorAction(Number.NaN, dec12)).toBe('none')
    expect(initialDoorAction(0, dec12)).toBe('none')
    expect(initialDoorAction(25, dec12)).toBe('none')
  })
})

describe('adventBadge', () => {
  it('is hidden before December', () => {
    // 22:30 UTC on Nov 30 is still Nov 30 in Paris (UTC+1).
    expect(adventBadge(new Date(Date.UTC(2026, 10, 30, 22, 30)))).toBeNull()
  })

  it('names the open door during the season', () => {
    expect(adventBadge(dec12)).toEqual({
      text: 'Git Advent Calendar — door 12 is open',
      href: '/advent/',
    })
    // 23:30 UTC on Nov 30 is already Dec 1 in Paris.
    expect(adventBadge(new Date(Date.UTC(2026, 10, 30, 23, 30)))?.text).toBe(
      'Git Advent Calendar — door 1 is open',
    )
  })

  it('announces all doors on Christmas Day', () => {
    expect(adventBadge(new Date(Date.UTC(2026, 11, 25, 12)))).toEqual({
      text: 'Git Advent Calendar — all 24 doors are open',
      href: '/advent/',
    })
  })

  it('is hidden from December 26', () => {
    expect(adventBadge(new Date(Date.UTC(2026, 11, 26, 12)))).toBeNull()
    expect(adventBadge(new Date(Date.UTC(2027, 11, 25, 12)))).toBeNull()
  })
})

describe('openedUnlockedCount', () => {
  it('counts only opened doors that are unlocked now', () => {
    // Door 15 was opened on a Dec 26 preview; on Dec 12 it is locked again.
    expect(openedUnlockedCount(new Set([3, 12, 15]), dec12)).toBe(2)
  })

  it('is 0 before December, whatever storage says', () => {
    expect(openedUnlockedCount(new Set([1, 15]), nov20)).toBe(0)
  })

  it('counts every opened door once the calendar is over', () => {
    const dec26 = new Date(Date.UTC(2026, 11, 26, 12, 0, 0))
    expect(openedUnlockedCount(new Set([1, 15, 24]), dec26)).toBe(3)
  })

  it('ignores anything that is not a door day', () => {
    const dec26 = new Date(Date.UTC(2026, 11, 26, 12, 0, 0))
    expect(openedUnlockedCount(new Set([0, 25, 2.5, 4]), dec26)).toBe(1)
  })
})

describe('showDoorArticle', () => {
  it('shows the door content from 25 December, Paris time', () => {
    // 23:00Z on the 24th is already 00:00 on the 25th in Paris (UTC+1).
    expect(showDoorArticle(new Date('2026-12-24T23:00:00Z'))).toBe(true)
    expect(showDoorArticle(new Date('2026-12-24T22:59:00Z'))).toBe(false)
  })

  it('hides it before and during the season', () => {
    expect(showDoorArticle(nov20)).toBe(false)
    expect(showDoorArticle(dec12)).toBe(false)
  })

  it('keeps it in later years', () => {
    expect(showDoorArticle(new Date('2027-03-01T12:00:00Z'))).toBe(true)
  })
})

describe('buildTimeNow', () => {
  it('parses the ISO timestamp the build stamps on day pages', () => {
    expect(buildTimeNow('2026-12-25T06:00:00.000Z')?.toISOString()).toBe('2026-12-25T06:00:00.000Z')
  })

  it('is null for a missing or malformed value', () => {
    expect(buildTimeNow(undefined)).toBeNull()
    expect(buildTimeNow('')).toBeNull()
    expect(buildTimeNow('nope')).toBeNull()
    expect(buildTimeNow(42)).toBeNull()
  })
})
