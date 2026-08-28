import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { detectSurface, registerTools, type WebMcpTool } from '../webmcp'
import { matchGitErrors } from '../tools/git-errors'
import { parseGitErrorTool, resolveConflictTool } from '../tools'
import { SAMPLE_GIT_ERROR, SAMPLE_CONFLICT } from '../tools/samples'

// resolve_conflict loads @gitwand/core through a dynamic import, and the vitest
// alias points at the TypeScript source rather than a built dist, so the first
// call pays for Vite transforming the whole engine. That is comfortably over
// vitest's 5s default on a cold cache (5028ms observed), and warm on every run
// after, which is exactly the shape of a test that passes locally and fails in
// CI. See issue #172 for the same problem in the git-backed suites.
const ENGINE_LOAD_TIMEOUT_MS = 30_000

function fakeModelContext() {
  const calls: { tool: WebMcpTool; options?: { signal?: AbortSignal } }[] = []
  return {
    calls,
    registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }) {
      calls.push({ tool, options })
      return Promise.resolve()
    },
  }
}

const g = globalThis as any

describe('surface detection', () => {
  beforeEach(() => {
    // Node 21+ defines globalThis.navigator as a getter-only property, so it
    // has to be stubbed rather than assigned.
    vi.stubGlobal('document', {})
    vi.stubGlobal('navigator', {})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('returns null when the browser has no WebMCP at all', () => {
    expect(detectSurface()).toBe(null)
  })

  it('prefers document, which is where the spec puts it', () => {
    g.document.modelContext = fakeModelContext()
    g.navigator.modelContext = fakeModelContext()
    expect(detectSurface()).toBe('document')
  })

  it('falls back to the deprecated navigator location when it is the only one', () => {
    g.navigator.modelContext = fakeModelContext()
    expect(detectSurface()).toBe('navigator')
  })
})

describe('registration', () => {
  const tool: WebMcpTool = {
    name: 'noop',
    description: 'does nothing',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  }

  beforeEach(() => {
    // Node 21+ defines globalThis.navigator as a getter-only property, so it
    // has to be stubbed rather than assigned.
    vi.stubGlobal('document', {})
    vi.stubGlobal('navigator', {})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('registers each tool exactly once when both locations are aliases', async () => {
    // Chrome 150 keeps navigator.modelContext as an alias to the same object.
    // Registering on both surfaces would register every tool twice.
    const shared = fakeModelContext()
    g.document.modelContext = shared
    g.navigator.modelContext = shared

    const ac = new AbortController()
    const outcome = await registerTools([tool], { signal: ac.signal })

    expect(outcome.surface).toBe('document')
    expect(outcome.registered).toEqual(['noop'])
    expect(shared.calls).toHaveLength(1)
  })

  it('passes the signal in the options argument, not on the tool dictionary', async () => {
    // ModelContextTool declares no `signal` member, so a signal set on the tool
    // itself is dropped and the tool can never be unregistered.
    const mc = fakeModelContext()
    g.document.modelContext = mc
    const ac = new AbortController()

    await registerTools([tool], { signal: ac.signal })

    expect(mc.calls[0].options?.signal).toBe(ac.signal)
    expect((mc.calls[0].tool as any).signal).toBeUndefined()
  })

  it('reports a failing registration instead of throwing', async () => {
    g.document.modelContext = {
      registerTool: () => Promise.reject(new Error('name already taken')),
    }
    const outcome = await registerTools([tool], { signal: new AbortController().signal })

    expect(outcome.registered).toEqual([])
    expect(outcome.failed).toEqual([{ name: 'noop', reason: 'name already taken' }])
  })

  it('counts every call through onCall', async () => {
    const mc = fakeModelContext()
    g.document.modelContext = mc
    const onCall = vi.fn()

    await registerTools([tool], { signal: new AbortController().signal, onCall })
    const registered = mc.calls[0].tool
    await registered.execute({}, { signal: new AbortController().signal })
    await registered.execute({}, { signal: new AbortController().signal })

    expect(onCall).toHaveBeenCalledTimes(2)
    expect(onCall).toHaveBeenCalledWith('noop')
  })

  it('does nothing, and says so, when the browser has no WebMCP', async () => {
    const outcome = await registerTools([tool], { signal: new AbortController().signal })
    expect(outcome).toEqual({ surface: null, registered: [], failed: [] })
  })
})

describe('matchGitErrors', () => {
  it('recognises a merge conflict', () => {
    const out = matchGitErrors(
      'Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
    )
    expect(out.map((m) => m.entry.id)).toContain('merge_conflict')
  })

  it('reports every error in a paste, not just the first', () => {
    const out = matchGitErrors(
      [
        'error: failed to push some refs to git@github.com:acme/app.git',
        'hint: Updates were rejected because the remote contains work that you do not have.',
        'fatal: You have not concluded your merge (MERGE_HEAD exists).',
      ].join('\n'),
    )
    const ids = out.map((m) => m.entry.id)
    expect(ids).toContain('push_rejected')
    expect(ids).toContain('merge_head_exists')
  })

  it('never reports the same entry twice', () => {
    const out = matchGitErrors('CONFLICT (content): a\nCONFLICT (content): b\nCONFLICT (content): c')
    expect(out.filter((m) => m.entry.id === 'merge_conflict')).toHaveLength(1)
  })

  it('returns nothing for output it does not know', () => {
    expect(matchGitErrors('Everything up-to-date')).toEqual([])
  })

  it('names GitWand on conflicts and stays quiet elsewhere', () => {
    const conflict = matchGitErrors('CONFLICT (content): Merge conflict in a.ts')
    expect(conflict[0].entry.gitwand).toBeTruthy()

    const auth = matchGitErrors('remote: Authentication failed for https://github.com/acme/app')
    expect(auth[0].entry.gitwand).toBeUndefined()
  })
})

describe('parse_git_error tool', () => {
  const signal = new AbortController().signal

  it('explains a recognised failure', async () => {
    const r = await parseGitErrorTool.execute(
      { output: 'fatal: refusing to merge unrelated histories' },
      { signal },
    )
    expect(r.content[0].text).toContain('share no common commit')
    expect(r.content[0].text).toContain('--allow-unrelated-histories')
  })

  it('asks for input rather than guessing when given none', async () => {
    const r = await parseGitErrorTool.execute({ output: '   ' }, { signal })
    expect(r.content[0].text).toContain('No output provided')
  })

  it('says plainly when nothing matched', async () => {
    const r = await parseGitErrorTool.execute({ output: 'Everything up-to-date' }, { signal })
    expect(r.content[0].text).toContain('No known git error matched')
  })
})

describe('resolve_conflict tool', { timeout: ENGINE_LOAD_TIMEOUT_MS }, () => {
  const signal = new AbortController().signal

  it('resolves a hunk that carries no decision', async () => {
    const conflicted = [
      'const a = 1',
      '<<<<<<< ours',
      'const b = 3',
      '||||||| base',
      'const b = 2',
      '=======',
      'const b = 3',
      '>>>>>>> theirs',
      'const c = 4',
    ].join('\n')

    const r = await resolveConflictTool.execute({ content: conflicted, filePath: 'src/a.ts' }, { signal })
    const text = r.content[0].text

    expect(text).toContain('same_change')
    expect(text).toContain('1 resolved deterministically, 0 left for you')
    expect(text).toContain('const b = 3')
    expect(text).not.toContain('<<<<<<<')
  })

  it('hands back a genuinely overlapping edit instead of guessing', async () => {
    const conflicted = [
      '<<<<<<< ours',
      'const x = 1',
      '||||||| base',
      'const x = 0',
      '=======',
      'const x = 2',
      '>>>>>>> theirs',
    ].join('\n')

    const r = await resolveConflictTool.execute({ content: conflicted, filePath: 'src/a.ts' }, { signal })
    const text = r.content[0].text

    expect(text).toContain('complex')
    expect(text).toContain('NEEDS REVIEW')
  })

  it('rejects content with no conflict markers', async () => {
    const r = await resolveConflictTool.execute({ content: 'const a = 1' }, { signal })
    expect(r.content[0].text).toContain('No conflict markers found')
  })

  it('rejects empty input', async () => {
    const r = await resolveConflictTool.execute({ content: '' }, { signal })
    expect(r.content[0].text).toContain('No content provided')
  })
})

describe('try-it panel samples', { timeout: ENGINE_LOAD_TIMEOUT_MS }, () => {
  const signal = new AbortController().signal

  it('the conflict sample shows both halves of the pitch in one run', async () => {
    // The whole point of this sample is that it resolves one hunk and refuses
    // the other. If a pattern change ever makes it resolve both, or neither,
    // the demo stops demonstrating anything and this test should say so.
    const r = await resolveConflictTool.execute(
      { content: SAMPLE_CONFLICT, filePath: 'src/server.ts' },
      { signal },
    )
    const text = r.content[0].text

    expect(text).toContain('2 conflicts found')
    expect(text).toContain('1 resolved deterministically, 1 left for you')
    // Pin the classifications, not just the counts. A sample where both hunks
    // land on `complex` still satisfies the counts while showing the reader
    // nothing about how the engine decides.
    expect(text).toContain('same_change')
    expect(text).toContain('complex')
    expect(text).toContain('NEEDS REVIEW')
  })

  it('the git error sample matches more than one failure', async () => {
    // Chosen to show that a real paste usually carries several problems and
    // that the tool reports all of them rather than the first.
    const ids = matchGitErrors(SAMPLE_GIT_ERROR).map((m) => m.entry.id)
    expect(ids).toContain('push_rejected')
    expect(ids).toContain('merge_head_exists')

    const r = await parseGitErrorTool.execute({ output: SAMPLE_GIT_ERROR }, { signal })
    expect(r.content[0].text).toContain('2 known git errors matched')
  })
})
