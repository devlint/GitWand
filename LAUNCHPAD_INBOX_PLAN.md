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

---
---

# Implementation Plan — v2.29.0 Today: triaged action inbox (Phase 2)

> Source of truth: `ROADMAP.md` → "v2.29.0 — Today: triaged action inbox (renamed from Launchpad)".
> Phase 1 (above) shipped at commit `00630db`. This plan scopes **Phase 2** and defers active mutations + direct-resolve jump to **Phase 3**.
> Planner artifact — implementation done by another agent. No source code is written here.

## P2.0 Verified findings (read before planning)

Facts established by reading the code, not assumptions.

- **Internal symbols stay `Launchpad*` (intentional).** `LaunchpadView.vue`, `useLaunchpad*`, the `launchpad.*` i18n KEY namespace, the `viewMode === "launchpad"` literal, `LAUNCHPAD_OPEN_REQUEST_KEY`, and all CSS classes (`launchpad-view__*`) are kept. Phase 2 renames only the **display values**. This caps churn and keeps diffs reviewable.
- **The user-visible "Launchpad" string set is small and fully enumerated** (8 distinct keys × 5 locales). The exhaustive list (file:line for `en.ts`, mirrored in the other four):
  - `sidebar.footerLaunchpad` (`en.ts:255`) — AppDock label fallback / footer.
  - `sidebar.launchpad` (`en.ts:256`) — sidebar label.
  - `workspace.openLaunchpad` (`en.ts:1368`) — "Open all in tabs" toolbar row, value `"Launchpad"`.
  - `launchpad.title` (`en.ts:1398`) — view `<h2>` (`LaunchpadView.vue:346`) **and** AppDock dock-label (`AppDock.vue:63`).
  - `launchpad.openTooltip` (`en.ts:1399`) — AppDock button title / ⌘L tooltip (`AppDock.vue:53`), value contains "Launchpad — cross-repo overview (⌘L)".
  - `launchpad.noWorkspace.warning` (`en.ts:1503`) — empty/guard state, "...to use the Launchpad".
  - `menu.openLaunchpad` (`en.ts:1924`) — command palette / native menu item, value `"Open Launchpad"`.
  - `settings.launchpad.disableTeamTab.label` (`en.ts:1210`) — "Disable Launchpad Team tab" (Phase 2: if the Team tab is removed per OPEN DECISION 2, this string disappears with it; otherwise reword to "Today").
- **No `tauri.conf.json` / `index.html` window title says "Launchpad"** — verified empty. No version-managed file needs touching for the rename. (The window title is the product name "GitWand", unaffected.)
- **The `mentioned` issue filter is already wired end-to-end.** `useLaunchpadIssues.ts:12` fetches `assigned/mentioned/created` in parallel; `workspaceIssuesAll(repos, "mentioned")` exists in `backend.ts:2663`; the Rust command + dev-server route `/api/workspace-issues-all` both handle `filter === "mentioned"` (`dev-server.mjs:4719` → `gh issue list --search mentions:@me`). **→ issue @-mentions need NO new backend work.**
- **Backend gap — mentions on PRs.** `gh issue list --search mentions:@me` returns **issues only**; `gh` treats PRs separately. So "@-mention on a PR thread" is not in any current payload. Cheapest fill documented in P2.7.
- **`workspace_prs_all` enriched payload already carries** `author`, `labels`, `mergeStateStatus`, `reviewDecision`, `checksRollup`, `reviewRequested`, `assignees` (`useLaunchpadInbox.ts` consumes them; `PullRequest` in `backend-pr.ts:61`). Dependency-bump detection (`isDependencyBump`, `useLaunchpadInbox.ts:62`) already exists. **→ the "Dependencies" filter is a pure client-side classification of existing data, no new round-trip.**
- **Tabs today** (`LaunchpadView.vue:146`): `type Tab = "inbox" | "wip" | "prs" | "issues" | "team"`. Persisted via `settings.launchpadActiveTab: LaunchpadTab` (`useSettings.ts:21,120`, default `"inbox"`). **Type drift found**: `SettingsPanel.vue:141` local `Settings.launchpadActiveTab` is typed `"wip" | "prs" | "issues" | "team"` (missing `"inbox"`) and defaults to `"wip"` (`SettingsPanel.vue:190`) — a pre-existing latent mismatch. Phase 2 settings work must realign these two per AGENTS.md "Settings must be kept in sync".
- **Team fetch is the expensive one** (lazy-loaded, `N × gh pr view --json files`, ~10s — `LaunchpadView.vue:316` comment). Any decision about the Team tab must preserve its lazy-load contract (perf P6.4).
- **AppDock** renders the nav label via `t('launchpad.title')` and tooltip via `t('launchpad.openTooltip')` (`AppDock.vue:53,63`) — these are the nav/⌘L surfaces to rename.
- **Existing tests to honor/extend**: `useLaunchpadInbox.test.ts` (classifier contract), `LaunchpadView.test.ts` (mocks composable refs `inboxTiersRef`/`inboxTotalRef`/`inboxNowCountRef`, asserts `.launchpad-view__pr-action` counts — `LaunchpadView.test.ts:600-650`), `useRepoActionCards.test.ts`, `useLaunchpadIssues` coverage.

