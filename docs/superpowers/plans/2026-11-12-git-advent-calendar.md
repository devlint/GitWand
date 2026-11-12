# Git Advent Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 24-door Git advent calendar on gitwand.app/advent and as `gitwand advent [day]` in `@gitwand/cli`, fed by one shared content module, released as 3.13.2 by Friday 27 November 2026.

**Architecture:** A pure, import-free content module plus pure date/markup helpers live in `packages/cli/src/advent/`. The CLI renders them as ASCII. The VitePress site imports the same files through an alias, and renders a client-side grid with a native `<dialog>`, one static page per day, and per-day OG tags and images.

**Tech Stack:** TypeScript, Node 22+, vitest 4, VitePress 2 (alpha.17), Vue 3 `<script setup>`, headless Chrome (one-off OG image generation, local only).

**Spec:** `docs/superpowers/specs/2026-11-12-git-advent-calendar-design.md`. Content: `docs/superpowers/specs/2026-11-12-git-advent-calendar-content.md`.

## Global Constraints

- English only, site and CLI.
- Edition year **2026**. Phases are computed on the **Europe/Paris** calendar date:
  - before 2026-12-01: `not-started`;
  - 2026-12-01 to 2026-12-24: `running`, and today's door is the day of the month;
  - from 2026-12-25, in every later year: `over`, with all doors open.
- Copy rule: tips never read like ads. No `!` in a tip. No hype words (`revolution*`, `game-changer`, `seamless`, `effortless`, `supercharge`, `blazing`). Every `tip` has non-empty `tipEvidence`, which is never rendered or emitted in JSON.
- Site URL: `https://gitwand.app/advent`, and `https://gitwand.app/advent/<day>` for a single door (no zero padding).
- Download link: `https://github.com/devlint/GitWand/releases/latest`, labelled "Download GitWand".
- CLI rules (`packages/cli/CLAUDE.md`): one file per command in `commands/`, `--json` supported, exit 0/2 (no "1" case here). The CLI's arg parser is the hand-written `parseArgs` in `cli.ts`, not commander.
- `packages/core` is not touched. Files in `packages/cli/src/advent/` import nothing from Node or from `ui.ts`, because the website bundles them for the browser. `doors.ts` imports nothing at all, because the OG script loads it with `node --experimental-strip-types`.
- The site is **dark-only** (`appearance: 'force-dark'`, Nocturne theme). Use the existing `--nc-*` tokens from `custom.css`, and wrap the page in `.gw-page`. *This corrects the spec's "light and dark".*
- No version edits by hand. Release through the `release` skill (`./scripts/bump-version.sh 3.13.2`).

## Review Focus

1. **Midnight Paris vs UTC.** 2026-11-30T23:00:00Z is already 1 December in Paris (CET, UTC+1), so door 1 opens then and not at 01:00. Tested in Task 1.
2. **Deep link to a locked door.** `/advent/18` opened on December 12 must show the grid plus "Patience — opens on December 18", never the door's content. Tested in Task 6 (`initialDoorAction`).
3. **Storage unavailable.** When `localStorage` throws (private mode, blocked site data), the page still works, progress just isn't remembered. Tested in Task 6.
4. **Malformed date override.** `?date=foo`, `?date=2026-13-40`, or `GITWAND_ADVENT_DATE=12/12/2026` are ignored, and the real date is used. Tested in Task 1 (`parseDateOverride`).
5. **Narrow or piped terminal.** If `process.stdout.columns` is undefined (a pipe), the width is 80. Below 72 columns the tree is dropped. Snippet lines are never wrapped, so they stay copy-pasteable. Tested in Task 3.

---

### Task 1: Shared date and inline-markup helpers

**Files:**
- Create: `packages/cli/src/advent/calendar.ts`, `packages/cli/src/advent/inline.ts`
- Test: `packages/cli/src/__tests__/advent-calendar.test.ts`, `packages/cli/src/__tests__/advent-inline.test.ts`

