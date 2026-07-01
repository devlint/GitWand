# GitTree — Quick Filters & Date Separators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two icon-toggle filters (current branch / my commits) to the CommitGraph search bar, and overlaid date-bucket separators in the commit list.

**Architecture:** Filter state lives in `useGitRepo.ts` and is surfaced via new props+emits on `CommitGraph.vue`. Date separators are computed from the existing `displayCommits` list and rendered as absolutely-positioned overlays — zero changes to `dagLayout.ts`. A new pure utility `dateBucket.ts` handles date grouping so it can be unit-tested independently.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Vitest (jsdom), existing `getGitLog` backend wrapper, CSS custom properties from the design system.

## Global Constraints

- Never hardcode user-facing strings — all new text goes through i18n keys in all 5 locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`.
- Locale files live at `apps/desktop/src/locales/*.ts`.
- No `border-radius: 9999px` / pill shapes on buttons — use `--radius-sm` / `--radius-md`.
- All IPC calls go through `apps/desktop/src/utils/backend.ts` — never call `invoke()` directly.
- Composition API + `<script setup>` only. No Options API.
- `pnpm` only (never npm/yarn).
- Run tests from `apps/desktop/`: `pnpm test`.
- Dev server (no Rust): `cd apps/desktop && pnpm dev:web`.

---

## File Map

| File | Change |
|------|--------|
| `apps/desktop/src/locales/en.ts` | +7 keys in `log` object |
| `apps/desktop/src/locales/fr.ts` | +7 keys in `log` object |
| `apps/desktop/src/locales/es.ts` | +7 keys in `log` object |
| `apps/desktop/src/locales/pt-br.ts` | +7 keys in `log` object |
| `apps/desktop/src/locales/zh-cn.ts` | +7 keys in `log` object |
| `apps/desktop/src/utils/dateBucket.ts` | **New** — pure date-bucket function |
| `apps/desktop/src/utils/__tests__/dateBucket.test.ts` | **New** — unit tests |
| `apps/desktop/src/composables/useGitRepo.ts` | +`logBranchFilter` state, +`setLogBranchFilter()`, modify `loadLog()` + `loadMoreLog()`, expand exports |
| `apps/desktop/src/App.vue` | Destructure + pass `logBranchFilter`, wire two new emits from `<CommitGraph>` |
| `apps/desktop/src/components/CommitGraph.vue` | +2 props, +2 emits, +2 icon buttons in toolbar, +date separators computed + render, +CSS |

---

### Task 1: i18n — 7 new keys in all 5 locales

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/fr.ts`
- Modify: `apps/desktop/src/locales/es.ts`
- Modify: `apps/desktop/src/locales/pt-br.ts`
- Modify: `apps/desktop/src/locales/zh-cn.ts`

**Interfaces:**
- Produces: i18n keys `log.filterCurrentBranch`, `log.filterMineCommits`, `log.dateSepToday`, `log.dateSepYesterday`, `log.dateSepThisWeek`, `log.dateSepThisMonth`, `log.dateSepOlder` — consumed by Tasks 4 and 5.

- [ ] **Step 1: Add 7 keys to `en.ts`**

Find the `log` object and locate `graphSearchFilterTitle`. Insert the 7 new keys immediately after it:

```typescript
// after graphSearchFilterTitle: "Show only matching commits",
filterCurrentBranch: "Current branch only",
filterMineCommits: "My commits only",
dateSepToday: "Today",
dateSepYesterday: "Yesterday",
dateSepThisWeek: "This week",
dateSepThisMonth: "This month",
dateSepOlder: "Older",
```

- [ ] **Step 2: Add 7 keys to `fr.ts`**

```typescript
// after graphSearchFilterTitle: "Afficher uniquement les commits correspondants",
filterCurrentBranch: "Branche courante uniquement",
filterMineCommits: "Mes commits uniquement",
dateSepToday: "Aujourd'hui",
dateSepYesterday: "Hier",
dateSepThisWeek: "Cette semaine",
dateSepThisMonth: "Ce mois-ci",
dateSepOlder: "Plus ancien",
```

- [ ] **Step 3: Add 7 keys to `es.ts`**

```typescript
// after graphSearchFilterTitle (look for the equivalent Spanish string),
filterCurrentBranch: "Solo rama actual",
filterMineCommits: "Solo mis commits",
dateSepToday: "Hoy",
dateSepYesterday: "Ayer",
dateSepThisWeek: "Esta semana",
dateSepThisMonth: "Este mes",
dateSepOlder: "Más antiguo",
```

- [ ] **Step 4: Add 7 keys to `pt-br.ts`**

```typescript
filterCurrentBranch: "Apenas branch atual",
filterMineCommits: "Apenas meus commits",
dateSepToday: "Hoje",
dateSepYesterday: "Ontem",
dateSepThisWeek: "Esta semana",
dateSepThisMonth: "Este mês",
dateSepOlder: "Mais antigo",
```

- [ ] **Step 5: Add 7 keys to `zh-cn.ts`**

```typescript
filterCurrentBranch: "仅当前分支",
filterMineCommits: "仅我的提交",
dateSepToday: "今天",
dateSepYesterday: "昨天",
dateSepThisWeek: "本周",
dateSepThisMonth: "本月",
dateSepOlder: "更早",
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | grep -i "error" | head -20
```

Expected: no errors related to the `log` object.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/
git commit -m "feat(i18n): add keys for GitTree quick filters and date separators"
```

---

### Task 2: `dateBucket.ts` — pure date-bucket utility

**Files:**
- Create: `apps/desktop/src/utils/dateBucket.ts`
- Create: `apps/desktop/src/utils/__tests__/dateBucket.test.ts`

**Interfaces:**
- Produces: `dateBucket(ts: number, now: number): DateBucket` and `type DateBucket` — consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/utils/__tests__/dateBucket.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { dateBucket } from "../dateBucket";

const DAY = 86_400_000;
const now = Date.now();

describe("dateBucket", () => {
  it("returns 'today' for a timestamp less than 24 hours ago", () => {
    expect(dateBucket(now - 1_000, now)).toBe("today");
    expect(dateBucket(now - DAY + 1, now)).toBe("today");
  });

  it("returns 'yesterday' for timestamps between 24 and 48 hours ago", () => {
    expect(dateBucket(now - DAY, now)).toBe("yesterday");
    expect(dateBucket(now - 2 * DAY + 1, now)).toBe("yesterday");
  });

  it("returns 'thisWeek' for timestamps between 2 and 7 days ago", () => {
    expect(dateBucket(now - 2 * DAY, now)).toBe("thisWeek");
    expect(dateBucket(now - 7 * DAY + 1, now)).toBe("thisWeek");
  });

  it("returns 'thisMonth' for timestamps between 7 and 30 days ago", () => {
    expect(dateBucket(now - 7 * DAY, now)).toBe("thisMonth");
    expect(dateBucket(now - 30 * DAY + 1, now)).toBe("thisMonth");
  });

  it("returns 'older' for timestamps more than 30 days ago", () => {
    expect(dateBucket(now - 30 * DAY, now)).toBe("older");
    expect(dateBucket(now - 365 * DAY, now)).toBe("older");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/desktop && pnpm test src/utils/__tests__/dateBucket.test.ts
```

Expected: FAIL — `Cannot find module '../dateBucket'`

- [ ] **Step 3: Create `dateBucket.ts`**

Create `apps/desktop/src/utils/dateBucket.ts`:

```typescript
export type DateBucket = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

const DAY = 86_400_000;

export function dateBucket(ts: number, now: number): DateBucket {
  const diff = now - ts;
  if (diff < DAY) return "today";
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return "thisWeek";
  if (diff < 30 * DAY) return "thisMonth";
  return "older";
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/desktop && pnpm test src/utils/__tests__/dateBucket.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/dateBucket.ts apps/desktop/src/utils/__tests__/dateBucket.test.ts
git commit -m "feat(utils): add dateBucket pure utility for commit timeline grouping"
```

---

### Task 3: `useGitRepo.ts` — branch filter state and function

**Files:**
- Modify: `apps/desktop/src/composables/useGitRepo.ts`

**Interfaces:**
- Consumes: `getGitLog(cwd, count?, all?, author?, offset?, branch?, pathspec?, since?)` from `utils/backend.ts` (already imported).
- Produces: `logBranchFilter: Ref<"all" | "current">` and `setLogBranchFilter(filter: "all" | "current"): Promise<void>` — consumed by Task 4.

- [ ] **Step 1: Add `logBranchFilter` ref**

In `useGitRepo.ts`, find the block containing `logAuthorFilter`:

```typescript
// Author filter: "all" → no filter, "mine" → only commits by the current git user
const logAuthorFilter = ref<"all" | "mine">("all");
```

Add the branch filter ref immediately after it:

```typescript
// Author filter: "all" → no filter, "mine" → only commits by the current git user
const logAuthorFilter = ref<"all" | "mine">("all");
// Branch filter: "all" → --all refs, "current" → HEAD branch only
const logBranchFilter = ref<"all" | "current">("all");
```

- [ ] **Step 2: Modify `loadLog()` to honour `logBranchFilter`**

Find the call to `getGitLog` inside `loadLog()`. It currently reads:

```typescript
const entries = await getGitLog(
  folderPath.value,
  pageSize,
  true, // all refs
  authorEmail,
  0,
  undefined, // branch
  activeScope.value ?? undefined, // pathspec (monorepo scope)
);
```

Replace with:

```typescript
const isCurrentBranchOnly = logBranchFilter.value === "current";
const entries = await getGitLog(
  folderPath.value,
  pageSize,
  !isCurrentBranchOnly,                            // all refs (false when branch-only)
  authorEmail,
  0,
  isCurrentBranchOnly ? (status.value?.branch ?? undefined) : undefined,
  activeScope.value ?? undefined,                   // pathspec (monorepo scope)
);
```

- [ ] **Step 3: Modify `loadMoreLog()` to honour `logBranchFilter`**

Find the call to `getGitLog` inside `loadMoreLog()`. It currently reads:

```typescript
const next = await getGitLog(
  folderPath.value,
  LOG_PAGE,
  true, // all refs
  authorEmail,
  offset,
  undefined, // branch
  activeScope.value ?? undefined, // pathspec (monorepo scope)
);
```

Replace with:

```typescript
const isCurrentBranchOnly = logBranchFilter.value === "current";
const next = await getGitLog(
  folderPath.value,
  LOG_PAGE,
  !isCurrentBranchOnly,
  authorEmail,
  offset,
  isCurrentBranchOnly ? (status.value?.branch ?? undefined) : undefined,
  activeScope.value ?? undefined,
);
```

- [ ] **Step 4: Add `setLogBranchFilter` function**

Find `setLogAuthorFilter`:

```typescript
async function setLogAuthorFilter(filter: "all" | "mine") {
  if (logAuthorFilter.value === filter) return;
  ...
}
```

Add the branch filter function immediately before it:

```typescript
async function setLogBranchFilter(filter: "all" | "current") {
  if (logBranchFilter.value === filter) return;
  logBranchFilter.value = filter;
  await loadLog();
}
```

- [ ] **Step 5: Add to exports**

Find the `return {` block at the bottom of `useGitRepo`. Locate where `logAuthorFilter` and `setLogAuthorFilter` are exported (search for `logAuthorFilter,`) and add the branch counterparts alongside them:

```typescript
logAuthorFilter,
logBranchFilter,        // ← add
// ...
setLogAuthorFilter,
setLogBranchFilter,     // ← add
```

- [ ] **Step 6: Verify compilation**

```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | grep -i "error" | head -20
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/useGitRepo.ts
git commit -m "feat(repo): add logBranchFilter state and setLogBranchFilter to useGitRepo"
```

---

### Task 4: `App.vue` — expose and wire branch filter

**Files:**
- Modify: `apps/desktop/src/App.vue`

**Interfaces:**
- Consumes: `logBranchFilter: Ref<"all" | "current">`, `setLogBranchFilter(filter)` from `useGitRepo` (Task 3).
- Consumes: `logAuthorFilter: Ref<"all" | "mine">`, `setLogAuthorFilter(filter)` from `useGitRepo` (already present).
- Produces: Props `:log-branch-filter` and `:log-author-filter` + emits `@set-log-branch-filter` and `@set-log-author-filter` wired on `<CommitGraph>` — consumed by Task 5.

- [ ] **Step 1: Destructure `logBranchFilter` and `setLogBranchFilter`**

In the destructuring of `useGitRepo()`, find the lines:

```typescript
logAuthorFilter,
// ...
setLogAuthorFilter,
```

Add:

```typescript
logAuthorFilter,
logBranchFilter,        // ← add
// ...
setLogAuthorFilter,
setLogBranchFilter,     // ← add
```

- [ ] **Step 2: Add props and wire emits on `<CommitGraph>`**

Find the `<CommitGraph>` component in the template (around line 2717). It has many `:` props and `@` event handlers. Add the two new props after `:log-has-more` and wire the two new emits:

```html
<CommitGraph v-else class="graph-canvas"
  :commits="repoLog"
  :selected-hash="selectedCommitHash"
  :current-branch="repoStatus?.branch"
  :fork-point-sha="graphForkPointSha"
  :repo-stats="repoStats"
  :branches="branches"
  :worktree-branches="worktreeBranches"
  :stashes="stashes"
  :submodule-changes="submoduleChanges"
  :has-more="logHasMore"
  :loading-more="logLoadingMore"
  :hidden-commit-count="hiddenCommitCount"
  :pinned-branches="graphPinnedBranches"
  :log-branch-filter="logBranchFilter"
  :log-author-filter="logAuthorFilter"
  @set-log-branch-filter="setLogBranchFilter"
  @set-log-author-filter="setLogAuthorFilter"
  @select-commit="onGraphSelectCommit"
  ...rest of existing handlers unchanged...
/>
```

(Keep all existing `@` handlers. Only add the two new ones.)

- [ ] **Step 3: Verify compilation**

```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | grep -i "error" | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat(app): wire logBranchFilter and logAuthorFilter props/emits on CommitGraph"
```

---

### Task 5: `CommitGraph.vue` — filter buttons

**Files:**
- Modify: `apps/desktop/src/components/CommitGraph.vue`

**Interfaces:**
- Consumes: props `logBranchFilter: "all" | "current"` and `logAuthorFilter: "all" | "mine"` from App.vue (Task 4).
- Produces: emits `set-log-branch-filter` and `set-log-author-filter` — consumed by App.vue (Task 4).

- [ ] **Step 1: Add props**

In `CommitGraph.vue`'s `<script setup>`, find the existing `defineProps`. Add the two new props.

Locate the existing props block (search for `defineProps`) and add:

```typescript
const props = defineProps<{
  // ... existing props ...
  logBranchFilter?: "all" | "current"
  logAuthorFilter?: "all" | "mine"
}>()
```

If the props use `withDefaults`, add defaults:

```typescript
const props = withDefaults(defineProps<{
  // ...existing...
  logBranchFilter?: "all" | "current"
  logAuthorFilter?: "all" | "mine"
}>(), {
  // ...existing defaults...
  logBranchFilter: "all",
  logAuthorFilter: "all",
})
```

- [ ] **Step 2: Add emits**

Find `defineEmits`. Add two entries:

```typescript
const emit = defineEmits<{
  // ...existing emits...
  "set-log-branch-filter": [filter: "all" | "current"]
  "set-log-author-filter": [filter: "all" | "mine"]
}>()
```

- [ ] **Step 3: Add two icon buttons to the template**

Find the `.cg-search-bar` div in the template. It starts with:

```html
<div class="cg-search-bar" ref="searchBarEl">
  <!-- Active-scope chip (v2.21.0) — click ✕ to clear -->
  <button v-if="activeScope" ...>
```

Insert the two filter buttons **after the opening `<div class="cg-search-bar">` tag and before the scope chip button**:

```html
<div class="cg-search-bar" ref="searchBarEl">
  <!-- Branch filter toggle -->
  <button
    class="cg-filter-icon-btn"
    :class="{ 'cg-filter-icon-btn--active': props.logBranchFilter === 'current' }"
    :title="t('log.filterCurrentBranch')"
    :aria-label="t('log.filterCurrentBranch')"
    :aria-pressed="props.logBranchFilter === 'current'"
    @click="emit('set-log-branch-filter', props.logBranchFilter === 'current' ? 'all' : 'current')"
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15"/>
      <circle cx="18" cy="6" r="3"/>
      <circle cx="6" cy="18" r="3"/>
      <path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
  </button>
  <!-- Author filter toggle -->
  <button
    class="cg-filter-icon-btn"
    :class="{ 'cg-filter-icon-btn--active': props.logAuthorFilter === 'mine' }"
    :title="t('log.filterMineCommits')"
    :aria-label="t('log.filterMineCommits')"
    :aria-pressed="props.logAuthorFilter === 'mine'"
    @click="emit('set-log-author-filter', props.logAuthorFilter === 'mine' ? 'all' : 'mine')"
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4"/>
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  </button>

  <!-- Active-scope chip (v2.21.0) — click ✕ to clear -->
  <button v-if="activeScope" ...>
```

- [ ] **Step 4: Add CSS for the filter icon buttons**

In the `<style scoped>` section, find the existing `.cg-search-nav` rule and add the new rules after it:

```css
.cg-filter-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.cg-filter-icon-btn:hover {
  color: var(--color-fg);
  background: var(--color-surface-hover);
}

.cg-filter-icon-btn--active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.cg-filter-icon-btn--active:hover {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
```

- [ ] **Step 5: Verify compilation**

```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | grep -i "error" | head -20
```

Expected: no errors.

- [ ] **Step 6: Manual test — filter buttons**

Start the dev server:

```bash
cd apps/desktop && pnpm dev:web
```

Open `http://localhost:1420` and open any git repo. Navigate to "Arbre Git":
- The search bar should show two new icon buttons on the left (branch icon, person icon).
- Clicking the branch icon toggles it to accent color and the graph should reload showing only current-branch commits.
- Clicking the person icon toggles it to accent color and reloads showing only your commits.
- Both can be active simultaneously.
- Clicking an active button deactivates it and reloads all commits.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/CommitGraph.vue
git commit -m "feat(graph): add branch-filter and author-filter quick-toggle buttons to CommitGraph toolbar"
```

---

### Task 6: `CommitGraph.vue` — date separators

**Files:**
- Modify: `apps/desktop/src/components/CommitGraph.vue`

**Interfaces:**
- Consumes: `dateBucket(ts: number, now: number): DateBucket` from `utils/dateBucket.ts` (Task 2).
- Consumes: `displayCommits` — the existing computed list of `GitLogEntry[]` rendered in the graph.
- Consumes: `ROW_H = 32` — the row height constant already defined in CommitGraph.vue.
- Consumes: i18n keys `log.dateSepToday`, `log.dateSepYesterday`, `log.dateSepThisWeek`, `log.dateSepThisMonth`, `log.dateSepOlder` (Task 1).

- [ ] **Step 1: Import `dateBucket`**

At the top of `<script setup>` in `CommitGraph.vue`, add:

```typescript
import { dateBucket, type DateBucket } from "../utils/dateBucket";
```

- [ ] **Step 2: Add `dateSeparators` computed**

After the import, add a helper map and the computed. Place it near the other graph-layout computeds (after the `layout` computed is a good spot):

```typescript
const BUCKET_KEY: Record<DateBucket, string> = {
  today: "log.dateSepToday",
  yesterday: "log.dateSepYesterday",
  thisWeek: "log.dateSepThisWeek",
  thisMonth: "log.dateSepThisMonth",
  older: "log.dateSepOlder",
};

const dateSeparators = computed(() => {
  const now = Date.now();
  const seps: { index: number; label: string }[] = [];
  let lastBucket: DateBucket | "" = "";
  displayCommits.value.forEach((commit, i) => {
    const bucket = dateBucket(new Date(commit.date).getTime(), now);
    if (bucket !== lastBucket) {
      seps.push({ index: i, label: t(BUCKET_KEY[bucket]) });
      lastBucket = bucket;
    }
  });
  return seps;
});
```

- [ ] **Step 3: Render separators in the template**

Find the `.cg-info` div in the template. It contains the `v-for` loop rendering commit rows. After the closing tag of the commit rows loop, add:

```html
<!-- Date separators — overlaid, pointer-events: none, zero layout impact -->
<div
  v-for="sep in dateSeparators"
  :key="'datesep-' + sep.index"
  class="cg-date-sep"
  :style="{ top: sep.index * ROW_H - 1 + 'px' }"
  aria-hidden="true"
>
  <span class="cg-date-sep-label">{{ sep.label }}</span>
</div>
```

- [ ] **Step 4: Add CSS for date separators**

In `<style scoped>`, add after the filter icon button rules (from Task 5):

```css
.cg-date-sep {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  pointer-events: none;
  z-index: 2;
  border-top: 1px solid var(--color-border);
  opacity: 0.35;
}

.cg-date-sep-label {
  position: absolute;
  right: 8px;
  top: -9px;
  font-size: 10px;
  line-height: 1;
  color: var(--color-muted);
  background: var(--color-bg);
  padding: 0 4px;
  white-space: nowrap;
  pointer-events: none;
}
```

- [ ] **Step 5: Verify compilation**

```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | grep -i "error" | head -20
```

Expected: no errors.

- [ ] **Step 6: Run full test suite**

```bash
cd apps/desktop && pnpm test
```

Expected: all tests pass (the dateBucket tests from Task 2 + existing tests).

- [ ] **Step 7: Manual test — date separators**

Open the dev server (`pnpm dev:web`) and navigate to "Arbre Git" on a repo with commits spanning multiple weeks:
- A thin horizontal line with a label ("Aujourd'hui", "Cette semaine", etc.) should appear between commits at each date bucket boundary.
- The label is right-aligned, 10px, muted color.
- The separator does not shift any commit rows — positions are identical to before.
- Scrolling is smooth — separators move with the content.
- Pointer events are none — clicking on a separator selects the commit behind it.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/CommitGraph.vue
git commit -m "feat(graph): add date-bucket separators to CommitGraph timeline"
```

---

## Self-Review

**Spec coverage:**
- ✅ 2 filter buttons (branch + author) in search bar, icon-only, left of input
- ✅ Active state (accent color) for each button
- ✅ Filter state in `useGitRepo.ts` (`logBranchFilter`, `logAuthorFilter`)
- ✅ `loadLog` and `loadMoreLog` honour both filters
- ✅ `dateBucket` pure function with unit tests
- ✅ `dateSeparators` computed from `displayCommits`
- ✅ Overlaid separators — no `dagLayout.ts` changes
- ✅ 7 i18n keys in all 5 locales
- ✅ Detached HEAD edge case: `status.value?.branch ?? undefined` — git log defaults to HEAD

**Type consistency:**
- `dateBucket` returns `DateBucket` ("today"|"yesterday"|"thisWeek"|"thisMonth"|"older")
- `BUCKET_KEY` maps each `DateBucket` to the exact i18n key string
- Prop types match emit payload types (`"all"|"current"`, `"all"|"mine"`)
- `logBranchFilter` in `useGitRepo` exports as `Ref<"all" | "current">`, consumed in App.vue as plain value via template binding ✅
