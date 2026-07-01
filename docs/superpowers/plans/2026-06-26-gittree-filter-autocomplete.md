# GitTree Filter Mode + Branch Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two features to the CommitGraph search bar: (1) a dropdown autocomplete on branch names, and (2) a Filter button that when active recalculates the DAG showing only matching commits.

**Architecture:** Both features live entirely in `CommitGraph.vue`. Filter mode introduces a `renderedCommits` computed that sits between the existing `displayCommits` (which adds the WIP node) and the DAG layout — when filter mode is off, `renderedCommits === displayCommits`; when on, it is `filterCommitsLocal(displayCommits, query)`. All downstream computed values (`layout`, `totalHeight`, `visibleRange`, `visibleCommits`, `matchedIndices`, `matchedHashSet`, `activeMatchHash`) are updated to reference `renderedCommits`. Branch autocomplete adds `branchSuggestions`, `showSuggestions`, `activeSuggestionIdx` state plus an absolute-positioned dropdown anchored to the search bar.

**Tech Stack:** Vue 3 `<script setup>`, `computed`/`ref`/`watch`, existing `filterCommitsLocal` from `useCommitSearch.ts`, existing `GitBranch` type, existing i18n via `useI18n`.

## Global Constraints

- Composition API (`<script setup>`) only — no Options API
- No new npm dependencies
- Every user-visible string must have a key in all 5 locale files: `en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts`
- No hardcoded UI text in templates
- Buttons use square-rounded radius (`--radius-sm` or `--radius-md`), never pill/9999px
- `filterCommitsLocal` is already exported from `composables/useCommitSearch.ts` — import from there, do not re-implement

---

## Task 1: Add i18n keys for filter button

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/fr.ts`
- Modify: `apps/desktop/src/locales/es.ts`
- Modify: `apps/desktop/src/locales/pt-br.ts`
- Modify: `apps/desktop/src/locales/zh-cn.ts`

**Interfaces:**
- Produces: `t('log.graphSearchFilter')` and `t('log.graphSearchFilterTitle')` — used in Task 2 template

In all five files, inside the `log: { ... }` block, append after `graphSearchClear`:

- [ ] **Step 1: Add keys to `en.ts`**

The `log:` block currently ends (around line 418) with:
```typescript
    graphSearchClear: "Clear search",
```
Add after it:
```typescript
    graphSearchFilter: "Filter",
    graphSearchFilterTitle: "Show only matching commits",
```

- [ ] **Step 2: Add keys to `fr.ts`**

```typescript
    graphSearchFilter: "Filtrer",
    graphSearchFilterTitle: "Afficher uniquement les commits correspondants",
```

- [ ] **Step 3: Add keys to `es.ts`**

```typescript
    graphSearchFilter: "Filtrar",
    graphSearchFilterTitle: "Mostrar solo los commits coincidentes",
```

- [ ] **Step 4: Add keys to `pt-br.ts`**

```typescript
    graphSearchFilter: "Filtrar",
    graphSearchFilterTitle: "Mostrar apenas os commits correspondentes",
```

- [ ] **Step 5: Add keys to `zh-cn.ts`**

```typescript
    graphSearchFilter: "筛选",
    graphSearchFilterTitle: "仅显示匹配的提交",
```

- [ ] **Step 6: Verify TypeScript compiles**

Run from `apps/desktop/`:
```bash
npx vue-tsc --noEmit --skipLibCheck 2>&1 | grep -E "locales|error" | head -20
```
Expected: no output (no errors).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/
git commit -m "feat(desktop): i18n keys for GitTree filter button"
```

---

## Task 2: Filter mode — state, computed, button

**Files:**
- Modify: `apps/desktop/src/components/CommitGraph.vue`

**Interfaces:**
- Consumes: `filterCommitsLocal` (already imported), `searchQuery` ref, `displayCommits` computed, `t('log.graphSearchFilter')`, `t('log.graphSearchFilterTitle')`
- Produces: `filterMode` ref (boolean), `renderedCommits` computed (`GitLogEntry[]`), `toggleFilterMode()` function

### Script changes

- [ ] **Step 1: Add `filterMode` ref and `renderedCommits` computed**

After the existing line:
```typescript
const currentMatchIdx = ref(-1);
```
Insert:
```typescript
const filterMode = ref(false);

const renderedCommits = computed(() => {
  if (!filterMode.value || !searchQuery.value.trim()) return displayCommits.value;
  return filterCommitsLocal(displayCommits.value, searchQuery.value);
});
```

- [ ] **Step 2: Update `matchedIndices` to use `renderedCommits`**

