/**
 * Geometry for the /next hero: a line sketch of the v4 workspace, and the
 * cover drawn over the part that is not designed yet.
 *
 * Pure data and pure functions, no DOM: the Vue component renders it, and it
 * can be rendered to a static SVG from Node to check the drawing.
 */

export const VIEW = { w: 1200, h: 660 }
/** The window being sketched. */
export const WIN = { l: 90, r: 1110, t: 70, b: 590 }
/** How far the cover can be pulled back, in viewBox x. It never uncovers the right-hand column. */
export const HEM = { min: 300, max: 850, start: 610 }

export type Tone = 'ink' | 'faint' | 'accent' | 'amber' | 'green' | 'red'
export interface Stroke {
  kind: 'line' | 'rect' | 'dot'
  a: number[] // line: x1,y1,x2,y2 · rect: x,y,w,h,r · dot: cx,cy,r
  tone: Tone
  /** Order in the draw-in sequence, 0 = first. */
  step: number
  w?: number
}

const line = (x1: number, y1: number, x2: number, y2: number, tone: Tone = 'ink', step = 0, w?: number): Stroke =>
  ({ kind: 'line', a: [x1, y1, x2, y2], tone, step, w })
const rect = (x: number, y: number, w: number, h: number, r = 8, tone: Tone = 'ink', step = 0): Stroke =>
  ({ kind: 'rect', a: [x, y, w, h, r], tone, step })
const dot = (cx: number, cy: number, tone: Tone = 'ink', step = 0, r = 4): Stroke =>
  ({ kind: 'dot', a: [cx, cy, r], tone, step })

function build(): Stroke[] {
  const { l, r, t, b } = WIN
  const o = 24 // overshoot: frame lines run past their corners, as on a design sketch
  const s: Stroke[] = [
    // frame, each side past its corners, then a lighter second pass
    line(l - o, t, r + o, t, 'ink', 0, 1.5), line(l - o, b, r + o, b, 'ink', 0, 1.5),
    line(l, t - o, l, b + o, 'ink', 0, 1.5), line(r, t - o, r, b + o, 'ink', 0, 1.5),
    line(l - 10, t + 3, r - 40, t + 3, 'faint', 0), line(l + 3, t - 8, l + 3, b - 60, 'faint', 0),
    // columns
    line(330, t - 12, 330, b + 12, 'ink', 1), line(860, t - 12, 860, b + 12, 'ink', 1),
    line(l, 104, 330, 104, 'faint', 1),
    // ground hatching under the frame
    ...Array.from({ length: 26 }, (_, i) => line(150 + i * 36, b + 16, 132 + i * 36, b + 34, 'faint', 5)),
  ]
  // sidebar: the app mark, then one row per task
  s.push(rect(108, 80, 16, 16, 4, 'accent', 1), line(134, 88, 196, 88, 'ink', 1, 1.5))
  const rows: [Tone, number, number][] = [
    ['amber', 150, 120], ['accent', 170, 150], ['green', 130, 110], ['ink', 150, 90],
    ['ink', 60, 70], ['ink', 120, 100], ['ink', 90, 60],
  ]
  rows.forEach(([tone, w1, w2], i) => {
    const y = 142 + i * 46 + (i > 3 ? 22 : 0)
    if (i === 0) s.push(rect(102, y - 20, 216, 40, 9, 'accent', 2))
    s.push(dot(116, y, tone, 2), line(132, y - 5, 132 + w1, y - 5, 'ink', 2), line(132, y + 9, 132 + w2, y + 9, 'faint', 2))
  })
  s.push(line(104, 326, 150, 326, 'faint', 2), rect(104, 546, 212, 30, 15, 'ink', 2))
  // task header and its three modes
  s.push(line(354, 128, 560, 128, 'ink', 3, 2), line(354, 146, 620, 146, 'faint', 3))
  s.push(rect(646, 116, 196, 36, 18, 'ink', 3), rect(650, 120, 64, 28, 14, 'accent', 3),
    line(664, 134, 700, 134, 'accent', 3), line(728, 134, 768, 134, 'faint', 3), line(790, 134, 828, 134, 'faint', 3))
  // what waits for the person
  s.push(rect(354, 172, 488, 56, 12, 'amber', 3), line(372, 192, 470, 192, 'amber', 3), line(372, 208, 610, 208, 'ink', 3),
    rect(690, 186, 62, 28, 14, 'ink', 3), rect(762, 186, 66, 28, 14, 'accent', 3))
  // the session
  s.push(rect(354, 246, 488, 312, 12, 'ink', 4), line(354, 522, 842, 522, 'faint', 4))
  const out: [number, Tone][] = [[300, 'ink'], [410, 'red'], [420, 'green'], [380, 'red'], [396, 'green'], [0, 'ink'],
    [250, 'ink'], [430, 'faint'], [0, 'ink'], [330, 'amber'], [280, 'faint']]
  out.forEach(([w, tone], i) => { if (w) s.push(line(374, 274 + i * 21, 374 + w, 274 + i * 21, tone, 4)) })
  s.push(rect(374, 498, 8, 14, 1, 'ink', 4), line(374, 540, 470, 540, 'faint', 4), line(700, 540, 824, 540, 'amber', 4))
  // instruments: where each task stands, guardrails, restore points, review
  s.push(rect(880, 118, 210, 132, 12, 'ink', 5), line(906, 140, 906, 232, 'faint', 5), line(934, 162, 934, 232, 'faint', 5),
    line(962, 184, 962, 232, 'faint', 5), line(906, 232, 962, 232, 'faint', 5))
  ;[[906, 150, 'ink'], [906, 196, 'ink'], [934, 172, 'accent'], [934, 210, 'accent'], [962, 194, 'amber']].forEach(([x, y, tone]) =>
    s.push(dot(x as number, y as number, tone as Tone, 5, 4.5), line((x as number) + 70 - ((x as number) - 906), y as number, 1066, y as number, 'faint', 5)))
  s.push(rect(880, 266, 210, 124, 12, 'ink', 5))
  ;[0, 1, 2, 3].forEach(i => s.push(line(898, 290 + i * 26, 980 + (i % 2) * 20, 290 + i * 26, 'ink', 5),
    line(1036, 290 + i * 26, 1072, 290 + i * 26, i === 2 ? 'amber' : 'green', 5, 2)))
  s.push(rect(880, 406, 210, 100, 12, 'ink', 5), line(902, 424, 902, 490, 'faint', 5))
  ;[0, 1, 2].forEach(i => s.push(dot(902, 430 + i * 26, 'ink', 5, 3.5), line(918, 430 + i * 26, 1010 - i * 14, 430 + i * 26, 'ink', 5)))
  s.push(rect(880, 522, 210, 52, 12, 'ink', 5), line(898, 548, 1000, 548, 'faint', 5))
  return s
}
export const SKETCH: Stroke[] = build()

