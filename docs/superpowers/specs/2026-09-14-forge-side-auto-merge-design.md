# Forge-side auto-merge: design

**Date:** 2026-09-14
**Scope:** one lot of the remaining v3.11.0 entry. Queue a pull request to merge when its checks
pass, per forge, plus the cancellation of a queued merge. Nothing else in the PR panel changes.
**Roadmap:** `roadmap.md`, section `### v3.11.0`, bullet "Forge-side auto-merge (deferred from
v3.10.0)".

---

## 1. Problem

v3.10.0 gave the Today inbox a real merge action, and deliberately refused to ship a button labelled
"Auto-merge" that could only ever report `waiting: <check>`. The honest immediate merge went out
instead. That decision left the actual capability unbuilt: GitHub, GitLab and Azure can all be told
"merge this when the checks pass", and GitWand cannot ask them.

Today GitWand decides merge-readiness itself. `mergeReadiness` in `usePrPanel.ts` reads the checks
and the reviews, derives `{ ready, reason }`, and that computation gates both the merge button and
the Today action. The operation then finishes within the second.

Forge-side auto-merge inverts that. The decision is delegated to the forge, and the action has no
completion inside the session: it can land in ten minutes, in six hours, or never if a check breaks,
and the app may be closed throughout. That is a different mental model from anything else in the
app, and it, rather than the three API calls, is what this design is about.

## 2. Decisions taken before designing

Four questions were settled up front, because each one changes the shape of the lot.

**What the app promises after queueing: fire and forget.** GitWand arms the auto-merge, shows a
badge, and that badge comes from the normal PR refresh like any other field. No dedicated poll, no
notification, no cross-session persistence.

Three reasons. The forge already owns the notification channel and mails the user when the merge
lands, so a second channel inside GitWand duplicates it and can only be less reliable, because the
app will be closed exactly when it matters. Active tracking would need persistence plus a policy for
"the app was closed for three days", which is a subsystem for information the PR itself already
carries. And the badge stays honest: it reports what GitWand knew at the last refresh, which is the
contract every other part of the PR panel already keeps.

This is not a closed door. If tracking is ever genuinely wanted, the v3.10 watcher's `refs` events
and the existing one-forge-call-per-minute throttle are the hook, and nothing here blocks it.

**How capability is learnt: probe up front.** The button is offered only when it can succeed, rather
than offered optimistically and explained on failure. The cost is accepted; the residual
time-of-check-to-time-of-use window is handled in section 5 rather than wished away.

**Cancellation is in scope.** Arming a deferred action with no way to disarm it is a trap: the PR
leaves as soon as the checks go green, including after the author has changed their mind. All three
forges have the inverse operation.

**Shape: a typed descriptor computed in Rust.** Not four commands with a provider branch in the UI,
and not a boolean bolted onto the existing merge command. The probe-up-front choice only makes sense
if capability is data rather than an `if` in a component; a provider branch in `usePrPanel` would
make the two decisions contradict each other. It also runs with, not against, the standing roadmap
item to retire the frontend's "default to GitHub" fallback.

## 3. The descriptor

Two structures, because the question has two scopes, and separating them is what makes the probe
cheap.

```rust
/// Repository scope. Resolved once per repository.
struct AutoMergeSupport {
    supported: bool,
    reason: Option<String>,   // e.g. "auto-merge is disabled on this repository"
}

/// Pull-request scope. Carried by every PR already returned.
struct AutoMergeState {
    armed: bool,              // an auto-merge is currently queued
    available: bool,          // this PR meets the preconditions
    reason: Option<String>,   // otherwise why, in the forge's own words
}
```

`supported` is an administrative setting of the repository and does not vary from one PR to the
next. Resolving it per PR would ask N times for one answer. It rides on the `gh repo view` call
`gh.rs` already makes and caches, so it costs one field in an existing request.

`armed` and `available` come from payloads each module already parses.

### Where each forge gets its answer

| Forge | `supported` | `available` precondition | `armed` |
|---|---|---|---|
| GitHub | `autoMergeAllowed` on `repo view` | none beyond `supported` | `autoMergeRequest` present |
| GitLab | `true`, constant | a pipeline must be running | `merge_when_pipeline_succeeds` |
| Azure | `true`, constant | the PR must not be a draft | `autoCompleteSetBy` set |
| Bitbucket | `false`, constant, static reason | n/a | always false |

Only one of the four has a genuine repository-level capability to probe. The other two have per-PR
preconditions already readable in data being received. The probe is smaller than it first appears.

### List or detail

`armed` must reach the **list**, or the badge cannot render in the PR list or in Today. `available`
must too, because the Today action has to disable itself without opening the PR.

The same question has to be asked of the other two, and answered rather than assumed: whether a
forge's *list* payload carries the per-PR precondition fields at all, or only its *detail* payload.
GitLab's pipeline object and Azure's draft flag are known to be on the detail; their presence on the
list response is version-dependent and is a verification task of the plan, one capture per forge. If
a field turns out to be detail-only, that forge degrades the same way as the GitHub fallback below:
the Today action stops offering auto-merge for it and the immediate merge stands, rather than the UI
guessing from absence.

