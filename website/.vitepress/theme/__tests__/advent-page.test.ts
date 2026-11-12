import { describe, it, expect } from 'vitest'
import { adventPageMeta, DEFAULT_OG_IMAGE } from '../../advent-page'
import { DOORS } from '../../../../packages/cli/src/advent/index.ts'

describe('adventPageMeta', () => {
  it('describes the index page', () => {
    expect(adventPageMeta(null)).toEqual({
      title: 'Git Advent Calendar — 24 little-known git commands',
      description: '24 little-known git commands, one a day until Christmas, each with a GitWand tip.',
      ogImage: 'https://gitwand.app/advent/og/index.png',
    })
  })

  it('describes a day page from DOORS', () => {
    const door = DOORS.find((d) => d.day === 12)!
    expect(adventPageMeta(12)).toEqual({
      title: `Day 12 · ${door.command} — Git Advent Calendar`,
      description: `${door.problem} ${door.command}: day 12 of the GitWand Git Advent Calendar.`,
      ogImage: 'https://gitwand.app/advent/og/day-12.png',
    })
  })

  it('zero-pads the OG image only', () => {
    expect(adventPageMeta(3).ogImage).toBe('https://gitwand.app/advent/og/day-03.png')
    expect(adventPageMeta(3).title.startsWith('Day 3 · ')).toBe(true)
  })

  it('has a default OG image', () => {
    expect(DEFAULT_OG_IMAGE).toBe('https://gitwand.app/og-image.png')
  })
})
