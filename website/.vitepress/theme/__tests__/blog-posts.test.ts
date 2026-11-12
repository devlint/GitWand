import { describe, it, expect } from 'vitest'
import { formatDateLabel, readingMinutes, toBlogPosts, toIsoDate } from '../blog-posts'

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

describe('readingMinutes', () => {
  it('ignores frontmatter and fenced code', () => {
    const src = `---\ntitle: "${words(500)}"\n---\n\n${words(460)}\n\n\`\`\`bash\n${words(2000)}\n\`\`\`\n`
    expect(readingMinutes(src)).toBe(2)
  })
  it('is at least one minute', () => {
    expect(readingMinutes('')).toBe(1)
  })
})

describe('dates', () => {
  it('accepts a Date (gray-matter) or a string', () => {
    expect(toIsoDate(new Date('2026-11-12T00:00:00Z'))).toBe('2026-11-12')
    expect(toIsoDate('2026-11-12')).toBe('2026-11-12')
    expect(toIsoDate('soon')).toBeNull()
    expect(toIsoDate(undefined)).toBeNull()
  })
  it('formats like the blog index cards, without timezone drift', () => {
    expect(formatDateLabel('2026-11-12')).toBe('November 12, 2026')
    expect(formatDateLabel('2026-01-01')).toBe('January 1, 2026')
  })
})

describe('toBlogPosts', () => {
  it('skips the index and undated pages, and sorts newest first', () => {
    const posts = toBlogPosts([
      { url: '/blog/', frontmatter: { title: 'Blog — GitWand' } },
      { url: '/blog/older', src: words(10), frontmatter: { title: 'Older', date: new Date('2026-11-02T00:00:00Z') } },
      { url: '/blog/draft', frontmatter: { title: 'No date' } },
      { url: '/blog/newer', src: words(10), frontmatter: { title: 'Newer', description: 'd', date: '2026-11-12' } },
    ])
    expect(posts.map((p) => p.url)).toEqual(['/blog/newer', '/blog/older'])
    expect(posts[0]).toMatchObject({ title: 'Newer', description: 'd', dateLabel: 'November 12, 2026' })
  })
})