**Interfaces — Produces:**
```ts
// calendar.ts
export const ADVENT_YEAR = 2026;
export const DOOR_COUNT = 24;
export const ADVENT_URL = "https://gitwand.app/advent";
export type CalendarState =
  | { phase: "not-started" }
  | { phase: "running"; today: number }   // 1..24
  | { phase: "over" };
export function parisYmd(now: Date): { year: number; month: number; day: number };
export function calendarState(now: Date): CalendarState;
export function isUnlocked(day: number, now: Date): boolean;
export function parseDateOverride(value: string | null | undefined): Date | null; // "YYYY-MM-DD" → that date at 12:00 UTC; anything else → null
export function doorUrl(day?: number): string;          // ADVENT_URL or `${ADVENT_URL}/${day}`
export function opensOn(day: number): string;           // "2026-12-18"
// inline.ts
export type Segment = { kind: "text" | "code" | "strong"; text: string };
export function parseInline(text: string): Segment[];   // `code` and **strong**; an unmatched marker stays literal text
```

- [ ] **Step 1: Write the failing tests**

`advent-calendar.test.ts`:
- `calendarState(new Date("2026-11-30T22:59:59Z"))` → `{ phase: "not-started" }`
- `calendarState(new Date("2026-11-30T23:00:00Z"))` → `{ phase: "running", today: 1 }`
- `calendarState(new Date("2026-12-12T10:00:00Z"))` → `{ phase: "running", today: 12 }`
- `calendarState(new Date("2026-12-24T22:59:59Z"))` → `{ phase: "running", today: 24 }`
- `calendarState(new Date("2026-12-24T23:00:00Z"))` → `{ phase: "over" }`
- `calendarState(new Date("2027-12-05T12:00:00Z"))` → `{ phase: "over" }` (2027 does not lock again)
- `calendarState(new Date("2025-12-10T12:00:00Z"))` → `{ phase: "not-started" }`
- `isUnlocked(12, dec12)` true, `isUnlocked(13, dec12)` false, `isUnlocked(24, nov20)` false, `isUnlocked(1, jan2027)` true
- `parseDateOverride("2026-12-12")` → a Date whose `calendarState` is running/12. `parseDateOverride("foo")`, `("2026-13-40")`, `("12/12/2026")`, `("")`, `(null)`, `(undefined)` → `null`
- `doorUrl()` → `"https://gitwand.app/advent"`, `doorUrl(7)` → `"https://gitwand.app/advent/7"`, `opensOn(18)` → `"2026-12-18"`

`advent-inline.test.ts`:
- ``parseInline("Run `git add -p` then **Stage hunk**.")`` → `[text "Run ", code "git add -p", text " then ", strong "Stage hunk", text "."]`
- ``parseInline("a ` b")`` → `[text "a ` b"]` (unmatched marker stays literal)
- `parseInline("")` → `[]`

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @gitwand/cli exec vitest run src/__tests__/advent-calendar.test.ts src/__tests__/advent-inline.test.ts`
Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 3: Implement `calendar.ts` and `inline.ts`**

`parisYmd` uses `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts`. It must work in Node and in browsers, with no `node:` imports. `parseDateOverride` validates the result with a round-trip, so `2026-02-31` becomes `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

`git add packages/cli/src/advent packages/cli/src/__tests__/advent-*.test.ts && git commit -m "feat(cli): advent calendar date and markup helpers"`

---

### Task 2: The 24 doors as data

**Files:**
- Create: `packages/cli/src/advent/doors.ts`, `packages/cli/src/advent/index.ts`
- Test: `packages/cli/src/__tests__/advent-doors.test.ts`

**Interfaces — Produces:**
```ts
// doors.ts — imports nothing
export interface AdventDoor {
  day: number;
  command: string;        // door title, e.g. "git log -L"
  problem: string;        // reader's voice, no surrounding quotes
  snippet: string;        // runnable lines only, "\n"-separated
  explanation: string;    // inline markup (`code`, **label**)
  tip?: string;           // inline markup
  tipEvidence?: string[]; // internal: each entry starts with a repo-relative path, optionally ":line" or " — note"
  readMore?: string;      // site path, e.g. "/blog/worktrees-step-by-step"
}
export const DOORS: readonly AdventDoor[];
export type PublicDoor = Omit<AdventDoor, "tipEvidence">;
export function publicDoor(door: AdventDoor): PublicDoor;
// index.ts — re-exports calendar.ts, inline.ts, doors.ts (the site's entry point)
```