## P2.1 Open decisions (HUMAN CHECKPOINT — numbered, each with a recommendation)

These need user input before P2b lands. P2a (rename) is low-risk and can proceed in parallel.

1. **Localize "Today" per locale, or keep an English brand everywhere?**
   - *Recommendation*: **Localize it.** Unlike "Launchpad" (a GitKraken-derived proper noun the team chose to keep English in-brand), "Today" is a plain temporal word that reads as a label, not a brand — every locale already localizes "Aujourd'hui"-class UI words. Use: `en: Today`, `fr: Aujourd'hui`, `es: Hoy`, `pt-BR: Hoje`, `zh-CN: 今日`. The ⌘L tooltip body ("cross-repo overview (⌘L)") is already localized prose; just swap the leading noun.
   - *If you disagree* (keep "Today" as an English brand for recognizability): set all 5 display values to "Today" and we still avoid touching keys/symbols. Trivial to flip either way since only display VALUES change.

2. **Fate of the WIP tab.** The unified inbox already surfaces local working state as action cards (`useRepoActionCards`: commit/push/publish/sync) in the header band. The standalone WIP tab is now a raw per-repo status table that overlaps with that band.
   - *Recommendation*: **Fold WIP into the unified list, remove the standalone tab.** Local cards already represent the actionable subset; the remaining WIP info (clean repos, ahead/behind with no action) is low-signal for a "what do I do next" surface. Keep a "Repo" group-by view (DECISION 4) to recover the per-repo overview if needed. This reduces the tab count and matches the mockup's tab-less filter+group model.
   - *Alternative*: keep WIP reachable behind the "Repo" group-by rather than a tab.

