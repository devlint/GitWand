import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleToolCall } from '../tools/index.js'

// gitwand_resolve_hunk_llm takes the LLM's answer as a plain argument, so no
// LLM call needs mocking; files live in a real temp git repo.

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'gitwand-mcp-hunkllm-'))
  dirs.push(cwd)
  execFileSync('git', ['init', '-b', 'main'], { cwd })
  return cwd
}

const TWO_HUNKS = [
  'head',
  '<<<<<<< ours',
  'a-ours',
  '=======',
  'a-theirs',
  '>>>>>>> theirs',
  'middle',
  '<<<<<<< ours',
  'b-ours',
  '=======',
  'b-theirs',
  '>>>>>>> theirs',
  'tail',
  '',
].join('\n')

async function call(cwd: string, file: string, line: number, resolution: string) {
  const res: any = await handleToolCall(
    'gitwand_resolve_hunk_llm',
    { file, line, resolution },
    cwd,
  )
  return JSON.parse(res.content[0].text)
}

describe('gitwand_resolve_hunk_llm residual marker check', () => {
  it('accepts a valid answer for one hunk and keeps the other hunk intact', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'f.txt'), TWO_HUNKS)

    const out = await call(cwd, 'f.txt', 2, 'a-merged')

    expect(out.accepted).toBe(true)
    expect(out.hasResidualMarkers).toBe(false)
    expect(out.remainingConflicts).toBe(1)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf-8')).toBe(
      [
        'head', 'a-merged', 'middle',
        '<<<<<<< ours', 'b-ours', '=======', 'b-theirs', '>>>>>>> theirs',
        'tail', '',
      ].join('\n'),
    )
  })

  it('still rejects an answer that itself contains markers', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'f.txt'), TWO_HUNKS)

    const out = await call(cwd, 'f.txt', 2, '<<<<<<< x\nfoo\n=======\nbar\n>>>>>>> y')

    expect(out.accepted).toBe(false)
    expect(out.hasResidualMarkers).toBe(true)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf-8')).toBe(TWO_HUNKS)
  })

  it('skips the JSON syntax check while other hunks still have markers', async () => {
    const cwd = makeRepo()
    const json = '{\n<<<<<<< ours\n"a": 1,\n=======\n"a": 2,\n>>>>>>> theirs\n<<<<<<< ours\n"b": 1\n=======\n"b": 2\n>>>>>>> theirs\n}\n'
    writeFileSync(join(cwd, 'f.json'), json)

    const out = await call(cwd, 'f.json', 2, '"a": 3,')

    expect(out.accepted).toBe(true)
    expect(out.syntaxError).toBeNull()
    expect(out.syntaxCheckSkipped).toMatch(/marker/i)
  })

  it('still runs the JSON syntax check once the last hunk is resolved', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'f.json'), '{\n<<<<<<< ours\n"a": 1\n=======\n"a": 2\n>>>>>>> theirs\n}\n')

    const bad = await call(cwd, 'f.json', 2, '"a": ,')
    expect(bad.accepted).toBe(false)
    expect(bad.syntaxError).toMatch(/^JSON:/)

    const ok = await call(cwd, 'f.json', 2, '"a": 3')
    expect(ok.accepted).toBe(true)
    expect(ok.syntaxCheckSkipped).toBeNull()
    expect(ok.remainingConflicts).toBe(0)
  })
})