- [ ] **Step 1: Write the failing content-lint tests** (`advent-doors.test.ts`)
- `DOORS.length === 24` and `DOORS[i].day === i + 1`.
- Every door has non-empty `command`, `problem`, `snippet` and `explanation`.
- Every door with a `tip` has a non-empty `tipEvidence`. For each entry, the path before the first space or `:` exists, resolved from the repo root (`new URL("../../../../", import.meta.url)`) or, failing that, from `apps/desktop/src/` or `apps/desktop/`. This catches evidence that has drifted.
- No tip contains `!`, and no tip or explanation matches `/revolution|game[- ]?changer|seamless|effortless|supercharge|blazing/i`.
- Each `readMore` resolves to an existing `website<path>.md` (or `website<path>/index.md`).
- For every inline field, `parseInline` leaves no segment containing `` ` `` or `**` (balanced markup).
- `publicDoor(DOORS[11])` has no `tipEvidence` key.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @gitwand/cli exec vitest run src/__tests__/advent-doors.test.ts`. Expected: FAIL, `doors.js` is missing.

- [ ] **Step 3: Transcribe the content doc into `doors.ts`**

Copy the 24 doors from the content doc verbatim, with three adjustments:
- `snippet` keeps runnable lines only. Alternatives such as "(or `--color-words`)" move into `explanation`.
- Comments inside a snippet are kept as shell `#` comments (day 18).
- The "Review note" lines are dropped.

Day 24's `readMore` becomes `/fix/git-rerere`, a dedicated page that fits better than the blog post. Update the content doc in the same commit. **From this commit, `doors.ts` is the source of truth**, so add a line saying so at the top of the content doc. `index.ts` re-exports everything.

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS. Fix any evidence path the test rejects by correcting the path, never by loosening the test.

- [ ] **Step 5: Commit.** `git commit -m "feat(cli): the 24 advent calendar doors"`

---

### Task 3: ASCII rendering of a door and of the status messages

**Files:**
- Create: `packages/cli/src/advent-render.ts`
- Test: `packages/cli/src/__tests__/advent-render.test.ts`

**Interfaces:**
- Consumes: `AdventDoor`, `parseInline`, `doorUrl`, `DOOR_COUNT` (Tasks 1–2). Also `type Palette = typeof c` from `ui.ts`.
- Produces:
```ts
export const TREE_MIN_WIDTH = 72;
export function renderDoor(door: AdventDoor, opts: { palette: Palette; width: number }): string;
export function renderLocked(day: number, palette: Palette): string;   // "Patience — door 18 opens on December 18 🎁"
export function renderNotStarted(palette: Palette): string;            // "The GitWand Advent Calendar starts on December 1, 2026. Meanwhile: https://gitwand.app/advent"
export function renderOver(palette: Palette): string;                  // "The calendar is over — every door is open: gitwand advent <1-24> or https://gitwand.app/advent"
export function renderInvalid(arg: string, palette: Palette): string;  // `Unknown door "31" — pick a day from 1 to 24.`
```

- [ ] **Step 1: Write the failing tests.** Use a `plain` palette (every key `""`) and the door for day 12. Assert that:
- At `width: 80`, the output contains `★`, `Day 12 · git log -L`, the problem in straight double quotes, `$ git log -L :parseHunk:src/parse.ts`, `🪄 ` followed by the tip text with the markup stripped, and the last non-empty line equal to `12/24 · all doors: https://gitwand.app/advent/12`.
- At `width: 60`, it does not contain `★`.
- No output line is longer than `width`, **except** snippet lines (each `$ …` line appears unbroken, even at `width: 40`).
- With the plain palette there is no `\x1b`. With an explicit ANSI palette built in the test (not `c`: `ui.ts` blanks it at load time when `CI` is set, which is the case in CI), `` `code` `` segments are wrapped in that palette's `cyan`.
- A door without a tip (day 1) has no `🪄` line.
- `renderLocked(18, plain)` matches the copy above exactly. Same for the three other messages.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @gitwand/cli exec vitest run src/__tests__/advent-render.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The layout follows the spec mockup: a 6-line tree in a 19-column gutter, and the text column wrapped at word boundaries to `width - 19` (or `width - 4` without the tree). The tip and footer go full-width under the tree. The star is yellow, the tree green, the header bold magenta. Multi-line snippets get one `$ ` per line, and `#` comment lines are dimmed.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(cli): render advent doors as ASCII"`

