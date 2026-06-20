# Implementation Plan — v2.29.0 Launchpad: triaged action inbox (Phase 1)

> Source of truth: `ROADMAP.md` → "v2.29.0 — Launchpad: triaged action inbox".
> This plan scopes a **shippable Phase 1** (the core UX shift) and defers the rest to Phase 2.
> Planner artifact — implementation will be done by another agent. No source code is written here.

---

## 0. Verified findings (read before planning)

These are facts established by reading the code, not assumptions. They de-risk the plan.

- **`PrWithRepo` already carries the conflict signal.** `PullRequest` (`apps/desktop/src/utils/backend-pr.ts:61`) has:
  `mergeStateStatus: "CLEAN" | "BLOCKED" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | ""`, plus
  `reviewDecision`, `checksRollup`, `reviewRequested`, `assignees`, `draft`, `author`, `commentCount`, `labels`, `additions`, `deletions`, `url`, `number`, `title`, `base`, `branch`.
  `PrWithRepo` (`apps/desktop/src/composables/useLaunchpadPrs.ts:9`) extends it with `repoName`, `repoPath`.
- **`mergeStateStatus === "DIRTY"` is the merge-conflict signal.** The enriched `workspace_prs_all` path fetches `mergeStateStatus` (`apps/desktop/src-tauri/src/commands/gh.rs:320` JSON field list includes `mergeStateStatus`). The *light* `gh_list_prs` path leaves it empty (`gh.rs:360`), but the Launchpad uses the enriched workspace path, so the field is populated. **→ No new Tauri command is needed for conflict detection (Phase 1 requirement #6 satisfied).**
- **`gh_current_user` / `ghCurrentUser` already exists** (`apps/desktop/src/utils/backend-pr.ts:15`) and is already called by the inbox via `loadUser()`.
- **dev:web already covers the data path.** `dev-server.mjs` has `/api/gh-current-user` (line 2720) and `/api/workspace-prs-all` (line 4654). The inbox tab renders today in dev:web. **→ No new dev-server route is needed for Phase 1.**
- **Routing surfaces already exist** in `App.vue`:
  - `openLaunchpadPr(pr)` (line 1452) → switches repo + `viewMode = "prs"` + `prPanel.selectPr(pr)` (in-app PR review, v2.24).
  - `openLaunchpadIssue(issue)` (line 1471) → `viewMode = "issue"`.
  - `openLaunchpadRepoChanges(repoPath)` (line 1485) → `viewMode = "changes"`.
  Events are emitted by `LaunchpadView.vue` (`open-pr`, `open-issue`, `open-repo-changes`) and wired at `App.vue:2596`.
- **Merge / checkout wrappers exist**: `ghMergePr(cwd, number, method)` (`backend-pr.ts:367`) and `ghCheckoutPr(cwd, number)` (`backend-pr.ts:355`). Phase 1 routes through the existing PR detail surface rather than calling these directly from the inbox (keeps the inbox thin and reuses the merge confirmation UX in `PrDetailView.vue:235`).
- **Existing tests to honor**: `apps/desktop/src/composables/__tests__/useLaunchpadInbox.test.ts` (the `classifyInboxPr` + bucket-order contract), `useRepoActionCards.test.ts`, `components/__tests__/LaunchpadView.test.ts`.
- **Current inbox UI** lives in `LaunchpadView.vue` lines 416–503: a `localCards` section followed by a flat `v-for="bucket in inboxBuckets"`. This is the block to restructure into 3 tiers.

---

## 1. Open decisions (human checkpoint)

These were resolved by me to keep Phase 1 self-contained; flag if you disagree:

1. **`classifyInboxPr` return type changes** from `InboxBucketKey | null` to a richer `InboxClassification | null` (carries `tier`, `action`, and the legacy `bucket`/case). The existing unit-test file is **deliberately updated** (not preserved verbatim) — its 9 assertions are re-expressed against the new return shape, keeping the same input cases so coverage doesn't regress. Rationale: the roadmap explicitly says "generalize … into a tiered classifier", and bolting tiers on as a second function would duplicate the priority logic.
2. **Conflicts tier placement**: merge conflicts on *my own* PR → `À traiter`, action `Resolve`, ranked **above** `merge` but the spec lists them after "ready to merge" in prose. I place `conflicts` at priority just below `changes`/`ci` (you can't merge a dirty PR, so resolving is the real next step). Confirm ordering preference.
3. **`Resolve` routing target (Phase 1)**: routes to the in-app PR review surface (existing `open-pr`), which already surfaces merge state. A *direct* jump into the GitWand conflict resolver from the inbox (checkout PR branch → open resolver) is **deferred to Phase 2** because it needs a checkout+merge-preview orchestration that doesn't exist as a single call yet. Phase 1 `Resolve` = "open the PR so you can act", same transport as `Review`.
4. **`Nudge` / `Auto-merge` / `Follow` actions** in Phase 1 are **display-only labels** that route to the PR (no forge round-trip), matching the "no new forge round-trips on the hot path" constraint. Active nudge/auto-merge mutations are Phase 2.
5. **Local cards tier**: local working-state cards (`commit`/`push`/`publish`/`sync`) render in a dedicated header band **above** the 3 tiers (not inside `À traiter`), preserving the existing "On your repos" section. Local merge-conflict cards are **not** added in Phase 1 (WIP payload carries no conflicted count — confirmed in `useRepoActionCards.ts` comment; that's a Phase 2 backend gap, see §8).

---

## 2. Phase 1 scope summary

| # | Deliverable | Primary files |
|---|---|---|
| 1 | 3-tier urgency model in `useLaunchpadInbox` + `conflicts` case | `useLaunchpadInbox.ts`, its test |
| 2 | State-aware primary action per row (derive action + route) | `useLaunchpadInbox.ts`, its test |
| 3 | Local working-state cards wired into the inbox header | `LaunchpadView.vue` (already imports `useRepoActionCards`) |
| 4 | Render 3 tiers + action button in the view | `LaunchpadView.vue` |
| 5 | i18n keys in all 5 locales | `locales/{en,fr,es,pt-BR,zh-CN}.ts` |
| 6 | dev:web parity confirmation (no new command) | none — verified §0 |

---

## 3. Step-by-step plan (test-first where it pays)

### Step 1 — Redesign `useLaunchpadInbox.ts` model (composable, pure logic)

**File**: `apps/desktop/src/composables/useLaunchpadInbox.ts`

Introduce the tier + action model. Keep all classification logic in the composable (thin-component rule).

New exported types (replacing the flat `InboxBucketKey` model):

```ts
export type InboxTier = "now" | "waiting" | "later";        // À traiter / En attente / Plus tard
export type InboxCase =
  | "review" | "changes" | "ci" | "merge" | "conflicts"     // existing + conflicts
  | "waiting" | "ciRunning" | "blocked";                     // En attente cases
export type InboxAction =
  | "merge" | "review" | "seeFailure" | "reply"
  | "resolve" | "follow" | "nudge" | "autoMerge";

export interface InboxClassification {
  tier: InboxTier;
  case: InboxCase;
  action: InboxAction;
}

export interface InboxTierGroup {
  tier: InboxTier;
  items: InboxItem[];          // { pr: PrWithRepo; classification: InboxClassification }
}
```

`TIER_ORDER: InboxTier[] = ["now", "waiting", "later"]`.

**`classifyInboxPr(pr, me): InboxClassification | null`** — single source of priority. Decision table (evaluated top-to-bottom, first match wins):

| Condition (viewpoint = `me`) | tier | case | action |
|---|---|---|---|
| `!me` | — | — | `null` (unchanged) |
| not mine, not draft, `reviewRequested.includes(me)` | now | review | review |
| not mine, otherwise | — | — | `null` |
| mine, `reviewDecision === "CHANGES_REQUESTED"` | now | changes | reply |
| mine, `mergeStateStatus === "DIRTY"` | now | conflicts | resolve |
| mine, `checksRollup === "FAILURE"` | now | ci | seeFailure |
| mine, `reviewDecision === "APPROVED"` & `mergeStateStatus` in {`CLEAN`,`HAS_HOOKS`,`""`} | now | merge | merge |
| mine, `reviewDecision === "APPROVED"` & `mergeStateStatus === "BLOCKED"` | waiting | blocked | follow |
| mine, `checksRollup === "PENDING"` | waiting | ciRunning | follow |
| mine, `reviewDecision === "REVIEW_REQUIRED"` (awaiting others) | waiting | waiting | follow |
| mine, dependency-bump PR (heuristic) | later | — | autoMerge |
| otherwise | — | — | `null` |

> **Dependency-bump heuristic (Phase 1, conservative)**: `author` matches `/^(dependabot|renovate)(\[bot\])?$/i` OR labels include `dependencies`. This only ever demotes a `my-PR` into `later`; it never pulls in PRs that weren't already mine, so it can't expand the firehose. Keep it small and documented; richer dep handling is Phase 2.

**Priority preservation note**: the first three "mine" rows preserve the legacy order (changes > ci > merge) from the existing test `prioritises changes-requested over failing CI`. `conflicts` is inserted **between `changes` and `ci`** (decision §1.2 — confirm).

`useLaunchpadInbox(allPrs)` returns:
- `currentUser`, `loadUser` (unchanged).
- `tiers: ComputedRef<InboxTierGroup[]>` — group by tier in `TIER_ORDER`, drop empty tiers. Within a tier, preserve `allPrs` ordering (pinned-first inherited from `useLaunchpadPrs`).
- `nowCount: ComputedRef<number>` — count of `tier === "now"` items (drives the "M to handle" signal).
- `totalCount` — total classified items (drives badge; unchanged semantics).
- Keep `INBOX_BUCKET_ORDER` / `buckets` **as a thin back-compat alias** ONLY if a non-test consumer needs it; otherwise remove. Grep confirms the only consumers are `LaunchpadView.vue` (being rewritten) and the test (being rewritten) → **remove the old exports**.

**Perf invariants (P6.4)**: all derivation stays in `computed` over `allPrs` (no new watcher, no `{deep:true}`, no polling). `classifyInboxPr` is O(1) per PR.

### Step 1-test — Rewrite `useLaunchpadInbox.test.ts` (deliberate contract update)

**File**: `apps/desktop/src/composables/__tests__/useLaunchpadInbox.test.ts`

Keep the existing `pr()` factory (already covers all read fields including `mergeStateStatus: "CLEAN"`). Re-express the 9 existing `classifyInboxPr` assertions against the new return shape, e.g.:

- `classifyInboxPr(pr({author:"alice", reviewRequested:[ME]}), ME)` → `{ tier:"now", case:"review", action:"review" }`
- changes-requested → `{ tier:"now", case:"changes", action:"reply" }`
- failing CI → `{ tier:"now", case:"ci", action:"seeFailure" }`
- approved + CLEAN → `{ tier:"now", case:"merge", action:"merge" }`
- `prioritises changes-requested over failing CI` → still `case:"changes"`
- `REVIEW_REQUIRED` + `SUCCESS` (was `null`) → **now** `{ tier:"waiting", case:"waiting", action:"follow" }` (intentional change — document in test comment).

New assertions to add:
- approved + `mergeStateStatus:"DIRTY"` → `{ tier:"now", case:"conflicts", action:"resolve" }`
- approved + `mergeStateStatus:"BLOCKED"` → `{ tier:"waiting", case:"blocked", action:"follow" }`
- `checksRollup:"PENDING"` on my PR → `{ tier:"waiting", case:"ciRunning", action:"follow" }`
- dependabot author on my-equivalent PR → `{ tier:"later", action:"autoMerge" }`
- conflicts-over-ci ordering: `{reviewDecision:"CHANGES_REQUESTED"}` still wins over `{mergeStateStatus:"DIRTY"}`.

`useLaunchpadInbox` block: replace `buckets`/`totalCount` order assertions with `tiers` (map to `tier`) + `nowCount`. Keep the empty-user and empty-tier cases.

**Acceptance**: `pnpm --filter @gitwand/desktop test useLaunchpadInbox` green; coverage of every decision-table row.

### Step 2 — Render 3 tiers + state-aware action in `LaunchpadView.vue`

**File**: `apps/desktop/src/components/LaunchpadView.vue` (lines 416–503 are the inbox panel)

This is an **augment-then-restructure** of the inbox panel only (other tabs untouched).

1. Update the import + destructure (line 7, 68):
   `const { tiers, nowCount, totalCount: inboxTotal, loadUser: loadInboxUser } = useLaunchpadInbox(allPrs);`
2. Keep the local-cards section (lines 442–463) **as the header band**, above the tiers (decision §1.5). No change to `useRepoActionCards` wiring (already present, line 71) — this satisfies Phase 1 requirement #3.
3. Replace the flat `v-for="bucket in inboxBuckets"` (lines 465–501) with `v-for="group in tiers"`:
   - Tier header: dot + `t('launchpad.tier.' + group.tier)` + count, collapsible (local `ref<Set<InboxTier>>` for collapsed state — no persistence in Phase 1, no watcher).
   - Per row: existing repo/title/author + CI/review pills (reuse the existing badge markup, lines 491–498, extended to show review pills) + **one primary action button** rendered from `item.classification.action`.
4. **Action button** is a thin emitter — all routing already exists:
   - `merge`, `review`, `resolve`, `reply`, `seeFailure`, `follow`, `nudge`, `autoMerge` → all emit `open-pr` (Phase 1). Label = `t('launchpad.action.' + action)`. Title/tooltip explains the route. (Distinct routing per action is Phase 2; Phase 1 unifies on the existing in-app review surface, which already exposes Merge / CI annotations / thread.)
   - The button uses the existing `.launchpad-view__pr-link` / a new `.launchpad-view__pr-action` class — pure CSS, `.bm-btn` specificity rule is N/A (not in BaseModal).
5. Subtitle "N items · M to handle": add under the inbox panel a small line using `t('launchpad.inboxSummary', [inboxCount, nowCount])`. `inboxCount` already exists (line 73 = local + PR). Confirm pluralization format with the existing `t(key, ...args)` signature (positional `{0}`/`{1}`).
6. Empty state: keep `inboxCount === 0` → `t('launchpad.inboxEmpty')`.

**Perf invariants**: no new watcher; collapsed-tier `Set` is small local UI state; the inbox tab is inside an `activeTab === 'inbox'` `v-if` so it's not rendered when on another tab. No `<img>` added. No deep watch.

### Step 2-test — Extend `LaunchpadView.test.ts`

**File**: `apps/desktop/src/components/__tests__/LaunchpadView.test.ts`

- Mount with a `repos` prop and a stubbed `workspacePrsAll`/`ghCurrentUser` returning a fixture spanning all three tiers (review-requested, my-conflicts, my-approved-clean, my-ci-pending, dependabot). Use the **real composables** (no mocking the inbox logic) — only the backend module is mocked, consistent with the existing test style and the "don't mock the git layer" rule (this is the forge layer; the existing inbox test already mocks `ghCurrentUser`, so follow precedent).
- Assert: 3 tier headers render with correct counts; each row shows the expected action button label; the "N items · M to handle" summary shows correct numbers.

### Step 3 — i18n: add keys to all 5 locales

**Files**: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-cn.ts` (under the existing `launchpad` block — `en.ts` around line 1410).

New keys (nested to match existing `launchpad.inbox.*` / `launchpad.card.*` style):

```
launchpad.tier.now            // "À traiter" tier header
launchpad.tier.waiting        // "En attente"
launchpad.tier.later          // "Plus tard"
launchpad.inboxSummary        // "{0} items · {1} to handle"
launchpad.action.merge        // "Merge"
launchpad.action.review       // "Review"
launchpad.action.seeFailure   // "See failure"
launchpad.action.reply        // "Reply"
launchpad.action.resolve      // "Resolve"
launchpad.action.follow       // "Follow"
launchpad.action.nudge        // "Nudge"
launchpad.action.autoMerge    // "Auto-merge"
launchpad.case.conflicts      // "Merge conflicts" (per-row pill, if shown)
```

Reuse existing keys where possible: `launchpad.inboxEmpty`, `launchpad.inbox.*` (keep or migrate the labels to `tier`-grouped headers — but the **tier** headers are new; the old `inbox.review/changes/ci/merge` strings become per-case pill labels if you want richer pills, otherwise leave them). The pre-existing `launchpad.prApproved/prChangesRequested/prReviewRequired/prCiFailure/prCiPending/prCiSuccess` (lines 1432–1437) are reused for the per-row CI/review pills.

Provide all 5 translations for each new key (en is the canonical English above; fr/es/pt-BR/zh-CN translated equivalents). Verify `locales/index.ts` needs no structural change (keys are additive within `launchpad`).

**Acceptance**: a grep/structural check that every new key exists in all 5 files; `pnpm --filter @gitwand/desktop build` (vue-tsc) passes (no missing-key TS errors if keys are typed).

### Step 4 — Verification gate

Run in order:
1. `pnpm --filter @gitwand/desktop test` — unit + component tests green.
2. `pnpm --filter @gitwand/desktop build` — vue-tsc + vite build clean.
3. `pnpm --filter @gitwand/desktop dev:web` — manual: open Launchpad → Inbox tab; confirm 3 tiers render, local cards on top, action buttons route (PR opens in-app), summary line correct, empty state when nothing to handle. (Data path already mocked, §0.)
4. No version files touched (`git diff --stat` must not include `package.json`/`Cargo.toml`/`tauri.conf.json`). Versioning happens at release time via `./scripts/bump-version.sh`.

---

## 4. Files touched (Phase 1)

| File | Change |
|---|---|
| `apps/desktop/src/composables/useLaunchpadInbox.ts` | New tier+action model; `classifyInboxPr` returns `InboxClassification`; add `conflicts`/waiting/later cases; expose `tiers`, `nowCount` |
| `apps/desktop/src/composables/__tests__/useLaunchpadInbox.test.ts` | Rewrite assertions for new shape; add conflict/waiting/later/dep cases |
| `apps/desktop/src/components/LaunchpadView.vue` | Restructure inbox panel into local-cards band + 3 tiers + per-row action button + summary line |
| `apps/desktop/src/components/__tests__/LaunchpadView.test.ts` | Extend with tier/action fixtures |
| `apps/desktop/src/locales/en.ts` | Add `launchpad.tier.*`, `launchpad.action.*`, `inboxSummary`, `case.conflicts` |
| `apps/desktop/src/locales/fr.ts` | same keys, FR |
| `apps/desktop/src/locales/es.ts` | same keys, ES |
| `apps/desktop/src/locales/pt-BR.ts` | same keys, PT-BR |
| `apps/desktop/src/locales/zh-cn.ts` | same keys, ZH-CN |

**No changes** to: `useRepoActionCards.ts` (reused as-is), `useLaunchpadPrs.ts`, `backend.ts`/`backend-pr.ts` (no new command), Rust (`gh.rs`, `lib.rs`), `dev-server.mjs`, `App.vue` (existing handlers suffice), `useSettings.ts`/`SettingsPanel.vue` (no new setting in Phase 1).

---

## 5. Constraints honored (checklist)

- **Composition API `<script setup>`**: `LaunchpadView.vue` already uses it; no Options API introduced.
- **Logic in composables**: all classification/tier/action logic in `useLaunchpadInbox.ts`; the view only renders and emits.
- **IPC through `backend.ts`**: no new `invoke()`; reuses `workspacePrsAll`/`ghCurrentUser`/(routing via existing emits). No new command.
- **Perf P6.4**: no new polling, no `setInterval`, no `{deep:true}`, no new heavy watcher; inbox panel gated by `v-if="activeTab === 'inbox'"`; logic is `computed`-only; no external `<img>`.
- **5-locale i18n**: every new string keyed in en/fr/es/pt-BR/zh-CN.
- **No manual version edits**: none of the version-managed files are touched.
- **DOMPurify**: no new `v-html`; PR titles/labels rendered as text (unchanged).

---

## 6. Test strategy (test-first summary)

- **Unit (composable, highest value)**: `useLaunchpadInbox.test.ts` drives the decision table — write the new assertions first, then implement `classifyInboxPr` until green. Real data shape via the existing `pr()` factory (mirrors `PrWithRepo`).
- **Component**: `LaunchpadView.test.ts` with a multi-tier backend fixture, real composables, mocked forge module only.
- **No git-layer mock needed**: this is the forge/PR layer; the local-cards path is driven by `useRepoActionCards` over `wip` which is already covered by `useRepoActionCards.test.ts` (unchanged).

---

## 7. dev:web parity (requirement #6 — explicit answer)

**No new Tauri command and no new dev-server route are required for Phase 1.** The inbox already consumes `workspace_prs_all` (route `/api/workspace-prs-all`) and `gh_current_user` (route `/api/gh-current-user`), both present in `dev-server.mjs`. The conflict signal `mergeStateStatus === "DIRTY"` is already in the enriched payload. To exercise tiers in dev:web, the **only** optional change is enriching the `/api/workspace-prs-all` mock fixture in `dev-server.mjs` to include PRs with `mergeStateStatus: "DIRTY"`, `"BLOCKED"`, and `checksRollup: "PENDING"` so the new tiers are visible during manual testing. This is a test-fixture tweak, not a parity-breaking command addition — include it in Step 2 if the current mock lacks such variety.

---

## 8. Deferred to Phase 2 (NOT planned in detail)

Listed so the roadmap follow-up dependency is explicit (per AGENTS.md "When a feature ships"):

1. **Issues / mentions / dependency-PRs as first-class union inbox items** — extend the classifier over a union item type (`PR · issue · mention · dep · local-action`). Needs `useLaunchpadIssues` mentions wired in and a richer item model.
2. **Group-by toggle: Priority · Repo · Type** — Phase 1 ships Priority (tiers) only.
3. **Counted filter chips** (All · My PRs · To review · Issues · Dependencies · Mentions, each with live count).
4. **Active mutations**: real `Nudge` (comment), `Auto-merge` (enable forge auto-merge), and a **direct `Resolve` jump** that checks out the PR branch and opens the GitWand conflict resolver in one click (the headline differentiator). Phase 1 routes all actions to the existing in-app PR review surface.
5. **Local merge-conflict cards** in the header band — requires the backend `WorkspaceWipItem` to expose a conflicted-file count (the **only identified backend gap**: `useRepoActionCards.ts` documents that WIP carries no conflicted count today). Cheapest fill: add `conflictedCount: number` to `WorkspaceWipItem` in Rust (`workspace_wip_all`) + dev-server mock — a small additive field, deferred because Phase 1's local cards already cover commit/push/publish/sync.
6. **Read/unread dot, diff-stat, full pill set** richer per-row state beyond the CI/review pills reused in Phase 1.
7. **Persisted tier collapse state** (Phase 1 collapse is ephemeral local UI state; persisting it would add a settings field to both `useSettings.ts` and `SettingsPanel.vue`).
