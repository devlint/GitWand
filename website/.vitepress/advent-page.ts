// Imported by config.ts, which is not under the Vite alias, hence the relative path.
import { DOORS, plainText } from '../../packages/cli/src/advent/index.ts'

export const DEFAULT_OG_IMAGE = 'https://gitwand.app/og-image.png'

export function adventPageMeta(day: number | null): { title: string; description: string; ogImage: string } {
  if (day === null) {
    return {
      title: 'Git Advent Calendar — 24 little-known git commands',
      description: '24 little-known git commands, one a day until Christmas, each with a GitWand tip.',
      ogImage: 'https://gitwand.app/advent/og/index.png',
    }
  }
  const door = DOORS.find((d) => d.day === day)
  if (!door) {
    throw new Error(`No advent door for day ${day}: advent/[day].paths.ts must only list days present in DOORS`)
  }
  // Door copy carries inline markup (`code`, **strong**); meta text is plain.
  const command = plainText(door.command)
  return {
    title: `Day ${day} · ${command} — Git Advent Calendar`,
    description: `${plainText(door.problem)} ${command}: day ${day} of the GitWand Git Advent Calendar.`,
    ogImage: `https://gitwand.app/advent/og/day-${String(day).padStart(2, '0')}.png`,
  }
}

type HeadEntry = [string, Record<string, string>]
interface PageDataLike {
  relativePath: string
  title?: string
  description?: string
  params?: Record<string, unknown>
  frontmatter: Record<string, any>
}

/**
 * Advent pages are generated from DOORS (a dynamic route has no frontmatter of
 * its own), so title, description and share image are derived here. Setting
 * `pageData.description` matters: VitePress builds <meta name="description">
 * from it, not from frontmatter, so without it every page keeps the site default.
 *
 * Day pages also get `frontmatter.adventBuiltAt` (the build time, ISO).
 */
export function applyAdventMeta(pageData: PageDataLike, now: Date = new Date()): void {
  if (!pageData.relativePath.startsWith('advent/')) return
  const adventDay = pageData.params?.day ? Number(pageData.params.day) : null
  if (pageData.relativePath !== 'advent/index.md' && adventDay === null) return
  const meta = adventPageMeta(adventDay)
  // Day pages show the door as an article once the season is over; the page
  // decides from this build time (server and first client render alike).
  if (adventDay !== null) pageData.frontmatter.adventBuiltAt = now.toISOString()
  pageData.title = meta.title
  pageData.description = meta.description
  pageData.frontmatter.title = meta.title
  pageData.frontmatter.description = meta.description
  pageData.frontmatter.ogImage = meta.ogImage
  const head: HeadEntry[] = (pageData.frontmatter.head ??= [])
  head.push(
    ['meta', { property: 'og:title', content: meta.title }],
    ['meta', { property: 'og:description', content: meta.description }],
    ['meta', { name: 'twitter:title', content: meta.title }],
  )
}

/**
 * Adds og:image / twitter:image (the default image unless frontmatter `ogImage`
 * names another), skipping any the page already declares in its own head so a
 * page with a hand-written og:image never ends up with two.
 */
export function applyShareImage(pageData: PageDataLike): void {
  const head: HeadEntry[] = (pageData.frontmatter.head ??= [])
  const image = pageData.frontmatter.ogImage ?? DEFAULT_OG_IMAGE
  const declares = (key: 'property' | 'name', value: string) =>
    head.some(([tag, attrs]) => tag === 'meta' && attrs?.[key] === value)
  if (!declares('property', 'og:image')) head.push(['meta', { property: 'og:image', content: image }])
  if (!declares('name', 'twitter:image')) head.push(['meta', { name: 'twitter:image', content: image }])
}