---

### Task 4: `gitwand advent [day]`

**Files:**
- Create: `packages/cli/src/commands/advent.ts`
- Modify: `packages/cli/src/cli.ts` (dispatch, help line, update check), `packages/cli/README.md`, `website/reference/cli-commands.md`
- Test: `packages/cli/src/__tests__/advent-command.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
```ts
export type AdventResult = { code: 0 | 2; stream: "stdout" | "stderr"; output: string };
export function runAdvent(
  positional: string[],
  flags: Record<string, boolean | string>,
  ctx: { now: Date; width: number; palette: Palette },
): AdventResult;
export async function cmdAdvent(positional: string[], flags: Record<string, boolean | string>): Promise<void>;
// cli.ts
export function shouldCheckForUpdate(command: string | undefined): boolean; // false for "advent"
```
JSON shapes, printed with `JSON.stringify(x, null, 2)`:
`{ "status": "door", "door": PublicDoor }` · `{ "status": "locked", "day": 18, "opensOn": "2026-12-18" }` · `{ "status": "not-started", "startsOn": "2026-12-01" }` · `{ "status": "over" }` · `{ "status": "error", "error": "Unknown door \"31\" — pick a day from 1 to 24." }` (code 2, stdout).

- [ ] **Step 1: Write the failing tests.** Call `runAdvent` with fixed dates:
- On Dec 12 with no argument: code 0, stdout, contains `Day 12 · git log -L`.
- On Dec 12 with `["5"]`: `Day 5`. With `["18"]`: equals `renderLocked(18, …)`, code 0.
- `["31"]`, `["0"]`, `["abc"]`, `["1.5"]`: code 2, stderr, `renderInvalid`.
- On Nov 20, `[]` and `["3"]`: not-started message.
- On Dec 26, `[]`: over message. `["18"]`: door 18.
- On Dec 12 with `--json`: `JSON.parse(output)` matches each shape above, and `door` has no `tipEvidence`.
- `shouldCheckForUpdate("advent") === false`, `shouldCheckForUpdate("resolve") === true`.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @gitwand/cli exec vitest run src/__tests__/advent-command.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
- `cmdAdvent` builds ctx from `parseDateOverride(process.env.GITWAND_ADVENT_DATE) ?? new Date()`, `process.stdout.columns ?? 80`, and `c`. It writes to the chosen stream, then calls `process.exit(code)`.
- In `cli.ts`, add `else if (command === "advent")` and the help line `gitwand advent [day]            Open today's door of the Git Advent Calendar (Dec 1–24)`.
- Wrap `checkForUpdate` in `if (shouldCheckForUpdate(command))`.
- Document the command (arguments, `--json` shapes, exit codes) in the CLI README and in `website/reference/cli-commands.md`. `GITWAND_ADVENT_DATE` stays undocumented.

- [ ] **Step 4: Run the CLI suite.** `pnpm --filter @gitwand/cli test && pnpm --filter @gitwand/cli build`. Expected: PASS, build clean.

- [ ] **Step 5: Smoke-test the binary.**
- `GITWAND_ADVENT_DATE=2026-12-12 node packages/cli/dist/index.js advent` shows door 12 with the tree.
- The same command with `NO_COLOR=1`, and piped through `| cat`, prints no escape codes and still shows the tree at width 80.
- `… advent 31; echo $?` prints `2`.

- [ ] **Step 6: Commit.** `git commit -m "feat(cli): gitwand advent command"`

---

### Task 5: Site plumbing — alias, per-page OG image, advent routes and meta

**Files:**
- Create: `website/.vitepress/advent-page.ts`, `website/advent/index.md`, `website/advent/[day].md`, `website/advent/[day].paths.ts`
- Modify: `website/.vitepress/config.ts` (alias, head, `transformPageData`), `website/vitest.config.ts` (alias)
- Test: `website/.vitepress/theme/__tests__/advent-page.test.ts`

