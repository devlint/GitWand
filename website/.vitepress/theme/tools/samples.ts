/**
 * The inputs the /agent try-it panel starts with.
 *
 * They live here rather than in the component so they can be asserted: a
 * sample that quietly stops demonstrating the thing it was chosen to
 * demonstrate is worse than no sample. See __tests__/webmcp.test.ts.
 *
 * Assembled from arrays so no line of this file literally begins with a
 * conflict marker. A source file carrying real markers trips merge-conflict
 * detectors, GitWand's own post-merge validation among them.
 */
export const SAMPLE_GIT_ERROR = [
  'To github.com:acme/app.git',
  ' ! [rejected]        main -> main (non-fast-forward)',
  "error: failed to push some refs to 'github.com:acme/app.git'",
  'hint: Updates were rejected because the tip of your current branch is behind',
  'hint: its remote counterpart.',
  'fatal: You have not concluded your merge (MERGE_HEAD exists).',
].join('\n')

export const SAMPLE_CONFLICT = [
  "import { createServer } from 'node:http'",
  '',
  'export function start(port, handler) {',
  '<<<<<<<'.concat(' ours'),
  '  const server = createServer(handler)',
  '  server.setTimeout(30_000)',
  '|||||||'.concat(' base'),
  '  const server = createServer(handler)',
  '=======',
  '  const server = createServer(handler)',
  '  server.setTimeout(30_000)',
  '>>>>>>>'.concat(' theirs'),
  '',
  '<<<<<<<'.concat(' ours'),
  "  server.listen(port, '0.0.0.0')",
  '|||||||'.concat(' base'),
  '  server.listen(port)',
  '=======',
  '  server.listen(port, { backlog: 511 })',
  '>>>>>>>'.concat(' theirs'),
  '  return server',
  '}',
].join('\n')
