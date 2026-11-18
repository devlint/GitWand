# Report a bad resolution — design (issue #301, PR 3)

Follows [the #301 design](2026-11-17-create-github-issue-design.md) (PR 1,
merged as #304) and [the diff-selection design](2026-11-18-create-issue-from-diff-selection-design.md)
(PR 2, merged as #305). Requested by Pannboo in
[#301](https://github.com/devlint/GitWand/issues/301): "From an auto/LLM-resolved
conflict → *Report bad resolution* — attaches the hunk and the explanation (also
a nice feedback channel for the resolver itself)."

## Intent

When GitWand proposes a resolution for a conflict hunk and it is wrong, the
person looking at it can file an issue about it without leaving the merge
editor, with the conflict and what GitWand did already written down. Two
readers, chosen in the form:

- **the repository being worked on** (the usual targets: `origin`, or its
  parent on a fork) — "this merge went wrong here", for the team;
- **GitWand itself** (`devlint/GitWand` on github.com) — a bug report on the
  resolver, so the engine can be fixed. This is the feedback channel the issue
  asks for.

## Decided with the user

- Both destinations, with a switch in the form to send the report to GitWand
  (approach A below), and guardrails on that path.
- Approach A: one form; the switch rewrites the body and adds the guardrails.

## Approaches considered

- **A. A switch in the existing issue form — chosen.** "Report bad resolution"
  opens the usual form, prefilled for the current repository; a "Send to
  GitWand (resolver report)" switch above the repository picker retargets it to
  `devlint/GitWand`, rewrites the body as an engine report and turns the
  guardrails on. One form, the user can change their mind without closing it,
  and it works when `origin` is not on GitHub.
- B. Two buttons in the panel ("Report here" / "Report to GitWand"). Simpler,
  but changing one's mind means closing and reopening, and two more buttons in
  panels that already carry Accept / Reject.
- C. GitWand reports through the browser (`issues/new?title=&body=` on
  github.com): nothing is sent by the app, the user reviews on GitHub. Natural
  guardrail, works without any sign-in, but the URL caps the body (~8 KB), so a
  real hunk gets cut, and it is not the switch asked for.

## Where the action appears

The merge editor's three proposal panels, each a resolution GitWand made for one
hunk:

- `ResolutionPreviewPanel` — the engine's own resolution (pattern / format
  resolver), with explanation and confidence;
- `LlmTracePanel` — the AI fallback's proposal (`llm_proposed`), with its trace;
- `TokenMergePanel` — the token-level merge proposal (`token_level_merge`).

A "Report" button sits with Accept / Reject while the proposal is pending.
Rejecting hides the panel, as today, so a rejected proposal is reported before
(or instead of) rejecting.

**After accepting (decided with the user): keep a copy for the session.**
Accepting an engine or token-level proposal writes the file and the hunk (and
its panel) disappears; an AI proposal stays with an "Accepted" badge. So that
"I accepted it, then saw it was wrong" can still be reported, accepting keeps a
copy of what the report needs (the hunk's versions, the resolution, the
explanation and trace, the file path) in memory, and the place where the hunk
was shows a compact line "Resolution accepted · Report" until the merge editor
is closed or the file is left. In memory only: nothing written to disk, nothing
kept across sessions (the persistent journal stays out of scope). For an AI
proposal the Report button stays in its accepted panel.

**Not in this PR (my call):** reporting after the fact. Once the file is saved
nothing keeps the hunk, its versions or the engine's reasoning, so a bad
resolution found later (tests failing after the merge) cannot be reported from
GitWand. That needs a journal of resolutions; noted for later in the roadmap.
Also out: bulk "resolve everything" runs that are never looked at hunk by hunk.

## What the report carries

Built from what the merge editor already holds for the hunk (`ConflictHunk`,
its `HunkResolution`, the trace):

- the three versions in fenced blocks: **ours**, **theirs**, and **base** when
  the conflict has one (diff3);
- **GitWand's result**: the resolved lines;
- **why**: the explanation, the conflict type, the confidence (score and label),
  the decision trace's summary; for an AI proposal the model name, the
  validation score and the history stats (never the prompt); for a token-level
  merge its pass counts;
- the user's answer to "What should it have been?", from its own field in the
  form (see "The switch and what was typed"), placed at the top.

Repository report (switch off): title "Bad merge resolution in `<path>`", body
with the file path and the branches being merged when known, then the above.

GitWand report (switch on): title "Resolver: bad `<conflict type>` resolution
(`<file kind>`)", body:

- the GitWand version (`__APP_VERSION__`) and platform;
- the file's **kind** instead of its path: its extension, or for a file
  without one a fixed list of known names (`Dockerfile`, `Cargo.lock`,
  `.env.*` → `.env`…; anything else is "no extension"), and the format resolver
  that handled it when one did. Never the path, the raw file name, the
  repository name, the branch names or the remote;
- then the versions, result and reasoning above.

## Guardrails on the GitWand path

1. **Public warning.** While the switch is on, the form shows: "This report
   will be public on github.com/devlint/GitWand. It contains the code shown
   below; review it and remove anything private." (all 5 locales).
2. **Explicit confirmation.** A checkbox "I reviewed the code, it can be
   public"; Create stays disabled until it is ticked. Turning the switch off and
   on again unticks it. Editing the body does not tick it.
3. **Secrets scan.** The body is scanned with the core's `scanSecrets` on open,
   on switch and on every edit (debounced). On the GitWand path the scan is
   forced on whatever the repository's config says, ignores no path (the
   built-in rules would skip lockfiles), and uses the built-in plus the user's
   extra patterns (my call). A finding of severity high or
   medium blocks Create, names the line(s) and the pattern, and stays blocking
   until the text no longer matches; low findings show as a warning only.
   Nothing is ever sent to GitWand with a known secret pattern in it.
4. **No identifying context** in what GitWand generates (see above). What the
   user types is theirs.
5. **No labels, assignees or milestone** on the GitWand path (the user has no
   triage rights there; the pickers are hidden).

The current-repository path keeps the PR 1 behaviour (pickers, no warning, no
confirmation). The secrets scan runs there too but only warns: it is the user's
own repository.

## Availability and sign-in

- The "Report" button shows whenever a proposal panel shows. The repository
  path needs what PR 1 needs (`origin` on GitHub, issues on); the GitWand path
  needs only a GitHub sign-in that can write to github.com (the account token,
  else `gh` signed in on github.com), whatever the current repository's forge —
  a GitLab, Gitea or remote-less repository can still report to GitWand.
- When the repository path is not possible (not on GitHub, issues off
  everywhere), the form opens with the switch on and locked, saying why.
- When GitWand cannot be reached for writing (no sign-in for github.com), the
  switch is disabled with the reason.

## The switch and what was typed (my call)

- "What should it have been?" is its own field in the form (shown only for a
  report), kept as is across switches and placed at the top of either body.
- The rest of the body is generated. Switching regenerates it for the new
  target. If the user edited that generated text, the switch first asks
  ("Your edits to the description will be replaced") and does nothing on
  cancel. This holds both ways; going to GitWand must replace it, since the
  repository body carries the path and branches (guardrail 4).
- `dirty` counts the answer field and the body against the body generated for
  the current target.

## Backend

`gh_create_issue` today accepts only the current repository's targets
(`resolve_issue_target`: origin or its parent, on origin's host). It must also
accept GitWand's own repository:

- a constant `devlint/GitWand` on `github.com`, accepted whatever `origin` is —
  including no GitHub origin and a GitHub Enterprise origin (then a different
  host: the request goes to github.com, never to origin's host);
- a github.com path of its own: the account token when there is one (whatever
  origin's host, Enterprise included, and whatever flag the repository carries
  after an OAuth refusal), else `gh` aimed explicitly at github.com. The
  existing helpers pick token and host from the working directory's `origin`
  (`token_for_repo`, `api_call`, `gh_api_on`), so they cannot be reused as is;
- a read-only "can I write to github.com?" check (token present, or `gh`
  signed in on github.com) for the switch's disabled state;
- the same "may have been created" marking;
- the user's labels / assignees / milestone ignored for that target;
- `dev-server.mjs`'s create route gets the same rule (AGENTS.md: dev:web must
  test what ships), and the command registry stays in sync.

Whether this is the same command with the extra target or a dedicated
`gh_create_gitwand_issue` is left to the plan; the frontend must be able to call
it when the repository's forge provider is not GitHub (today the form goes
through `provider.createIssue`).

## Frontend shape

- `useCreateIssue` gains `openFromResolution(report)` (the hunk's data) and the
  switch state; the form shows the switch only for a report.
- Report bodies are built by pure functions (repository / GitWand variants),
  unit-tested like `issuePrefill.ts`, with a body budget of their own under
  GitHub's 65,536-character limit (a new constant; `SELECTION_MAX_CHARS` is
  PR 2's prefill budget, not a form limit); long versions are cut with a
  note.
- The format resolver that handled a hunk is only in English text today
  (`dispatchFormatAware` returns `resolverUsed`, but `ConflictHunk` /
  `HunkResolution` do not keep it). Add an optional field to the core's types
  (non-breaking for `@gitwand/core` users) rather than parse the explanation.
- The guardrail state (confirmation, scan findings) lives in the composable and
  feeds `canSubmit`.
- Strings in all 5 locales; the generated issue text itself stays in English
  (as for PR 2's prefill), since it is read on GitHub, and GitWand's issues are
  in English.

## Non-goals / anti-goals

- Never send anything to GitWand without the user seeing the exact text and
  ticking the confirmation.
- No automatic or background reporting, no telemetry.
- No journal of past resolutions in this PR.
- No change to how proposals are accepted or rejected.

## Left to the builder

- Exact placement and wording of the "Report" button in each panel.
- How long versions are cut within the budget, and the scan's debounce.
- The test split between composable, pure builders and the Rust target check.
