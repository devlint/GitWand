import { describe, it, expect, beforeEach } from 'vitest'
import { clearRoom, decide, finalFile, roomCases, roomJournal, summary, type ConflictCase } from '../room'
import { resolveConflictTool, parseGitErrorTool, listCasesTool } from '../tools'

const signal = new AbortController().signal
const M = (a: string[]) => a.join('\n')

/** One settled hunk, one the engine refuses, and text on both sides of each. */
const MIXED = M([
  'const header = 1',
  '<<<<<<< ours',
  'const shared = 42',
  '||||||| base',
  'const shared = 0',
  '=======',
  'const shared = 42',
  '>>>>>>> theirs',
  'const middle = 2',
  '<<<<<<< ours',
  'const argued = "a"',
  '||||||| base',
  'const argued = "base"',
  '=======',
  'const argued = "b"',
  '>>>>>>> theirs',
  'const footer = 3',
])

const asConflict = (i = 0) => roomCases.value[i] as ConflictCase

describe('the Merge Room', { timeout: 30_000 }, () => {
  beforeEach(() => clearRoom())

  it('splits what the engine settled from what waits on a person', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })

    expect(summary.value.conflicts).toBe(1)
    expect(summary.value.hunksSettledByEngine).toBe(1)
    expect(summary.value.hunksWaitingOnYou).toBe(1)
    expect(summary.value.hunksDecidedByYou).toBe(0)

    const c = asConflict()
    expect(c.hunks[0].type).toBe('same_change')
    expect(c.hunks[0].autoResolved).toBe(true)
    expect(c.hunks[1].autoResolved).toBe(false)
  })

  it('withholds the merged file until every hunk has a side', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })
    const c = asConflict()

    expect(finalFile(c)).toBe(null)

    decide(c.id, 2, 'ours')
    expect(finalFile(asConflict())).not.toBe(null)
  })

  it('assembles the file from engine output, the human choice, and the untouched text', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })
    decide(asConflict().id, 2, 'theirs')

    const out = finalFile(asConflict())!
    expect(out).toBe(
      M(['const header = 1', 'const shared = 42', 'const middle = 2', 'const argued = "b"', 'const footer = 3']),
    )
    // The thing that would ruin a demo: markers surviving into the result.
    expect(out).not.toContain('<<<<<<<')
    expect(out).not.toContain('=======')
  })

  it('honours the other side too, so the choice is real', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })
    decide(asConflict().id, 2, 'ours')
    expect(finalFile(asConflict())).toContain('const argued = "a"')
  })

  it('refuses to let anyone override a hunk the engine settled', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })
    const c = asConflict()

    expect(decide(c.id, 1, 'theirs')).toBe(false)
    expect(asConflict().hunks[0].decision).toBe(null)
  })

  it('records both actors in the journal', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })
    decide(asConflict().id, 2, 'ours')

    const actors = roomJournal.value.map((e) => e.actor)
    expect(actors).toContain('agent')
    expect(actors).toContain('you')
  })

  it('files git errors as cases too', async () => {
    await parseGitErrorTool.execute({ output: 'fatal: refusing to merge unrelated histories' }, { signal })
    expect(summary.value.errors).toBe(1)
    expect(roomCases.value[0].kind).toBe('error')
  })

  it('reports an empty room rather than pretending', async () => {
    const r = await listCasesTool.execute({}, { signal })
    expect(r.content[0].text).toContain('The Merge Room is empty')
  })

  it('tells an agent exactly which hunk is blocking', async () => {
    await resolveConflictTool.execute({ content: MIXED, filePath: 'src/app.ts' }, { signal })
    const before = (await listCasesTool.execute({}, { signal })).content[0].text
    expect(before).toContain('waiting on hunk 2')
    expect(before).toContain('1 settled by the engine')

    decide(asConflict().id, 2, 'ours')
    const after = (await listCasesTool.execute({}, { signal })).content[0].text
    expect(after).toContain('merged file available on the page')
    expect(after).toContain('1 decided by the human')
  })
})
