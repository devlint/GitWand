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

describe('gitwand_resolve_hunk_llm YAML syntax check', () => {
  it('rejects a resolution that leaves the YAML file unparseable', async () => {
    const cwd = makeRepo()
    const yaml = ['name: app', '<<<<<<< ours', 'port: 80', '=======', 'port: 81', '>>>>>>> theirs', ''].join('\n')
    writeFileSync(join(cwd, 'c.yaml'), yaml)

    const out = await call(cwd, 'c.yaml', 2, 'port: [80')

    expect(out.accepted).toBe(false)
    expect(out.syntaxError).toMatch(/^YAML:/)
    expect(readFileSync(join(cwd, 'c.yaml'), 'utf-8')).toBe(yaml)
  })

  it('accepts a resolution that keeps the YAML file valid', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'c.yml'), ['name: app', '<<<<<<< ours', 'port: 80', '=======', 'port: 81', '>>>>>>> theirs', ''].join('\n'))

    const out = await call(cwd, 'c.yml', 2, 'port: 81')

    expect(out.accepted).toBe(true)
    expect(out.syntaxError).toBeNull()
    expect(readFileSync(join(cwd, 'c.yml'), 'utf-8')).toBe('name: app\nport: 81\n')
  })
})

describe('empty resolutions remove the conflict block', () => {
  it('gitwand_resolve_hunk_llm accepts an empty resolution and deletes the block', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'f.txt'), TWO_HUNKS)

    const out = await call(cwd, 'f.txt', 2, '')

    expect(out.accepted).toBe(true)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf-8')).toBe(
      ['head', 'middle', '<<<<<<< ours', 'b-ours', '=======', 'b-theirs', '>>>>>>> theirs', 'tail', ''].join('\n'),
    )
  })

  it('gitwand_apply_resolution accepts empty content and deletes the block', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'f.txt'), TWO_HUNKS)

    const res: any = await handleToolCall('gitwand_apply_resolution', { file: 'f.txt', line: 8, content: '' }, cwd)

    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0].text).applied).toBe(true)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf-8')).toBe(
      ['head', '<<<<<<< ours', 'a-ours', '=======', 'a-theirs', '>>>>>>> theirs', 'middle', 'tail', ''].join('\n'),
    )
  })

  it('both write tools still reject a missing resolution', async () => {
    const cwd = makeRepo()
    writeFileSync(join(cwd, 'f.txt'), TWO_HUNKS)

    const a: any = await handleToolCall('gitwand_apply_resolution', { file: 'f.txt', line: 2 }, cwd)
    const b: any = await handleToolCall('gitwand_resolve_hunk_llm', { file: 'f.txt', line: 2 }, cwd)

    expect(a.isError).toBe(true)
    expect(b.isError).toBe(true)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf-8')).toBe(TWO_HUNKS)
  })
})
