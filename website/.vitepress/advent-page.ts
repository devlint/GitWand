// Imported by config.ts, which is not under the Vite alias, hence the relative path.
import { DOORS } from '../../packages/cli/src/advent/index.ts'

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
  if (!door) throw new Error(`No advent door for day ${day}`)
  return {
    title: `Day ${day} · ${door.command} — Git Advent Calendar`,
    description: `${door.problem} ${door.command}: day ${day} of the GitWand Git Advent Calendar.`,
    ogImage: `https://gitwand.app/advent/og/day-${String(day).padStart(2, '0')}.png`,
  }
}