**Interfaces:**
- Consumes: `DOORS` via a relative import `../../packages/cli/src/advent/index.ts` (the config is not under the Vite alias). Theme code uses the alias `@gitwand/advent` → `packages/cli/src/advent/index.ts`, declared in both `config.ts` (`vite.resolve.alias`) and `vitest.config.ts`.
- Produces:
```ts
export const DEFAULT_OG_IMAGE = "https://gitwand.app/og-image.png";
export function adventPageMeta(day: number | null): { title: string; description: string; ogImage: string };
```
`null` → title `Git Advent Calendar — 24 little-known git commands`, description `24 little-known git commands, one a day until Christmas, each with a GitWand tip.`, ogImage `https://gitwand.app/advent/og/index.png`. Day N → title `Day N · <command> — Git Advent Calendar`, description `<problem> <command>: day N of the GitWand Git Advent Calendar.`, ogImage `https://gitwand.app/advent/og/day-NN.png` (two digits).

- [ ] **Step 1: Write the failing test.** Check `adventPageMeta(null)` and `adventPageMeta(12)` against the exact strings above.
- [ ] **Step 2: Run to verify it fails.** `pnpm --filter gitwand-website test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- `[day].paths.ts` returns `params: { day: "1" … "24" }`.
- `index.md` and `[day].md` use `layout: page` and render `<AdventCalendar />` and `<AdventCalendar :initial-day="Number($params.day)" />`. The component is registered in Task 6, so until then add a placeholder registration that renders nothing.
- Remove the global `og:image` and `twitter:image` entries from `head` (keep width and height). In `transformPageData`, push `og:image` and `twitter:image` from `pageData.frontmatter.ogImage ?? DEFAULT_OG_IMAGE` for **every** page.
- For `relativePath === "advent/index.md"` or `pageData.params?.day`, set `pageData.title`, `frontmatter.title`, `frontmatter.description` and `frontmatter.ogImage` from `adventPageMeta`, plus `og:title`, `og:description` and `twitter:title`, before the canonical block runs.
- [ ] **Step 4: Verify.** `pnpm --filter gitwand-website test && pnpm --filter gitwand-website build`. Then:
- `grep -c 'og:image' website/.vitepress/dist/features.html` → `1`;
- `website/.vitepress/dist/advent/12.html` has the canonical `https://gitwand.app/advent/12` and `og:image` `…/advent/og/day-12.png`;
- the sitemap lists `/advent` and the 24 day URLs.
- [ ] **Step 5: Commit.** `git commit -m "feat(website): advent routes and per-page OG image"`

---

### Task 6: The calendar page

**Files:**
- Create in `website/.vitepress/theme/advent/`: `advent-state.ts`, `AdventCalendar.vue`, `AdventDoorDialog.vue`, `AdventInline.vue`
- Modify: `website/.vitepress/theme/index.ts` (register `AdventCalendar`)
- Test: `website/.vitepress/theme/__tests__/advent-state.test.ts`

**Interfaces:**
- Consumes: `@gitwand/advent` (Tasks 1–2).
- Produces (`advent-state.ts`, pure):
```ts
export const STORAGE_KEY = "gitwand-advent-2026-opened";
export function resolveNow(search: string, real: Date): Date;               // `?date=YYYY-MM-DD` via parseDateOverride, else real
export function readOpened(storage: Pick<Storage, "getItem"> | null): Set<number>;
export function markOpened(storage: Pick<Storage, "getItem" | "setItem"> | null, day: number): Set<number>;
export function lockedMessage(day: number): string;                          // "Patience — opens on December 18"
export function initialDoorAction(day: number | undefined, now: Date): "open" | "locked" | "none";
export function adventBadge(now: Date): { text: string; href: "/advent" } | null;
// running → `Git Advent Calendar — door ${today} is open`; Paris date 2026-12-25 → "Git Advent Calendar — all 24 doors are open"; otherwise null
```