3. **Fate of the Team tab.** Team is expensive (lazy `gh pr view --json files` fan-out) and conceptually orthogonal to a personal action inbox (it's "what are my colleagues touching", not "what do I do next").
   - *Recommendation*: **Keep Team as a separate, explicitly-opt-in surface OUTSIDE the filter+group inbox** — i.e. retain it as the single remaining secondary tab (or move it behind a header toggle), preserving its lazy-load contract and the `launchpadTeamTabEnabled` setting. Do NOT pull team items into the counted filter chips (they're not personal actions and would pollute the counts + force the expensive fetch on the hot path, violating P6.4).
   - *Alternative*: drop Team entirely in v2.29 and re-introduce later — not recommended, it's a shipped v2.9 feature with its own setting.

4. **Does the unified inbox + filters fully REPLACE the tabs, or coexist? And what does "group by Repo/Type" produce?**
   - *Recommendation*: **The unified inbox + counted filter chips + group-by toggle REPLACE the inbox/wip/prs/issues tabs** (collapsing four tabs into one filterable list), with **Team as the only surviving secondary surface** (DECISION 3). The mockup is tab-less for the action surface; the chips are the new IA.
     - **Group by Priority** (default): the 3 existing urgency tiers (now/waiting/later) — unchanged from Phase 1.
     - **Group by Repo**: section headers per repo (`repoName`, with a per-repo count), items sorted by urgency within. Recovers the WIP per-repo overview (DECISION 2).
     - **Group by Type**: section headers per item type with the count baked in — e.g. `PULL REQUESTS 11`, `ISSUES 4`, `MENTIONS 2`, `DEPENDENCIES 3`, `LOCAL 1` (matches the mockup's "PULL REQUESTS 11" header).
   - *Coexistence fallback* (lower-ambition): keep the unified inbox AS the inbox tab and leave prs/issues tabs as-is. Not recommended — it contradicts the mockup and leaves duplicate surfaces.

5. **`launchpadActiveTab` persistence under the new model.** With tabs collapsing, the persisted "active tab" loses meaning for the inbox surface.
   - *Recommendation*: **Repurpose persistence to the group-by mode and the active filter chip** — add `launchpadGroupBy: "priority" | "repo" | "type"` (default `"priority"`) and `launchpadFilter: "all" | "myPrs" | "toReview" | "issues" | "deps" | "mentions"` (default `"all"`) to settings; keep `launchpadActiveTab` ONLY if Team survives as a tab (then it degrades to `"today" | "team"`). Realign the `SettingsPanel.vue` type drift noted in P2.0 at the same time (same-commit rule).

## P2.2 Sub-phasing (each independently mergeable, test-first)

| Sub-phase | Scope | Risk | Depends on |
|---|---|---|---|
| **P2a** | Rename Launchpad → Today (display values only) + counted filter chips + group-by toggle (Priority/Repo/Type) over the **current PR-derived inbox** | Low | none (can ship before decisions 2-4 if filters operate over the existing inbox tier data) |
| **P2b** | Issues / @-mentions / dependency PRs as first-class **union** inbox items (generalize `useLaunchpadInbox` to a union item type), wiring the new filter chips to real per-type counts; reconcile/remove tabs per DECISIONS 2-4 | Medium | DECISIONS 1-5; P2a |

Rationale: P2a is a UX/IA reshape over data that already exists (PRs + local cards), so it ships value and the rename immediately with no backend dependency. P2b is the data-model generalization and tab reconciliation, which needs the open decisions resolved.

---

## P2a — Rename + filter chips + group-by (PR inbox only)

### P2a-1 — Rename display values (i18n only)

**Files**: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`.

Change ONLY the 8 enumerated VALUES (P2.0) from "Launchpad" → "Today" (localized per DECISION 1). Keys, key paths, and the `launchpad.*` namespace are unchanged.

- `sidebar.footerLaunchpad`, `sidebar.launchpad`, `workspace.openLaunchpad`, `launchpad.title` → "Today" (localized).
- `launchpad.openTooltip` → swap leading noun: e.g. en "Today — cross-repo overview (⌘L)", fr "Aujourd'hui — vue d'ensemble multi-dépôts (⌘L)". Keep the ⌘L token verbatim.
- `menu.openLaunchpad` → "Open Today" (localized; fr "Ouvrir Aujourd'hui", etc.).
- `launchpad.noWorkspace.warning` → reword to reference "Today".
- `settings.launchpad.disableTeamTab.label` → reword "Launchpad" → "Today" (only if Team survives; else removed with the tab in P2b).

**No code change** — `AppDock.vue`, `LaunchpadView.vue`, `App.vue` already read these keys. The structural `Locale` type guarantees all 5 locales stay parallel at build.

**Acceptance**: grep for `"Launchpad"` / `启动台` across `locales/` returns zero user-visible occurrences (the team-tab label may remain if Team stays); `pnpm --filter @gitwand/desktop build` (vue-tsc) passes; AppDock label + ⌘L tooltip + view title + command palette all read "Today".

**Test**: extend `AppDock` / `LaunchpadView.test.ts` assertions that previously matched the title to the new key value (tests assert against `t()` output which returns the key in the test i18n stub — verify whether the suite stubs `t` to echo keys; if so, no test change needed for VALUE-only edits).

### P2a-2 — Filter chips + group-by toggle over the existing tier data (composable)

**File**: `apps/desktop/src/composables/useLaunchpadInbox.ts` (extend; keep `classifyInboxPr` pure).

Add, as `computed` derivations over the already-classified items (no new fetch, no watcher, O(n)):

- `type InboxFilter = "all" | "myPrs" | "toReview" | "issues" | "deps" | "mentions"` and `type InboxGroupBy = "priority" | "repo" | "type"`.
- A per-item **type tag** derived from the classification (P2a: only `pr` exists from this source; `deps` = items whose `case`/`action` is the dependency-bump path; `toReview` = `case: "review"`; `myPrs` = mine). `issues`/`mentions` counts are 0 until P2b (chips render with count 0 / disabled).
- `filterCounts: ComputedRef<Record<InboxFilter, number>>` — live counts driving the chip badges.
- `filteredTiers(filter)` and `groupedItems(groupBy, filter)` — return `InboxGroup[]` where a group is `{ key, label, count, items }`. For `priority` → existing tiers; `repo` → group by `pr.repoName`; `type` → group by type tag (the mockup's "PULL REQUESTS 11" header).

Keep everything `computed`; the active `filter`/`groupBy` come from settings refs passed in (or local refs synced to settings in the component — DECISION 5).

**Test-first** (`useLaunchpadInbox.test.ts`): add cases asserting `filterCounts` for a mixed fixture (my-PRs, review-requested, dependabot), `filteredTiers("toReview")` returns only review items, `groupedItems("repo", "all")` groups by repo with correct counts, `groupedItems("type", "all")` yields a `PULL REQUESTS` group with the right count. Issues/mentions counts assert 0 in P2a.

### P2a-3 — Render chips + segmented group-by; wire settings (component)

**Files**: `apps/desktop/src/components/LaunchpadView.vue` (inbox panel only); `useSettings.ts` + `SettingsPanel.vue` (same-commit settings pair, DECISION 5).

- Render the counted filter chips row (`Tout / Mes PRs / À relire / Issues / Dépendances [/ Mentions]`) and the "Regrouper" segmented toggle (`Priority / Repo / Type`) above the list. Thin component: bind to composable computeds; click handlers set the settings-backed refs.
- Replace the Phase-1 tier loop with `groupedItems(groupBy, filter)` rendering. Reuse the existing row markup, action button, accent CSS — no new per-row logic.
- Add settings fields `launchpadGroupBy` + `launchpadFilter` to **both** `useSettings.ts` (`AppSettings` + defaults) and `SettingsPanel.vue` (local `Settings` + defaults), and fix the pre-existing `launchpadActiveTab` type drift (add `"inbox"`, default to `"inbox"`).
- i18n: new keys under `launchpad.*` for chip labels (`launchpad.filter.all|myPrs|toReview|issues|deps|mentions`) and group labels (`launchpad.groupBy.priority|repo|type`, `launchpad.typeGroup.prs|issues|mentions|deps|local`), in all 5 locales.

**Perf (P6.4)**: chips/group are `computed`-only over already-fetched data; no new poll, no `{deep:true}`, inbox still gated by its `v-if`. No `<img>`. The expensive Team fetch is untouched.

**Test**: extend `LaunchpadView.test.ts` — the suite mocks composable refs, so add `filterCountsRef`/`groupedItemsRef` mocks (mirror the existing `inboxTiersRef` pattern), assert chip counts render, clicking a chip swaps the rendered group set, group-by toggle changes section headers.

---

## P2b — Issues / @-mentions / dependency PRs as first-class union items

### P2b-1 — Union item model in `useLaunchpadInbox`

**File**: `apps/desktop/src/composables/useLaunchpadInbox.ts` (generalize).

- Introduce a discriminated union `InboxEntity = { kind: "pr"; pr: PrWithRepo } | { kind: "issue"; issue: IssueWithRepo } | { kind: "mention"; ... } | { kind: "dep"; pr: PrWithRepo } | { kind: "local"; card: RepoActionCard }` and an `InboxItem` carrying `{ entity, classification }`.
- Generalize the classifier: `classifyInboxPr` stays for PRs; add `classifyIssue(issue, me)` (assigned/created/mentioned → tier+action `reply`/`view`) and a mention classifier. Local cards map to `tier: "now"`, type `local`.
- The composable now takes `allPrs`, `allIssues` (and the `mentioned`-filter subset) + `wip`-derived cards as inputs and unifies them; `filterCounts` now returns real `issues`/`mentions`/`deps` numbers.
- Dependencies: `deps` = PRs passing `isDependencyBump` (already exists); they get their own type tag and the `autoMerge` action **label** (display-only until Phase 3).

**Test-first**: extend `useLaunchpadInbox.test.ts` with issue/mention/dep entities; assert union grouping, per-type counts, and that the dependency PRs are pulled out of the generic PR group into `deps`.

### P2b-2 — Wire issues + mentions data (mostly existing)

**Files**: `LaunchpadView.vue` (pass `allIssues` / mentioned subset into `useLaunchpadInbox`), `useLaunchpadIssues.ts` (expose a `mentionedIssues` computed if not already separable).

- Issue assigned/created/mentioned data already fetched (`useLaunchpadIssues`); reuse it — **no new fetch on the inbox hot path**. The `mentioned` filter subset feeds the `mentions` chip.
- `open-issue` emit + `App.vue` `openLaunchpadIssue` handler already exist (Phase 1 verified) — reuse for the issue/mention row actions.

### P2b-3 — Reconcile / remove tabs (DECISIONS 2-4)

**File**: `LaunchpadView.vue` (+ `useSettings.ts`/`SettingsPanel.vue` if `launchpadActiveTab` changes shape).

- Per DECISION 4 (recommended): remove the `wip`/`prs`/`issues` standalone tabs; the unified filtered+grouped list is the single action surface. Keep Team as the lone secondary surface (DECISION 3) with its lazy-load + `launchpadTeamTabEnabled` intact.
- Remove now-dead markup/handlers for the dropped tabs (the snoozed bandeaux move into the unified list's footer; pin/snooze ⋮ menus reused per-row). Keep `useLaunchpadPins` wiring.
- Update `LaunchpadTab` type + `launchpadActiveTab` (DECISION 5) and realign `SettingsPanel.vue`.

**Test**: `LaunchpadView.test.ts` — assert the removed tabs no longer render; the unified list renders PR + issue + mention + dep + local rows; Team tab still gated by `teamTabEnabled`.

### P2b-4 — (Backend gap) PR @-mentions — DEFER or cheap-fill

- **Gap**: `mentions:@me` via `gh issue list` returns issues only; PR-thread mentions are absent.
- **Recommendation**: **DEFER PR-mentions to a follow-up** and ship issue-mentions only in v2.29 (label the chip "Mentions" = issue mentions). The cheapest real fill is a `gh search prs --mentions=@me` (or `gh api search/issues?q=mentions:@me+is:pr`) call; in this repo that means a new `workspace_pr_mentions_all` Tauri command + `backend.ts` wrapper + dev-server route + Rust impl — a non-trivial new forge round-trip that would violate "no new forge round-trips on the hot path" if eager. If pursued, it must be lazy (only when the Mentions chip is selected) and cached like the issue filters.
- **Flag**: this is the one place P2b may need a new Tauri command. The plan recommends NOT taking it in v2.29; the executor should confirm with the user before adding any command.

---

## P2.7 Files touched (summary)

| File | P2a | P2b |
|---|---|---|
| `locales/{en,fr,es,pt-BR,zh-CN}.ts` | rename 8 values + add filter/group keys | add issue/mention/dep type-group keys |
| `composables/useLaunchpadInbox.ts` | filter/group computeds over PR data | generalize to union entity + issue/mention/dep classifiers |
| `composables/__tests__/useLaunchpadInbox.test.ts` | filter/group cases | union/issue/mention/dep cases |
| `components/LaunchpadView.vue` | chips + segmented toggle render; settings wiring | union rendering; remove wip/prs/issues tabs |
| `components/__tests__/LaunchpadView.test.ts` | chip/group mocks + assertions | union rows; removed-tab assertions |
| `composables/useSettings.ts` | + `launchpadGroupBy`, `launchpadFilter`; fix `launchpadActiveTab` | shape `launchpadActiveTab` per DECISION 5 |
| `components/SettingsPanel.vue` | mirror settings fields (same commit) | mirror |
| `composables/useLaunchpadIssues.ts` | — | expose `mentionedIssues` if needed |

**Not touched (Phase 2)**: `App.vue` handlers (`openLaunchpadPr/Issue/RepoChanges` reused), `AppDock.vue` (reads renamed keys), Rust (`gh.rs`/`lib.rs`), `dev-server.mjs` (issue-mentions route already present), version-managed files. **One possible exception**: PR-mentions backend (P2b-4) — recommended deferred.

## P2.8 Constraints honored (checklist)

- **Composition API `<script setup>`**: unchanged; logic stays in composables, view stays thin.
- **IPC via `backend.ts`**: no new `invoke()`. Issue-mentions reuse existing `workspaceIssuesAll`. The only candidate new command (PR-mentions) is flagged and recommended deferred.
- **Perf P6.4**: all chip/group/union derivation is `computed` over already-fetched data; no new poll, no `{deep:true}`, no eager expensive fetch; Team stays lazy; inbox gated by `v-if`; no external `<img>`.
- **5-locale i18n**: rename touches all 5; new keys added to all 5; structural `Locale` type enforces parity at build.
- **Settings sync**: every new field added to `useSettings.ts` AND `SettingsPanel.vue` in the same commit; pre-existing `launchpadActiveTab` drift fixed.
- **No manual version edits**: no version-managed file touched (window title verified to not say "Launchpad").
- **Test-first**: composable tests precede each render change; component tests follow the existing ref-mock pattern.

## P2.9 Deferred to Phase 3 (NOT planned)

- Active mutations: real **Nudge** (post a comment), **Auto-merge** (enable forge auto-merge), and the direct **Resolve** jump (checkout PR branch → open the GitWand conflict resolver in one click — the headline differentiator). Phase 2 keeps these as display-only labels routing to in-app PR review.
- PR-thread @-mentions backend (P2b-4) unless the user opts in during P2b.
