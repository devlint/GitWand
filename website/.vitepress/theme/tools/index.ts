/**
 * The tools this page exposes to agents.
 *
 * All read-only with respect to your machine: nothing is uploaded, nothing runs
 * git, and there is no backend to reach. What they do write to is the Merge
 * Room on the page itself, so an agent's work shows up in front of the person
 * sitting there rather than disappearing into the transcript.
 *
 * Deliberately absent: any tool that picks a side on a conflicted hunk. The
 * engine settles hunks that carry no decision; everything else queues for a
 * human. That boundary is the product.
 */
import type { WebMcpTool } from '../webmcp'
import { text } from '../webmcp'
import { matchGitErrors } from './git-errors'
import { fileConflict, fileError, roomCases, summary, finalFile, type HunkView, type Segment } from '../room'

/** Keep a single tool response from swallowing an agent's context window. */
const MAX_CONTENT_CHARS = 20_000

function truncate(body: string): string {
  if (body.length <= MAX_CONTENT_CHARS) return body
  return `${body.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated at ${MAX_CONTENT_CHARS} characters]`
}

export const parseGitErrorTool: WebMcpTool = {
  name: 'parse_git_error',
  description:
    'Explain a git command that failed, and file it into the Merge Room on this page so the person watching sees it. Paste the raw stderr or stdout of the failing command and get back the cause in plain language plus the specific commands that resolve it. Handles merge conflicts, rejected pushes, unrelated histories, detached HEAD, an interrupted merge, rebase or cherry-pick, authentication failures and other common git errors. Read-only: it never runs git and never touches the repository.',
  inputSchema: {
    type: 'object',
    properties: {
      output: {
        type: 'string',
        description: 'The raw output of the failing git command, copied verbatim. Multiple errors in one paste are all reported.',
      },
    },
    required: ['output'],
  },
  async execute({ output }: { output: string }) {
    if (typeof output !== 'string' || output.trim() === '') {
      return text('No output provided. Pass the raw text of the failing git command as `output`.')
    }

    const matches = matchGitErrors(output)
    if (matches.length === 0) {
      const body = [
        'No known git error matched this output.',
        '',
        'This catalogue covers the common failures (conflicts, rejected pushes, unrelated histories, detached HEAD, an interrupted merge, rebase or cherry-pick, authentication). An unmatched paste is usually either a tool wrapping git, or a genuine edge case worth reading the full output for.',
        '',
        'Useful next command: `git status` prints the repository state that most git errors are really about.',
      ].join('\n')
      fileError({ titles: [], body })
      return text(body)
    }

    const sections = matches.map(({ entry, matchedOn }) => {
      const fixes = entry.fixes.map((f) => `  ${f.command}\n      ${f.when}`).join('\n')
      return [
        `## ${entry.title}`,
        matchedOn ? `Matched on: ${matchedOn}` : '',
        '',
        entry.cause,
        '',
        'Commands:',
        fixes,
        entry.gitwand ? `\nGitWand: ${entry.gitwand}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })

    const header =
      matches.length === 1
        ? 'One known git error matched.'
        : `${matches.length} known git errors matched this output, listed in the order they should be dealt with.`

    const body = truncate([header, ...sections].join('\n\n'))
    fileError({ titles: matches.map((m) => m.entry.title), body })
    return text(body)
  },
}

export const resolveConflictTool: WebMcpTool = {
  name: 'resolve_conflict',
  description:
    "Resolve a file containing git conflict markers, and file it into the Merge Room on this page. Hunks that carry no real decision (identical edits on both sides, pure reordering, whitespace, insertions at different positions, generated files) are resolved deterministically. Hunks where the two branches genuinely disagree are NOT resolved: they queue for the person at the page to pick a side, and this tool cannot make that call. Returns a per-hunk classification with the pattern name, confidence score and reason for each. No model is involved and nothing is guessed. Runs in the browser tab: the file content is never uploaded.",
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The complete conflicted file, including the <<<<<<<, ======= and >>>>>>> markers. Pass the whole file, not just the conflicted region.',
      },
      filePath: {
        type: 'string',
        description:
          'Path of the file, e.g. "src/config.json" or "pnpm-lock.yaml". This changes the result: the extension selects format-aware resolvers (JSON, YAML, TypeScript imports, Vue SFC, CSS, lockfiles) and the path is what identifies a generated file. Pass the real path when you have it.',
      },
    },
    required: ['content'],
  },
  async execute({ content, filePath }: { content: string; filePath?: string }) {
    if (typeof content !== 'string' || content.trim() === '') {
      return text('No content provided. Pass the full conflicted file as `content`.')
    }
    if (!content.includes('<<<<<<<')) {
      return text(
        'No conflict markers found in this content. `resolve_conflict` expects a file left conflicted by git, containing <<<<<<<, ======= and >>>>>>> markers. If git reported a conflict but the file has no markers, the conflict is probably a tree-level one (add/add, delete/modify), which `git status` will name.',
      )
    }

    const path = typeof filePath === 'string' && filePath.trim() !== '' ? filePath : 'unknown.txt'

    let result
    let parsed
    try {
      // Loaded on demand, not at module scope. AgentPage is registered in the
      // shared theme entry, so a static import pulls the whole engine into the
      // chunk that every page of the site downloads. This way only a real call
      // to resolve_conflict pays for it.
      const { resolve, parseConflictMarkers } = await import('@gitwand/core')
      result = resolve(content, path)
      parsed = parseConflictMarkers(content)
    } catch (err) {
      return text(`The resolver failed on this input: ${err instanceof Error ? err.message : String(err)}`)
    }

    const { stats, resolutions, mergedContent, validation } = result

    // resolve() walks the same segments in the same order, so the nth conflict
    // segment is the nth resolution. Normalising here means reassembling the
    // file after a human decision never has to re-enter the engine.
    const hunks: HunkView[] = resolutions.map((r, i) => ({
      index: i + 1,
      type: r.hunk.type,
      confidenceLabel: r.hunk.confidence.label,
      confidenceScore: r.hunk.confidence.score,
      autoResolved: r.autoResolved,
      reason: r.resolutionReason,
      ours: r.hunk.oursLines,
      theirs: r.hunk.theirsLines,
      resolvedLines: r.resolvedLines,
      decision: null,
    }))

    let n = 0
    const segments: Segment[] = parsed.segments.map((s) =>
      s.type === 'text' ? { kind: 'text' as const, lines: s.lines } : { kind: 'hunk' as const, index: ++n },
    )

    const filed = fileConflict({ filePath: path, hunks, segments })

    const hunkLines = hunks.map(
      (h) =>
        `  [${h.index}] ${h.type} (${h.confidenceLabel}, score ${h.confidenceScore}) — ${h.autoResolved ? 'resolved' : 'NEEDS REVIEW'}\n      ${h.reason}`,
    )

    const out = [
      `Filed as ${filed.id} in the Merge Room on the page.`,
      '',
      `${stats.totalConflicts} conflict${stats.totalConflicts === 1 ? '' : 's'} found in ${path}.`,
      `${stats.autoResolved} resolved deterministically, ${stats.remaining} left for you.`,
      '',
      'Per hunk:',
      ...hunkLines,
    ]

    if (!validation.isValid) {
      const reasons: string[] = []
      if (validation.hasResidualMarkers) {
        reasons.push(`conflict markers still present at line ${validation.residualMarkerLines.join(', ')}`)
      }
      if (validation.syntaxError) reasons.push(validation.syntaxError)
      out.push('', `Post-merge validation rejected this result: ${reasons.join('; ')}. Treat the merged output below as untrusted.`)
    }

    if (mergedContent === null) {
      out.push(
        '',
        `${stats.remaining} hunk${stats.remaining === 1 ? '' : 's'} could not be resolved without a decision. Do not guess a side: the person at the page picks one in the Merge Room, and the merged file appears there once they have. Call list_cases to see what is still waiting.`,
      )
      return text(truncate(out.join('\n')))
    }

    out.push('', 'Merged file:', '', mergedContent)
    return text(truncate(out.join('\n')))
  },
}

export const listCasesTool: WebMcpTool = {
  name: 'list_cases',
  description:
    'Read the current state of the Merge Room on this page: every conflict and git error filed so far, which hunks the engine settled, which are still waiting on a human decision, and which the human has already decided. Call this to see what is outstanding before deciding what to do next, or after asking the person to make a call. Takes no arguments.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const s = summary.value
    if (s.cases === 0) {
      return text('The Merge Room is empty. Nothing has been filed yet.')
    }

    const lines: string[] = [
      `${s.cases} case${s.cases === 1 ? '' : 's'} filed: ${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'}, ${s.errors} git error${s.errors === 1 ? '' : 's'}.`,
      `Hunks: ${s.hunksSettledByEngine} settled by the engine, ${s.hunksDecidedByYou} decided by the human, ${s.hunksWaitingOnYou} still waiting.`,
      '',
    ]

    for (const c of roomCases.value) {
      if (c.kind === 'error') {
        lines.push(`${c.id}: git error — ${c.titles.join('; ') || 'unmatched'}`)
        continue
      }
      const waiting = c.hunks.filter((h) => !h.autoResolved && !h.decision)
      const final = finalFile(c)
      lines.push(
        `${c.id}: ${c.filePath} — ${c.hunks.length} hunk${c.hunks.length === 1 ? '' : 's'}, ` +
          (waiting.length
            ? `waiting on hunk ${waiting.map((h) => h.index).join(', ')} (${waiting.map((h) => h.type).join(', ')})`
            : final
              ? 'complete, merged file available on the page'
              : 'complete'),
      )
    }

    return text(truncate(lines.join('\n')))
  },
}

export const TOOLS: WebMcpTool[] = [resolveConflictTool, parseGitErrorTool, listCasesTool]