/** Callouts. `on` says whether the text sits clear of the cover or on it. */
export const CALLOUTS = [
  { text: 'Tasks, across every repository', x: 96, y: 34, anchor: 'start', lead: [150, 42, 150, 122] },
  { text: 'What waits for you', x: 372, y: 34, anchor: 'start', lead: [420, 42, 420, 172] },
  { text: "The session: the agent's terminal", x: 372, y: 646, anchor: 'start', lead: [430, 630, 430, 558] },
] as const

const TOP = 56
const BOTTOM = 614
const RIGHT = 1186

/** Where the hem hangs at height y, for a cover pulled back to x = hem. */
export function hemX(hem: number, y: number): number {
  const v = (y - TOP) / (BOTTOM - TOP)
  return hem + 16 * Math.sin(v * 5.2 + hem * 0.011) + 7 * Math.sin(v * 13 + 1.3) - 26 * v * v
}

const f = (n: number) => n.toFixed(1)

/** The cloth itself, as one closed shape. */
export function coverShape(hem: number): string {
  let d = ''
  for (let y = TOP; y <= BOTTOM; y += 9) d += `${d ? 'L' : 'M'}${f(hemX(hem, y))} ${y}`
  for (let x = hemX(hem, BOTTOM); x <= RIGHT; x += 30) d += `L${f(x)} ${f(BOTTOM + 5 * Math.sin(x * 0.045))}`
  d += `L${RIGHT} ${BOTTOM}L${RIGHT} ${TOP}`
  return d + 'Z'
}

/** The hem as an open line, drawn heavier than the folds. */
export function hemLine(hem: number): string {
  let d = ''
  for (let y = TOP; y <= BOTTOM; y += 9) d += `${d ? 'L' : 'M'}${f(hemX(hem, y))} ${y}`
  return d
}

/**
 * Fold lines running across the cloth. They gather near the hem, where the
 * cover is bunched from being pulled back, and settle towards the right.
 */
export function foldLines(hem: number, count = 30): string[] {
  const lines: string[] = []
  for (let j = 0; j < count; j++) {
    const v = (j + 0.5) / count
    const base = TOP + v * (BOTTOM - TOP)
    const x0 = hemX(hem, base)
    let d = ''
    for (let x = x0; x <= RIGHT; x += 14) {
      const from = x - x0
      const gather = 15 * Math.exp(-from / 80)
      const y = base
        + (2.4 + gather) * Math.sin(from * 0.034 + j * 0.62)
        + 3.2 * Math.sin(x * 0.011 + j * 0.31)
        - 18 * Math.exp(-from / 46) * (0.5 - v) // pinched towards the middle of the hem
      d += `${d ? 'L' : 'M'}${f(x)} ${f(y)}`
    }
    lines.push(d)
  }
  return lines
}
