/**
 * The tools this page exposes to agents.
 *
 * Both are read-only and run entirely in the visitor's tab: nothing is
 * uploaded, and there is no backend to upload it to. That is the point of
 * putting them here rather than behind an API.
 */
import type { WebMcpTool } from '../webmcp'
import { text } from '../webmcp'
import { matchGitErrors } from './git-errors'

/** Keep a single tool response from swallowing an agent's context window. */
const MAX_CONTENT_CHARS = 20_000

function truncate(body: string): string {
  if (body.length <= MAX_CONTENT_CHARS) return body
  return `${body.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated at ${MAX_CONTENT_CHARS} characters]`
}

export const parseGitErrorTool: WebMcpTool = {
  name: 'parse_git_error',
  description:
    'Explain a git command that failed. Paste the raw stderr or stdout of the failing command and get back the cause in plain language plus the specific commands that resolve it. Handles merge conflicts, rejected pushes, unrelated histories, detached HEAD, interrupted merges and rebases, authentication failures and other common git errors. Read-only: it never runs git and never touches the repository.',
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
      return text(
        [
          'No known git error matched this output.',
          '',
          'This catalogue covers the common failures (conflicts, rejected pushes, unrelated histories, detached HEAD, interrupted merge or rebase, authentication). An unmatched paste is usually either a tool wrapping git, or a genuine edge case worth reading the full output for.',
          '',
          'Useful next command: `git status` prints the repository state that most git errors are really about.',
        ].join('\n'),
      )
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

    return text(truncate([header, '', ...sections].join('\n\n')))
  },
}

export const resolveConflictTool: WebMcpTool = {
  name: 'resolve_conflict',
  description:
    "Resolve a file that contains git conflict markers. Pass the full conflicted file content and get back the merged result, plus a per-hunk classification saying which conflicts were resolved deterministically and which still need a human decision. Hunks that carry no real decision (identical edits on both sides, pure reordering, whitespace, insertions at different positions, generated files) are resolved; genuinely overlapping edits are handed back untouched with the reason. No model is involved and nothing is guessed. Runs in the browser tab: the file content is never uploaded.",
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
    try {
      // Loaded on demand, not at module scope. AgentPage is registered in the
      // shared theme entry, so a static import pulls the whole engine into the
      // chunk that every page of the site downloads. This way only a real call
      // to resolve_conflict pays for it.
      const { resolve } = await import('@gitwand/core')
      result = resolve(content, path)
    } catch (err) {
      return text(`The resolver failed on this input: ${err instanceof Error ? err.message : String(err)}`)
    }

    const { stats, resolutions, mergedContent, validation } = result

    const hunkLines = resolutions.map((r, i) => {
      const status = r.autoResolved ? 'resolved' : 'NEEDS REVIEW'
      const conf = r.hunk.confidence
      return `  [${i + 1}] ${r.hunk.type} (${conf.label}, score ${conf.score}) — ${status}\n      ${r.resolutionReason}`
    })

    const summary = [
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
      summary.push('', `Post-merge validation rejected this result: ${reasons.join('; ')}. Treat the merged output below as untrusted.`)
    }

    if (mergedContent === null) {
      summary.push(
        '',
        `${stats.remaining} hunk${stats.remaining === 1 ? '' : 's'} could not be resolved without a decision, so no merged file is returned. The conflict markers for those hunks are still in place. Resolve them by hand, or ask the user which side to take.`,
      )
      return text(truncate(summary.join('\n')))
    }

    summary.push('', 'Merged file:', '', mergedContent)
    return text(truncate(summary.join('\n')))
  },
}

export const TOOLS: WebMcpTool[] = [parseGitErrorTool, resolveConflictTool]