For GitHub that means adding `autoMergeRequest` to `gh pr list --json`, and `gh.rs:155` carries an
explicit warning about the cost of fields added to that call. That warning is aimed at
`statusCheckRollup` and `reviewRequests`, which trigger expensive server-side resolution, whereas
`autoMergeRequest` is a flat node. Probably not comparable, but this project does not bet on that
kind of thing: **measuring the cost of that field on a repository with a large open-PR count is a
task of the plan.** If it surprises, `armed` falls back to the detail alone and the badge leaves the
lists.

### `reason` is not translated

`reason` carries the forge's own text, so English, untranslated. Deliberate, and the same position
`mergeReadiness` already takes for Azure branch-policy names. The i18n rule covers GitWand's own
labels, not messages a forge produces; translating "no pipeline is running" would mean inventing a
mapping we do not control and cannot keep current.

## 4. Commands

Six commands, two per supporting forge: `{gh,gl,az}_enable_auto_merge` and
`{gh,gl,az}_disable_auto_merge`, each with a typed wrapper in `backend.ts` and a real dev-server
route in the same task.

Not three mode-parameterised commands. `git_rebase_action(continue|skip|abort)` is the repo's
precedent for a mode argument, and it holds because its three modes share every argument. These do
not: arming takes a merge method, disarming takes none, and the two paths fail for unrelated
reasons. One signature would carry a meaningless parameter half the time.

## 5. The rule that outranks the rest

**An auto-merge that cannot be armed must never become a merge.**

It is the worst available failure for this feature: the user asks for "merge later if the checks
pass" and gets "merged now". No automatic fallback to the immediate merge, in any case, however
tempting it is to make the button feel useful.

This resolves the one GitHub question left open. The behaviour of `gh pr merge --auto` against a PR
that is *already* mergeable is uncertain, and one of the possible outcomes is an immediate merge.
Rather than handling that after the fact, the design removes it: **auto-merge is offered only when
the PR is not already mergeable.** When `mergeReadiness.ready` is true the auto-merge button is
pointless anyway, since the immediate merge sitting next to it is what the user wants. The rule
deletes the entire class of problem instead of working around it, and it applies to all three
forges rather than to GitHub alone.

### The residual race

Probing up front makes refusal rare, not impossible. Between the last refresh and the click a
pipeline can finish, a PR can be turned into a draft, an administrator can flip the repository
setting. On refusal GitWand shows the forge's message verbatim and **refreshes the PR**, which
corrects the descriptor and removes or restores the button on its own. No local memory of the
refusal: fresh data is the only source, consistent with the fire-and-forget model.

## 6. Surfaces

**PR detail panel.** The action, next to the existing immediate merge. Shown only when
`supported && available && !mergeReadiness.ready`. Replaced by "Cancel auto-merge" when `armed`.

**PR list.** The badge, from `armed`. This is the only reason `armed` has to reach the list: it is
what distinguishes a queued PR from one the user forgot to act on.

**Today.** Gains the action when available, keeps the immediate merge when not. On Bitbucket, Today
does not change at all.

**Bitbucket** follows the `pr.error.forgeUnsupported` precedent: state what is unsupported *and what
still works*, in a sentence, rather than degrading silently.

**No setting.** There is nothing to configure. Capability comes from the forge, not from a
preference.

**Azure needs one extra call.** `autoCompleteSetBy` wants the authenticated user's identity.
`azure.rs` already resolves `identityId` values for the PR-create API, so the machinery exists and
is reused rather than rewritten; what differs is that this needs the *current* user rather than a
team list, so it is a call to isolate and cache per session.

## 7. Testing, and what it cannot prove

This feature is network-bound end to end, and it would be easy to write a green suite that proves
nothing.

**What is genuinely testable, and it is most of the logic.** The payload-to-descriptor mapping is
**pure**: give it a JSON body, it returns `{ supported, available, armed, reason }`. It gets Rust
unit tests in each module against captured real responses: a PR with auto-merge queued and one
without, an MR with no pipeline, a draft Azure PR, a GitHub repository with `autoMergeAllowed:
false`. Every interesting case lives there, and none of it needs the network.

**What parity covers.** The `read_file` precedent from #189 is the model: the two backends must
**refuse identically**, not merely succeed identically. With no forge configured, or no remote, the
Rust command and the dev-server route must return the same error. Modest, and precisely what the
current parity coverage almost never does.

**What is not tested, and must not pretend to be.** The real call to GitHub, GitLab or Azure. No
test will arm an auto-merge on a live PR. That means the `gh pr merge --auto` behaviour against an
already-mergeable PR, neutralised in section 5 by the "no button when already mergeable" rule, stays
**manually verified once**, recorded as such, and never in CI. The plan carries that verification as
a task, not as a footnote.

**`pnpm dev:web` does not cover this feature** without a real forge configured, unlike everything
shipped in PR #194. That is a limit of the lot and is written down rather than discovered.

## 8. Out of scope

- Any notification, poll or cross-session tracking of a queued merge (section 2).
- Bitbucket auto-merge. There is no equivalent capability to call.
- Changing `mergeReadiness`, the immediate merge, or any existing merge path.
- Auto-merge from the CLI or MCP. This is a forge-account capability, not an engine one.