- [ ] **Step 1: Write the failing tests.**
- `resolveNow("?date=2026-12-12", real)` → Dec 12. `resolveNow("?date=nope", real)` → `real`.
- `readOpened` / `markOpened` round-trip through a `Map`-backed fake. With a storage whose methods throw, or `null`, they return an empty set or the in-memory set and never throw. A corrupt stored value (`"{"`) → empty set. Days outside 1..24 are ignored.
- `initialDoorAction(18, dec12)` → `"locked"`, `(5, dec12)` → `"open"`, `(undefined, dec12)` → `"none"`, `(3, nov20)` → `"locked"`.
- `adventBadge`: on Nov 30 Paris → `null`. On Dec 12 → door 12 text. On Dec 25 → all-open text. On Dec 26 → `null`.
- [ ] **Step 2: Run to verify it fails.** `pnpm --filter gitwand-website test`. Expected: FAIL.
- [ ] **Step 3: Implement `advent-state.ts`.** Run the tests. Expected: PASS.
- [ ] **Step 4: Build the components.** Composition API with `<script setup>`. Business logic stays in `advent-state.ts`.
  - **`AdventCalendar.vue`** (prop `initialDay?: number`), wrapped in `.gw-page`.
    - Heading "Git Advent Calendar", the line "24 little-known git commands, one a day until Christmas.", a progress line `N/24 opened`, then the grid: 6 columns, 4 below 640px, no horizontal scroll.
    - The state (`now`, opened set, door states) is computed in `onMounted` only. SSR renders every door as neutral and locked-looking, to avoid a hydration mismatch.
    - Door states: *opened*, *today*, *locked*. Door 24 shows 🎄 and its number.
    - Clicking a locked door runs a short CSS shake, and puts `lockedMessage(day)` in an `aria-live="polite"` region.
    - Before Dec 1, show "Doors open on December 1." On and after Dec 25, show "Every door is open — merry Christmas."
    - `initialDoorAction` decides on mount whether to open the dialog or show the locked message.
    - Opening a door: a 400 ms door-flip (CSS `rotateY`, skipped under `prefers-reduced-motion`), then `markOpened`, `history.replaceState` to `/advent/N`, and the dialog. Closing replaces the URL back to `/advent` and returns focus to the door.
  - **`AdventDoorDialog.vue`** is a native `<dialog>` opened with `showModal()`, with `aria-labelledby` pointing at its title. It closes with Esc (native), a backdrop click, or a "Close" button. It shows, in order:
    1. `Day N`;
    2. the command (title);
    3. the problem in quotes;
    4. the snippet in a `<pre>`, with a "Copy" button (`navigator.clipboard.writeText`, label "Copied" for 1.5 s; on failure, select the `<pre>` text);
    5. the explanation;
    6. the tip prefixed with 🪄, if any;
    7. "Read more" if any;
    8. a discreet "Download GitWand" link.
  - **`AdventInline.vue`** renders `parseInline` segments as text, `<code>` and `<strong>`. No `v-html`.
  - **Styling:** `--nc-*` tokens only, festive but restrained. Fonts: Inter for text, JetBrains Mono for commands.
- [ ] **Step 5: Verify.** `pnpm --filter gitwand-website test && pnpm --filter gitwand-website build`. Expected: PASS, build clean.
- [ ] **Step 6: Commit.** `git commit -m "feat(website): advent calendar page"`

---

### Task 7: Date-aware home badge and nav link

**Files:**
- Create: `website/.vitepress/theme/advent/AdventNavLink.vue`
- Modify: `website/.vitepress/theme/HomeLanding.vue` (pill around line 1002), `website/.vitepress/theme/index.ts` (`Layout` with slots)

**Interfaces:** Consumes `adventBadge`, `resolveNow` (Task 6).

- [ ] **Step 1: Implement the home badge.** In `HomeLanding.vue`, an `advent` ref is set in `onMounted` from `adventBadge(resolveNow(location.search, new Date()))`. The pill uses `advent?.text ?? nt.badge` and `advent?.href ?? "/changelog"`. The text is the same English string in every locale of the home picker (English-only decision).
- [ ] **Step 2: Implement the nav link.** `AdventNavLink.vue` renders `<a href="/advent">Advent 🎄</a>` only when `adventBadge(...)` is non-null, computed in `onMounted`. Mount it through `Layout: () => h(DefaultTheme.Layout, null, { "nav-bar-content-after": …, "nav-screen-content-after": … })`. *Spec deviation: VitePress's `nav` config is static at build time, so the date-aware nav link goes through a layout slot instead.*
- [ ] **Step 3: Verify.** Build passes. In `pnpm --filter gitwand-website dev`:
- `/?date=2026-12-12` shows "door 12 is open", linking to `/advent`, plus the nav link;
- `/?date=2026-11-20` and `/?date=2026-12-26` show the normal badge and no nav link.
- [ ] **Step 4: Commit.** `git commit -m "feat(website): date-aware advent badge and nav link"`