Replace the existing `matchedIndices` computed:
```typescript
const matchedIndices = computed<number[]>(() => {
  const q = searchQuery.value.trim();
  if (!q) return [];
  const matched = filterCommitsLocal(renderedCommits.value, q);
  const matchSet = new Set(matched.map((e) => e.hashFull));
  const indices: number[] = [];
  renderedCommits.value.forEach((e, i) => { if (matchSet.has(e.hashFull)) indices.push(i); });
  return indices;
});
```

- [ ] **Step 3: Update `matchedHashSet` and `activeMatchHash` to use `renderedCommits`**

Replace:
```typescript
const matchedHashSet = computed<Set<string>>(() => {
  return new Set(matchedIndices.value.map((i) => renderedCommits.value[i]?.hashFull ?? ""));
});

const activeMatchHash = computed<string | null>(() => {
  const idx = matchedIndices.value[currentMatchIdx.value];
  return idx !== undefined ? (renderedCommits.value[idx]?.hashFull ?? null) : null;
});
```

- [ ] **Step 4: Update `layout` computed to use `renderedCommits`**

The `layout` computed (around line 505) starts with:
```typescript
const layout = computed<DagLayout>(() => {
  const commits = displayCommits.value;
```
Change to:
```typescript
const layout = computed<DagLayout>(() => {
  const commits = renderedCommits.value;
```
(Only this first line changes; everything else in the computed stays the same.)

- [ ] **Step 5: Update `totalHeight` to use `renderedCommits`**

Replace:
```typescript
const totalHeight = computed(() => displayCommits.value.length * ROW_H);
```
With:
```typescript
const totalHeight = computed(() => renderedCommits.value.length * ROW_H);
```

- [ ] **Step 6: Update `visibleRange` to use `renderedCommits` length**

Inside `visibleRange` computed (the line `const total = displayCommits.value.length;`):
```typescript
const visibleRange = computed(() => {
  const total = renderedCommits.value.length;   // was displayCommits.value.length
  // ... rest unchanged
```

- [ ] **Step 7: Update `visibleCommits` to use `renderedCommits`**

Replace:
```typescript
const visibleCommits = computed<VisibleCommit[]>(() => {
  const { first, last } = visibleRange.value;
  const out: VisibleCommit[] = [];
  const commits = renderedCommits.value;
  for (let i = first; i <= last; i++) {
    const entry = commits[i];
    if (entry) out.push({ entry, index: i });
  }
  return out;
});
```

- [ ] **Step 8: Auto-clear `filterMode` when search is emptied**

The existing `watch(searchQuery, ...)` (around line 577) reads:
```typescript
watch(searchQuery, (q) => {
  if (!q.trim()) currentMatchIdx.value = -1;
});
```
Expand it to also clear `filterMode`:
```typescript
watch(searchQuery, (q) => {
  if (!q.trim()) {
    currentMatchIdx.value = -1;
    filterMode.value = false;
  }
});
```

- [ ] **Step 9: Add `toggleFilterMode` function**

After the existing `navigateSearch` function:
```typescript
function toggleFilterMode() {
  if (!searchQuery.value.trim()) return;
  filterMode.value = !filterMode.value;
  if (filterMode.value) {
    if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
    currentMatchIdx.value = -1;
  }
}
```

### Template changes

- [ ] **Step 10: Add Filter button to the search bar template**

The search bar template currently ends with the clear button (the `v-if="searchQuery"` `cg-search-nav` button). Add the filter button **before** the clear button:

```html
<!-- Filter mode toggle (turns purple when active) -->
<button
  class="cg-search-nav cg-filter-btn"
  :class="{ 'cg-filter-btn--active': filterMode }"
  :disabled="!searchQuery.trim()"
  :title="t('log.graphSearchFilterTitle')"
  :aria-label="t('log.graphSearchFilter')"
  @click="toggleFilterMode"
>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
</button>
```

### CSS changes

- [ ] **Step 11: Add CSS for the filter button active state**

After the `.cg-search-nav:disabled` rule:
```css
.cg-filter-btn--active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.cg-filter-btn--active:hover:not(:disabled) {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
  color: var(--color-accent);
}
```

- [ ] **Step 12: Verify TypeScript and run tests**

```bash
cd apps/desktop && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -20
```
Expected: no errors.

```bash
cd apps/desktop && pnpm test 2>&1 | tail -20
```
Expected: tests pass.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/components/CommitGraph.vue
git commit -m "feat(desktop): GitTree filter mode — recalculates DAG on matching commits only"
```

---

## Task 3: Branch autocomplete dropdown

**Files:**
- Modify: `apps/desktop/src/components/CommitGraph.vue`

**Interfaces:**
- Consumes: `searchQuery` ref, `props.branches` (`GitBranch[]`), `showSuggestions` ref, `branchSuggestions` computed, `filterCommitsLocal`
- Produces: branch name fills `searchQuery` on selection

### Script changes

- [ ] **Step 1: Add autocomplete state**

After the `filterMode` ref added in Task 2:
```typescript
const showSuggestions = ref(false);
const activeSuggestionIdx = ref(-1);

