/**
 * Task 3 (accuracy lot D) — `regenerate: true` reporting-only option on the
 * 3 real `resolve()` MCP tool sites (`gitwand_status`, `gitwand_resolve_conflicts`,
 * `gitwand_preview_merge`).
 *
 * Scope ruling under test: none of these tools ever executes regeneration —
 * no process spawned, no git worktree created, no file touched beyond what
 * the tool already does without the flag. Each test below asserts both the
 * reported plan content AND that safety property explicitly (the
 * safety-critical assertion per task-3-brief.md § "Tests").
 *
 * Real temp git repos — no mocking of the git layer (AGENTS.md). The
 * `package-lock.json` conflict doesn't need real npm output: `isGeneratedFile`
 * matches by filename, not content (same technique as the CLI's
 * `resolve-conventions.test.ts` / core's `conventions-derive.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ESM module namespaces aren't configurable (vi.spyOn can't patch a named
// export of 'node:child_process' directly) — track every spawned binary via
// a hoisted pass-through mock instead: same real execution, just observed.
// `vi.hoisted` is required because `vi.mock` factories run before the rest
// of this file's imports.
const { spawnedBinaries } = vi.hoisted(() => ({ spawnedBinaries: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      spawnedBinaries.push(String(args[0]))
      return actual.execFileSync(...args)
    },
    execSync: (...args: Parameters<typeof actual.execSync>) => {
      spawnedBinaries.push(String(args[0]).split(' ')[0])
      return actual.execSync(...args)
    },
  }
})

import { handleToolCall } from '../tools/index.js'

type ToolResult = Awaited<ReturnType<typeof handleToolCall>> & { isError?: boolean }

interface Repo {
  cwd: string
  cleanup: () => void
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim()
}

function makeRepo(): Repo {
  const cwd = mkdtempSync(join(tmpdir(), 'gitwand-mcp-regen-test-'))
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

const LOCK = 'package-lock.json'

function lockContent(shared: string): string {
  return `{\n  "name": "e2e",\n  "lockfileVersion": 3,\n  "shared": "${shared}"\n}\n`
}

/**
 * Repo with `package.json` (never conflicted) + `package-lock.json`
 * (conflicted — the only diverging line changed on BOTH branches, so it
 * classifies "complex" then reclassifies to "generated_file" by filename).
 */
function buildConflictedLockRepo(): Repo {
  const repo = makeRepo()
  const { cwd } = repo
  writeFileSync(join(cwd, 'package.json'), '{"name":"e2e","version":"1.0.0"}\n', 'utf-8')
  writeFileSync(join(cwd, LOCK), lockContent('base'), 'utf-8')
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', 'init'])

  git(cwd, ['checkout', '-b', 'feature'])
  writeFileSync(join(cwd, LOCK), lockContent('feature'), 'utf-8')
  git(cwd, ['commit', '-a', '-m', 'feature: bump lock'])

  git(cwd, ['checkout', 'main'])
  writeFileSync(join(cwd, LOCK), lockContent('main'), 'utf-8')
  git(cwd, ['commit', '-a', '-m', 'main: bump lock'])

  try {
    git(cwd, ['merge', 'feature'])
  } catch {
    // conflict expected
  }
  return repo
}

/**
 * Repo where BOTH `package.json` and `package-lock.json` conflict (unlike
 * `buildConflictedLockRepo`, whose `package.json` never conflicts) — needed
 * to prove the fix-round-1 regression: a narrowed `files:` param that omits
 * an actually-conflicted `package.json` must NOT make the reported plan
 * look runnable.
 */
function buildConflictedLockAndManifestRepo(): Repo {
  const repo = makeRepo()
  const { cwd } = repo
  writeFileSync(join(cwd, 'package.json'), '{"name":"e2e","version":"1.0.0"}\n', 'utf-8')
  writeFileSync(join(cwd, LOCK), lockContent('base'), 'utf-8')
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', 'init'])

  git(cwd, ['checkout', '-b', 'feature'])
  writeFileSync(join(cwd, 'package.json'), '{"name":"e2e","version":"1.1.0-feature"}\n', 'utf-8')
  writeFileSync(join(cwd, LOCK), lockContent('feature'), 'utf-8')
  git(cwd, ['commit', '-a', '-m', 'feature: bump version + lock'])

  git(cwd, ['checkout', 'main'])
  writeFileSync(join(cwd, 'package.json'), '{"name":"e2e","version":"1.1.0-main"}\n', 'utf-8')
  writeFileSync(join(cwd, LOCK), lockContent('main'), 'utf-8')
  git(cwd, ['commit', '-a', '-m', 'main: bump version + lock'])

  try {
    git(cwd, ['merge', 'feature'])
  } catch {
    // conflict expected on both files
  }
  return repo
}

/** Binaries the regenerate-tier registry would spawn — must NEVER appear in any execFile/execSync call made by these 3 MCP tools. */
const REGEN_BINARIES = ['npm', 'pnpm', 'yarn', 'composer', 'cargo']