---

### Task 8: OG images

**Files:**
- Create: `website/scripts/advent-og.ts`, `website/public/advent/og/index.png`, `website/public/advent/og/day-01.png` … `day-24.png`
- Modify: `website/package.json` (script `"advent:og": "node --experimental-strip-types scripts/advent-og.ts"`)
- Test: add to `website/.vitepress/theme/__tests__/advent-page.test.ts`

- [ ] **Step 1: Write the failing test.** The test checks that the 25 files exist under `website/public/advent/og/`, and that each starts with the PNG signature `89 50 4E 47`.
- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Write the script.**
- It imports `DOORS` from `../../packages/cli/src/advent/doors.ts`.
- For each image, it writes an HTML file to `os.tmpdir()`:
  - 1200×630, Nocturne canvas background with an accent `#d2cefd`;
  - "GitWand · Git Advent Calendar", a large "Day N", the command in JetBrains Mono, and the problem;
  - for the index image, a small 24-door grid motif.
- It renders each file with `execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1200,630", `--screenshot=${out}`, fileUrl])`.
- `CHROME` defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and can be overridden with `CHROME_PATH`.
- The script runs locally only. It is never called from CI or `build`.
- [ ] **Step 4: Generate and look at the images.** Run `pnpm --filter gitwand-website advent:og`, then open `index.png`, `day-01.png`, `day-12.png` and `day-24.png` with the Read tool. Check the text is legible, the font is right (a fallback mono is acceptable), and nothing overflows (day 15's long command).
- [ ] **Step 5: Run the test.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(website): advent OG images"`

---

### Task 9: QA pass

No new code unless a defect is found. Fix defects in the owning task's files, with a test where possible.

- [ ] **Step 1: Site** (`pnpm --filter gitwand-website dev`, then drive it with the chrome-devtools MCP):
  - `/advent?date=2026-11-20`: everything locked, "Doors open on December 1".
  - `/advent?date=2026-12-12`: doors 1–11 open, 12 highlighted. Clicking door 14 shakes it and announces the message. Opening door 12: the URL becomes `/advent/12`, Esc closes it, the URL goes back to `/advent`, focus returns to door 12, and the progress counter goes up. "Copy" puts the snippet on the clipboard.
  - `/advent/18?date=2026-12-12`: grid plus "Patience — opens on December 18", no dialog.
  - `/advent?date=2026-12-26`: everything open, with the Christmas line.
  - 375 px width: 4 columns, no horizontal scroll, the dialog fits. Reduced motion (emulated): no flip.
  - Keyboard only: Tab reaches every door, Enter opens one, Tab stays inside the dialog.
- [ ] **Step 2: Full suites.** Run `pnpm -r run test` and `pnpm --filter gitwand-website build`. Expected: PASS.
- [ ] **Step 3: Commit any fixes,** then open the PR from the feature branch.

---

### Task 10: Release 3.13.2 by Friday 27 November 2026

Precondition: the user has reviewed and frozen the door content in `doors.ts`. CLI content can't change after the tag without another release.

- [ ] **Step 1:** Add a CHANGELOG `[Unreleased]` entry: "`gitwand advent` and gitwand.app/advent — a 24-door Git advent calendar".
- [ ] **Step 2:** Run the release with the `release` skill, version **3.13.2**. At the tag: `website/changelog.md` narrative, then `ROADMAP.md` Shipped. Check that the npm smoke tests pass and the update manifest is redeployed.
- [ ] **Step 3:** After the deploy, `npx @gitwand/cli@3.13.2 advent` prints the not-started message, and `https://gitwand.app/advent/12` serves `day-12.png` as its `og:image` (check the page source).