const branchSuggestions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q || !props.branches?.length) return [];
  return props.branches
    .filter((b) => b.name.toLowerCase().includes(q))
    .slice(0, 8);
});

watch(branchSuggestions, () => {
  activeSuggestionIdx.value = -1;
});

function selectSuggestion(name: string) {
  searchQuery.value = name;
  showSuggestions.value = false;
  activeSuggestionIdx.value = -1;
}
```

- [ ] **Step 2: Replace input keydown handlers with unified handler**

Replace the existing `@keydown.enter` / `@keydown.escape` on the `<input>` with a single `@keydown="onSearchKeydown"` (template change in Step 4). Add this function after `selectSuggestion`:

```typescript
function onSearchKeydown(e: KeyboardEvent) {
  if (showSuggestions.value && branchSuggestions.value.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestionIdx.value = Math.min(
        activeSuggestionIdx.value + 1,
        branchSuggestions.value.length - 1,
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestionIdx.value = Math.max(activeSuggestionIdx.value - 1, -1);
      return;
    }
    if (e.key === "Enter" && activeSuggestionIdx.value >= 0) {
      e.preventDefault();
      selectSuggestion(branchSuggestions.value[activeSuggestionIdx.value].name);
      return;
    }
    if (e.key === "Escape") {
      showSuggestions.value = false;
      return;
    }
  }
  if (e.key === "Enter") navigateSearch(1);
  if (e.key === "Escape") searchQuery.value = "";
}
```

### Template changes

- [ ] **Step 3: Add `position: relative` wrapper to the search bar**

The `.cg-search-bar` div already exists. The CSS update (Step 5) adds `position: relative`. No template change needed — the dropdown will be a direct child of `.cg-search-bar`.

- [ ] **Step 4: Update the `<input>` element**

The existing input is:
```html
<input
  v-model="searchQuery"
  class="cg-search-input"
  type="search"
  :placeholder="t('log.graphSearchPlaceholder')"
  @keydown.enter="navigateSearch(1)"
  @keydown.escape="searchQuery = ''"
/>
```

Replace with:
```html
<input
  v-model="searchQuery"
  class="cg-search-input"
  type="search"
  :placeholder="t('log.graphSearchPlaceholder')"
  @keydown="onSearchKeydown"
  @focus="showSuggestions = true"
  @blur="showSuggestions = false"
/>
```

- [ ] **Step 5: Add dropdown template**

Immediately after the closing `/>` of the input (still inside `.cg-search-bar`):

```html
<!-- Branch autocomplete dropdown -->
<div
  v-if="showSuggestions && branchSuggestions.length > 0"
  class="cg-branch-dropdown"
>
  <button
    v-for="(branch, idx) in branchSuggestions"
    :key="branch.name"
    class="cg-branch-item"
    :class="{ 'cg-branch-item--active': activeSuggestionIdx === idx }"
    @mousedown.prevent="selectSuggestion(branch.name)"
  >
    <svg
      class="cg-branch-item-icon"
      :class="branch.isRemote ? 'cg-branch-remote' : 'cg-branch-local'"
      width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    >
      <line x1="6" y1="3" x2="6" y2="15"/>
      <circle cx="18" cy="6" r="3"/>
      <circle cx="6" cy="18" r="3"/>
      <path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
    <span class="cg-branch-item-name">{{ branch.name }}</span>
    <span v-if="branch.isRemote" class="cg-branch-item-remote-tag">remote</span>
  </button>
</div>
```

### CSS changes

- [ ] **Step 6: Add `position: relative` to `.cg-search-bar`**

In the existing `.cg-search-bar` rule, add `position: relative;`:
```css
.cg-search-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
```

- [ ] **Step 7: Add dropdown CSS**

After the `.cg-search-nav:disabled` rule block:
```css
.cg-branch-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.cg-branch-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  font-size: 11px;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--color-text);
  cursor: pointer;
}

.cg-branch-item:hover,
.cg-branch-item--active {
  background: var(--color-bg-tertiary);
}

.cg-branch-item-icon {
  flex-shrink: 0;
}

.cg-branch-local {
  color: var(--color-accent);
}

.cg-branch-remote {
  color: var(--color-text-muted);
}

.cg-branch-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cg-branch-item-remote-tag {
  font-size: 9px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 3px;
  padding: 1px 4px;
  flex-shrink: 0;
}
```

- [ ] **Step 8: Verify TypeScript**

```bash
cd apps/desktop && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 9: Run tests**

```bash
cd apps/desktop && pnpm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/components/CommitGraph.vue
git commit -m "feat(desktop): branch name autocomplete dropdown in GitTree search"
```
