/**
 * Blog post metadata, derived from the articles themselves.
 *
 * Pure helpers used by `blog.data.ts` (the VitePress data loader) so that the
 * home page's "From the blog" card always shows the newest article without
 * anyone having to edit `HomeLanding.vue`. Kept free of VitePress imports so
 * they can be unit-tested directly.
 */

export interface BlogPost {
  url: string
  title: string
  description: string
  /** ISO date (YYYY-MM-DD) from the article's frontmatter. */
  date: string
  /** "November 12, 2026" — same format as the cards in blog/index.md. */
  dateLabel: string
  readingMinutes: number
}

/** Shape of one entry returned by `createContentLoader` with `includeSrc: true`. */
export interface RawPage {
  url: string
  src?: string
  frontmatter: Record<string, unknown>
}

const WORDS_PER_MINUTE = 230

/** Reading time in minutes: prose words only (frontmatter and fenced code excluded), at least 1. */
export function readingMinutes(src: string): number {
  const body = src
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^```[\s\S]*?^```/gm, '')
  const words = body.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}

/** Normalises a frontmatter date (gray-matter yields a Date for YYYY-MM-DD) to YYYY-MM-DD, or null. */
export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  return null
}

/** "2026-11-12" → "November 12, 2026" (UTC, so the label never shifts by a day). */
export function formatDateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Articles only (the blog index and anything without a title or a valid date
 * are skipped), newest first. Same-day articles keep a stable order by URL.
 */
export function toBlogPosts(pages: RawPage[]): BlogPost[] {
  const posts: BlogPost[] = []
  for (const page of pages) {
    if (/\/blog\/?(index(\.html)?)?$/.test(page.url)) continue
    const title = page.frontmatter.title
    const date = toIsoDate(page.frontmatter.date)
    if (typeof title !== 'string' || !title || !date) continue
    const description = typeof page.frontmatter.description === 'string' ? page.frontmatter.description : ''
    posts.push({
      url: page.url.replace(/\.html$/, ''),
      title,
      description,
      date,
      dateLabel: formatDateLabel(date),
      readingMinutes: readingMinutes(page.src ?? ''),
    })
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url))
}