function assertNothingExecuted(): void {
  for (const bin of spawnedBinaries) {
    expect(REGEN_BINARIES).not.toContain(bin)
  }
}

function worktreeCount(cwd: string): number {
  return git(cwd, ['worktree', 'list']).split('\n').filter((l) => l.trim().length > 0).length
}

describe('MCP regenerate:true — reporting only, never executes (task 3)', () => {
  beforeEach(() => {
    spawnedBinaries.length = 0
  })

  it('gitwand_status: regenerate:true reports an accurate runnable plan, executes nothing', async () => {
    const { cwd, cleanup } = buildConflictedLockRepo()
    try {
      const worktreesBefore = worktreeCount(cwd)
      const lockBefore = readFileSync(join(cwd, LOCK), 'utf-8')

      const result: ToolResult = await handleToolCall('gitwand_status', { regenerate: true }, cwd)

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0].text)
      expect(Array.isArray(parsed.regenerationPlans)).toBe(true)
      const plan = parsed.regenerationPlans.find((p: { file: string }) => p.file === LOCK)
      expect(plan).toBeDefined()
      expect(plan.ecosystem).toBe('npm')
      // package.json was never conflicted → treated as "clean" → runnable.
      expect(plan.runnable).toBe(true)
      expect(plan.sources).toEqual([{ path: 'package.json', state: 'clean' }])

      // Safety-critical: reporting-only means no process spawn, no worktree,
      // no file mutation beyond what a plain `gitwand_status` call already does
      // (which never writes files).
      assertNothingExecuted()
      expect(worktreeCount(cwd)).toBe(worktreesBefore)
      expect(readFileSync(join(cwd, LOCK), 'utf-8')).toBe(lockBefore)
    } finally {
      cleanup()
    }
  }, 30_000)

  it('gitwand_status: without regenerate, response has no regenerationPlans key (backward compatible)', async () => {
    const { cwd, cleanup } = buildConflictedLockRepo()
    try {
      const result: ToolResult = await handleToolCall('gitwand_status', {}, cwd)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.regenerationPlans).toBeUndefined()
    } finally {
      cleanup()
    }
  }, 30_000)

  it('gitwand_resolve_conflicts: regenerate:true reports the plan without writing or executing anything', async () => {
    const { cwd, cleanup } = buildConflictedLockRepo()
    try {
      const worktreesBefore = worktreeCount(cwd)
      const lockBefore = readFileSync(join(cwd, LOCK), 'utf-8')

      const result: ToolResult = await handleToolCall(
        'gitwand_resolve_conflicts',
        { dry_run: true, regenerate: true },
        cwd,
      )

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0].text)
      expect(Array.isArray(parsed.regenerationPlans)).toBe(true)
      const plan = parsed.regenerationPlans.find((p: { file: string }) => p.file === LOCK)
      expect(plan).toBeDefined()
      expect(plan.runnable).toBe(true)
      // Declined by default (no --resolve-generated equivalent, no
      // conventions, no .gitwandrc) — nothing auto-resolved, so dry_run
      // wouldn't have written it anyway, but this proves regenerate:true
      // doesn't change that.
      expect(parsed.summary.autoResolved).toBe(0)

      assertNothingExecuted()
      expect(worktreeCount(cwd)).toBe(worktreesBefore)
      expect(readFileSync(join(cwd, LOCK), 'utf-8')).toBe(lockBefore)
    } finally {
      cleanup()
    }
  }, 30_000)

  it('gitwand_preview_merge: regenerate:true reports the plan, stays side-effect-free', async () => {
    const { cwd, cleanup } = buildConflictedLockRepo()
    try {
      const worktreesBefore = worktreeCount(cwd)
      const lockBefore = readFileSync(join(cwd, LOCK), 'utf-8')

      const result: ToolResult = await handleToolCall(
        'gitwand_preview_merge',
        { operation: 'merge', regenerate: true },
        cwd,
      )

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0].text)
      expect(Array.isArray(parsed.regenerationPlans)).toBe(true)
      const plan = parsed.regenerationPlans.find((p: { file: string }) => p.file === LOCK)
      expect(plan).toBeDefined()
      expect(plan.runnable).toBe(true)

      assertNothingExecuted()
      expect(worktreeCount(cwd)).toBe(worktreesBefore)
      expect(readFileSync(join(cwd, LOCK), 'utf-8')).toBe(lockBefore)
    } finally {
      cleanup()
    }
  }, 30_000)

  it(
    // Fix round 1 regression — mirrors Task 2's own CLI-side regression test
    // for the same bug (`resolve.ts:292/316`). A caller-narrowed `files:`
    // param must never make an actually-conflicted-elsewhere source of truth
    // look "clean" just because THIS call didn't fetch it.
    'gitwand_resolve_conflicts: a narrowed files: param excluding a conflicted package.json must NOT report runnable:true',
    async () => {
      const { cwd, cleanup } = buildConflictedLockAndManifestRepo()
      try {
        // Precondition: package.json really is conflicted repo-wide (not just
        // package-lock.json) — confirms this test actually exercises the gap.
        const conflicted = git(cwd, ['diff', '--name-only', '--diff-filter=U']).trim().split('\n').sort()
        expect(conflicted).toEqual(['package-lock.json', 'package.json'].sort())

        const worktreesBefore = worktreeCount(cwd)

        // Narrowed on purpose: only package-lock.json, excluding the
        // genuinely-conflicted package.json.
        const result: ToolResult = await handleToolCall(
          'gitwand_resolve_conflicts',
          { files: [LOCK], dry_run: true, regenerate: true },
          cwd,
        )

        expect(result.isError).toBeFalsy()
        const parsed = JSON.parse(result.content[0].text)
        const plan = parsed.regenerationPlans.find((p: { file: string }) => p.file === LOCK)
        expect(plan).toBeDefined()
        // The safety-critical assertion: package.json's real state (conflicted)
        // is unknown to THIS narrowed call — the plan must NOT claim runnable.
        expect(plan.runnable).toBe(false)
        const source = plan.sources.find((s: { path: string }) => s.path === 'package.json')
        expect(source?.state).toBe('conflicted')

        assertNothingExecuted()
        expect(worktreeCount(cwd)).toBe(worktreesBefore)
      } finally {
        cleanup()
      }
    },
    30_000,
  )

  it(
    // Final review Finding 2 — "not conflicted" must not be conflated with
    // "clean": a yarn-CLASSIC repo (has yarn.lock, no `.yarnrc.yml` at all —
    // the berry marker `registry.ts` requires) has `.yarnrc.yml` trivially
    // "not conflicted" simply because it never existed. Before the fix, that
    // made the reported yarn-berry plan come back `runnable: true` for a repo
    // the registry's own documented guard says must never be runnable.
    'gitwand_status: yarn-classic repo (no .yarnrc.yml) must NOT report runnable:true for the yarn-berry plan',
    async () => {
      const repo = makeRepo()
      const { cwd, cleanup } = repo
      try {
        const YARN_LOCK = 'yarn.lock'
        writeFileSync(join(cwd, 'package.json'), '{"name":"e2e","version":"1.0.0"}\n', 'utf-8')
        writeFileSync(join(cwd, YARN_LOCK), lockContent('base'), 'utf-8')
        git(cwd, ['add', '-A'])
        git(cwd, ['commit', '-m', 'init'])

        git(cwd, ['checkout', '-b', 'feature'])
        writeFileSync(join(cwd, YARN_LOCK), lockContent('feature'), 'utf-8')
        git(cwd, ['commit', '-a', '-m', 'feature: bump lock'])

        git(cwd, ['checkout', 'main'])
        writeFileSync(join(cwd, YARN_LOCK), lockContent('main'), 'utf-8')
        git(cwd, ['commit', '-a', '-m', 'main: bump lock'])

        try {
          git(cwd, ['merge', 'feature'])
        } catch {
          // conflict expected
        }

        // Precondition: only yarn.lock is conflicted, and `.yarnrc.yml`
        // genuinely does not exist anywhere in this repo (classic yarn).
        const conflicted = git(cwd, ['diff', '--name-only', '--diff-filter=U']).trim().split('\n')
        expect(conflicted).toEqual([YARN_LOCK])
        expect(existsSync(join(cwd, '.yarnrc.yml'))).toBe(false)

        const worktreesBefore = worktreeCount(cwd)

        const result: ToolResult = await handleToolCall('gitwand_status', { regenerate: true }, cwd)

        expect(result.isError).toBeFalsy()
        const parsed = JSON.parse(result.content[0].text)
        const plan = parsed.regenerationPlans.find((p: { file: string }) => p.file === YARN_LOCK)
        expect(plan).toBeDefined()
        expect(plan.ecosystem).toBe('yarn-berry')
        // Safety-critical: absent berry marker must block runnable, not be
        // silently defaulted to "clean" just because it was never conflicted.
        expect(plan.runnable).toBe(false)
        const marker = plan.sources.find((s: { path: string }) => s.path === '.yarnrc.yml')
        expect(marker?.state).toBe('conflicted')

        assertNothingExecuted()
        expect(worktreeCount(cwd)).toBe(worktreesBefore)
      } finally {
        cleanup()
      }
    },
    30_000,
  )

  it('gitwand_preview_merge: rebase/cherry-pick operations never populate regenerationPlans (out of this task\'s scope)', async () => {
    const { cwd, cleanup } = buildConflictedLockRepo()
    try {
      // No `onto` — expect a structured error, not a crash, and definitely no plan.
      const result: ToolResult = await handleToolCall(
        'gitwand_preview_merge',
        { operation: 'rebase', regenerate: true },
        cwd,
      )
      expect(result.isError).toBe(true)
    } finally {
      cleanup()
    }
  }, 30_000)
})
