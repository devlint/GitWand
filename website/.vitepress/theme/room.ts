/**
 * The Merge Room: shared state that both the agent and the human act on.
 *
 * This is the part that makes /agent a workspace rather than a calculator.
 * Tool handlers do not merely return text to the agent, they file a case here,
 * and the page renders it. The agent's work is therefore visible as it happens,
 * and the decisions it is not allowed to make queue up for a person.
 *
 * The split is the whole point: the engine settles hunks that carry no
 * decision, and every hunk where the two branches genuinely disagree waits for
 * a human. Nothing here ever picks a side on its own.
 */
import { ref, computed } from 'vue'

export type Side = 'ours' | 'theirs'

export interface HunkView {
  /** 1-based, as shown to both the agent and the reader. */
  index: number
  /** Pattern name from the classifier, e.g. `same_change`. */
  type: string
  confidenceLabel: string
  confidenceScore: number
  /** Settled by the engine, with no decision to make. */
  autoResolved: boolean
  reason: string
  ours: string[]
  theirs: string[]
  /** The engine's output when it settled this hunk. */
  resolvedLines: string[] | null
  /** A person's call. Only ever set for hunks the engine refused. */
  decision: Side | null
}

/** Normalised at file time so reassembly never has to re-enter the engine. */
export type Segment = { kind: 'text'; lines: string[] } | { kind: 'hunk'; index: number }

export interface ConflictCase {
  id: string
  kind: 'conflict'
  filePath: string
  hunks: HunkView[]
  segments: Segment[]
  at: number
  /** Seeded on arrival so the room is not empty. Labelled as such on screen. */
  example?: boolean
}

export interface ErrorCase {
  id: string
  kind: 'error'
  /** Titles of the catalogue entries that matched, for the case header. */
  titles: string[]
  body: string
  at: number
  /** Seeded on arrival so the room is not empty. Labelled as such on screen. */
  example?: boolean
}

export type RoomCase = ConflictCase | ErrorCase

export interface JournalEntry {
  at: number
  actor: 'agent' | 'you'
  text: string
}

const cases = ref<RoomCase[]>([])
const journal = ref<JournalEntry[]>([])

let seq = 0
const nextId = (prefix: string) => `${prefix}-${++seq}`

function log(actor: JournalEntry['actor'], text: string) {
  // Newest first: on a live demo the interesting line should not require a scroll.
  journal.value = [{ at: Date.now(), actor, text }, ...journal.value].slice(0, 60)
}

export function fileConflict(input: {
  filePath: string
  hunks: HunkView[]
  segments: Segment[]
  example?: boolean
}): ConflictCase {
  const c: ConflictCase = { id: nextId('conflict'), kind: 'conflict', at: Date.now(), ...input }
  cases.value = [...cases.value, c]
  const settled = input.hunks.filter((h) => h.autoResolved).length
  const open = input.hunks.length - settled
  log(
    'agent',
    input.example
      ? `Seeded ${c.id} (${input.filePath}) as an example: ${settled} settled, ${open} waiting on you.`
      : `Filed ${c.id} (${input.filePath}): ${settled} settled, ${open} waiting on you.`,
  )
  return c
}

export function fileError(input: { titles: string[]; body: string; example?: boolean }): ErrorCase {
  const c: ErrorCase = { id: nextId('error'), kind: 'error', at: Date.now(), ...input }
  cases.value = [...cases.value, c]
  const what = input.titles.join('; ') || 'no known git error matched'
  log('agent', input.example ? `Seeded ${c.id} as an example: ${what}.` : `Filed ${c.id}: ${what}.`)
  return c
}

/** A person picks a side on a hunk the engine refused to settle. */
export function decide(caseId: string, hunkIndex: number, side: Side): boolean {
  const c = cases.value.find((x) => x.id === caseId)
  if (!c || c.kind !== 'conflict') return false
  const h = c.hunks.find((x) => x.index === hunkIndex)
  if (!h || h.autoResolved) return false
  h.decision = side
  cases.value = [...cases.value]
  log('you', `Took ${side} on ${caseId} hunk ${hunkIndex}.`)
  return true
}

export function clearRoom() {
  cases.value = []
  journal.value = []
  seq = 0
}

/**
 * The merged file, or null while any hunk is still undecided. Engine output is
 * used where the engine settled it, the person's side everywhere else.
 */
export function finalFile(c: ConflictCase): string | null {
  const byIndex = new Map(c.hunks.map((h) => [h.index, h]))
  const out: string[] = []
  for (const seg of c.segments) {
    if (seg.kind === 'text') {
      out.push(...seg.lines)
      continue
    }
    const h = byIndex.get(seg.index)
    if (!h) return null
    if (h.autoResolved) {
      out.push(...(h.resolvedLines ?? []))
    } else if (h.decision === 'ours') {
      out.push(...h.ours)
    } else if (h.decision === 'theirs') {
      out.push(...h.theirs)
    } else {
      return null
    }
  }
  return out.join('\n')
}

/** What the agent gets back from `list_cases`, and what the header counts. */
export const summary = computed(() => {
  let settled = 0
  let waiting = 0
  let decided = 0
  for (const c of cases.value) {
    if (c.kind !== 'conflict') continue
    for (const h of c.hunks) {
      if (h.autoResolved) settled++
      else if (h.decision) decided++
      else waiting++
    }
  }
  return {
    cases: cases.value.length,
    conflicts: cases.value.filter((c) => c.kind === 'conflict').length,
    errors: cases.value.filter((c) => c.kind === 'error').length,
    hunksSettledByEngine: settled,
    hunksDecidedByYou: decided,
    hunksWaitingOnYou: waiting,
  }
})

export const roomCases = cases
export const roomJournal = journal
export { log as journalLog }
