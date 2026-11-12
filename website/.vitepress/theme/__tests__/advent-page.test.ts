import { describe, it, expect } from 'vitest'
import { adventPageMeta, applyAdventMeta, applyShareImage, DEFAULT_OG_IMAGE } from '../../advent-page'
import { DOORS, plainText } from '../../../../packages/cli/src/advent/index.ts'

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
      title: `Day 12 · ${plainText(door.command)} — Git Advent Calendar`,
      description: `${plainText(door.problem)} ${plainText(door.command)}: day 12 of the GitWand Git Advent Calendar.`,
      ogImage: 'https://gitwand.app/advent/og/day-12.png',
    })
  })

  it('keeps inline markup out of day 12 meta', () => {
    const { description, title } = adventPageMeta(12)
    expect(description).not.toContain('`')
    expect(title).not.toContain('`')
    expect(description).toBe(
      'I did a reset --hard and my commits are gone. git reflog: day 12 of the GitWand Git Advent Calendar.',
    )
  })

  it('zero-pads the OG image only', () => {
    expect(adventPageMeta(3).ogImage).toBe('https://gitwand.app/advent/og/day-03.png')
    expect(adventPageMeta(3).title.startsWith('Day 3 · ')).toBe(true)
  })

  it('has a default OG image', () => {
    expect(DEFAULT_OG_IMAGE).toBe('https://gitwand.app/og-image.png')
  })
})

const page = (relativePath: string, params?: Record<string, string>) => ({
  relativePath,
  params,
  frontmatter: {} as Record<string, any>,
  title: '',
  description: '',
})
const heads = (p: ReturnType<typeof page>) => JSON.stringify(p.frontmatter.head)

describe('applyAdventMeta', () => {
  it('sets title, description and head for a day page', () => {
    const p = page('advent/[day].md', { day: '12' })
    applyAdventMeta(p)
    applyShareImage(p)
    const meta = adventPageMeta(12)
    expect(p.title).toBe(meta.title)
    expect(p.description).toBe(meta.description)
    expect(p.frontmatter.head).toContainEqual(['meta', { property: 'og:image', content: meta.ogImage }])
    expect(p.frontmatter.head).toContainEqual(['meta', { name: 'twitter:image', content: meta.ogImage }])
    expect(p.frontmatter.head).toContainEqual(['meta', { property: 'og:title', content: meta.title }])
    expect(p.frontmatter.head).toContainEqual(['meta', { name: 'twitter:title', content: meta.title }])
  })

  it('handles advent/index.md', () => {
    const p = page('advent/index.md')
    applyAdventMeta(p)
    expect(p.description).toBe(adventPageMeta(null).description)
    applyShareImage(p)
    expect(heads(p)).toContain('https://gitwand.app/advent/og/index.png')
  })

  it('leaves other pages alone', () => {
    const p = page('features.md')
    applyAdventMeta(p)
    expect(p.frontmatter.head).toBeUndefined()
    expect(p.description).toBe('')
  })

  it('throws a clear error for an unknown day', () => {
    expect(() => adventPageMeta(25)).toThrow(/day 25.*\[day\]\.paths\.ts/)
  })
})

describe('applyShareImage', () => {
  it('uses the default image when none is set', () => {
    const p = page('features.md')
    applyShareImage(p)
    expect(p.frontmatter.head).toContainEqual(['meta', { property: 'og:image', content: DEFAULT_OG_IMAGE }])
  })

  it('does not duplicate an og:image the page declares', () => {
    const p = page('blog/x.md')
    p.frontmatter.head = [['meta', { property: 'og:image', content: 'https://example.com/a.png' }]]
    applyShareImage(p)
    expect(p.frontmatter.head.filter(([, a]: any) => a.property === 'og:image')).toHaveLength(1)
    expect(p.frontmatter.head.filter(([, a]: any) => a.name === 'twitter:image')).toHaveLength(1)
  })
})
