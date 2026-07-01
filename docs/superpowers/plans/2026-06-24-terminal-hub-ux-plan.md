# Terminal Hub UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Agents" header button with a "Terminal" button that opens a shell tab directly, and turn the `+` in TerminalPanel into a dropdown (Shell / Claude Code / Codex / View sessions).

**Architecture:** Three sequential tasks — i18n first (standalone), then AppHeader rename + App.vue header wiring, then TerminalPanel dropdown + App.vue panel wiring. Each task is independently reviewable and type-checks cleanly before the next starts.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, `useI18n()` composable, vanilla DOM event listeners for dropdown dismissal.

## Global Constraints

- All 5 locale files must be updated in the same commit as the code that uses the new key. Locale files: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts`.
- No new npm dependencies — the dropdown is a vanilla DOM implementation.
- No new Rust commands.
- No `options API` — only `<script setup>` (Composition API).
- Button border-radius: use `--radius-sm`, `--radius-md`, or `--radius-lg` only — never pill/full-round.
- No hardcoded user-visible text — all strings go through `t('...')`.
- Branch: `feat/v3.1.0-terminal-pty` (already exists; commit on this branch).

---

## File Map

| File | Change |
|---|---|
| `apps/desktop/src/locales/en.ts` | Add 6 keys to `terminal` object |
| `apps/desktop/src/locales/fr.ts` | Same 6 keys (French) |
| `apps/desktop/src/locales/es.ts` | Same 6 keys (Spanish) |
| `apps/desktop/src/locales/pt-br.ts` | Same 6 keys (pt-BR) |
| `apps/desktop/src/locales/zh-cn.ts` | Same 6 keys (zh-CN) |
| `apps/desktop/src/components/AppHeader.vue` | Rename Agents button → Terminal button |
| `apps/desktop/src/App.vue` | Wire `@open-terminal` + `@new-agent` + `@open-sessions` |
| `apps/desktop/src/components/TerminalPanel.vue` | `+` → dropdown, new emits |

---

## Task 1: i18n — add terminal hub keys (all 5 locales)

**Files:**
- Modify: `apps/desktop/src/locales/en.ts:2106-2110`
- Modify: `apps/desktop/src/locales/fr.ts:2078-2082`
- Modify: `apps/desktop/src/locales/es.ts:2067-2071`
- Modify: `apps/desktop/src/locales/pt-br.ts:2067-2071`
- Modify: `apps/desktop/src/locales/zh-cn.ts:2052-2056`

**Interfaces:**
- Produces: `terminal.headerLabel`, `terminal.headerTooltip`, `terminal.menuShell`, `terminal.menuClaude`, `terminal.menuCodex`, `terminal.menuSessions` in all 5 locales — used by Tasks 2 and 3.

- [ ] **Step 1: Update `en.ts`** — expand the `terminal` section (currently at line 2106):

```typescript
// Before (lines 2106–2110):
  terminal: {
    newTab: "New tab",
    hide: "Hide terminal",
    closeTab: "Close tab",
  },

// After:
  terminal: {
    newTab: "New tab",
    hide: "Hide terminal",
    closeTab: "Close tab",
    headerLabel: "Terminal",
    headerTooltip: "Open terminal",
    menuShell: "Shell",
    menuClaude: "Claude Code",
    menuCodex: "Codex",
    menuSessions: "View sessions",
  },
```

- [ ] **Step 2: Update `fr.ts`** (currently at line 2078):

```typescript
// Before:
  terminal: {
    newTab: "Nouvel onglet",
    hide: "Masquer le terminal",
    closeTab: "Fermer l'onglet",
  },

// After:
  terminal: {
    newTab: "Nouvel onglet",
    hide: "Masquer le terminal",
    closeTab: "Fermer l'onglet",
    headerLabel: "Terminal",
    headerTooltip: "Ouvrir le terminal",
    menuShell: "Shell",
    menuClaude: "Claude Code",
    menuCodex: "Codex",
    menuSessions: "Voir les sessions",
  },
```

- [ ] **Step 3: Update `es.ts`** (currently at line 2067):

```typescript
// Before:
  terminal: {
    newTab: "Nueva pestaña",
    hide: "Ocultar terminal",
    closeTab: "Cerrar pestaña",
  },

// After:
  terminal: {
    newTab: "Nueva pestaña",
    hide: "Ocultar terminal",
    closeTab: "Cerrar pestaña",
    headerLabel: "Terminal",
    headerTooltip: "Abrir terminal",
    menuShell: "Shell",
    menuClaude: "Claude Code",
    menuCodex: "Codex",
    menuSessions: "Ver sesiones",
  },
```

- [ ] **Step 4: Update `pt-br.ts`** (currently at line 2067):

```typescript
// Before:
  terminal: {
    newTab: "Nova aba",
    hide: "Ocultar terminal",
    closeTab: "Fechar aba",
  },

// After:
  terminal: {
    newTab: "Nova aba",
    hide: "Ocultar terminal",
    closeTab: "Fechar aba",
    headerLabel: "Terminal",
    headerTooltip: "Abrir terminal",
    menuShell: "Shell",
    menuClaude: "Claude Code",
    menuCodex: "Codex",
    menuSessions: "Ver sessões",
  },
```

- [ ] **Step 5: Update `zh-cn.ts`** (currently at line 2052):

```typescript
// Before:
  terminal: {
    newTab: "新标签页",
    hide: "隐藏终端",
    closeTab: "关闭标签页",
  },

// After:
  terminal: {
    newTab: "新标签页",
    hide: "隐藏终端",
    closeTab: "关闭标签页",
    headerLabel: "终端",
    headerTooltip: "打开终端",
    menuShell: "Shell",
    menuClaude: "Claude Code",
    menuCodex: "Codex",
    menuSessions: "查看会话",
  },
```

- [ ] **Step 6: Verify type-check passes**

```bash
cd apps/desktop && pnpm build
```

Expected: build completes with no TypeScript errors. The `Locale` type is derived from `typeof en`, so any key present in `en.ts` but missing in another locale causes a TS error.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts \
        apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-br.ts \
        apps/desktop/src/locales/zh-cn.ts
git commit -m "i18n: add terminal hub keys (headerLabel/Tooltip, menu items) in all 5 locales"
```

---

## Task 2: AppHeader — rename to Terminal button + App.vue header wiring

**Files:**
- Modify: `apps/desktop/src/components/AppHeader.vue:147` (emits block)
- Modify: `apps/desktop/src/components/AppHeader.vue:333-351` (button template block)
- Modify: `apps/desktop/src/App.vue:2496` (AppHeader usage — one attribute change)

**Interfaces:**
- Consumes: `terminal.headerLabel`, `terminal.headerTooltip` from Task 1
- Produces: `openTerminal: []` event on AppHeader; App.vue calls `openTerminalTab()` on this event

No unit tests: this is a pure template/event-wiring change. Verification is via type-check + visual check in dev server.

- [ ] **Step 1: Update emits in `AppHeader.vue`** — replace `openAgents` with `openTerminal` in the defineEmits block at line 147:

```typescript
// Before (line 147):
  openAgents: [];

// After:
  openTerminal: [];
```

- [ ] **Step 2: Replace the Agents button in `AppHeader.vue`** — the entire template block from line 333 to 351:

```html
<!-- Before (lines 333–351): -->
      <template v-if="hasRepo">
        <button
          class="btn btn--secondary header-feature-btn"
          v-tooltip="t('agents.sidebarTooltip')"
          :aria-label="t('agents.title')"
          @click="emit('openAgents')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M12 2v4M8 11V9a4 4 0 0 1 8 0v2"/>
            <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none"/>
            <path d="M9 20h6"/>
          </svg>
          <span>{{ t('agents.headerLabel') }}</span>
        </button>

        <div class="header-separator" aria-hidden="true"></div>
      </template>

<!-- After: -->
      <template v-if="hasRepo">
        <button
          class="btn btn--secondary header-feature-btn"
          v-tooltip="t('terminal.headerTooltip')"
          :aria-label="t('terminal.headerLabel')"
          @click="emit('openTerminal')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          <span>{{ t('terminal.headerLabel') }}</span>
        </button>

        <div class="header-separator" aria-hidden="true"></div>
      </template>
```

- [ ] **Step 3: Update AppHeader binding in `App.vue`** — at line 2496, change the attribute:

```html
<!-- Before (line 2496): -->
      @open-agents="showAgents = true" />

<!-- After: -->
      @open-terminal="openTerminalTab()" />
```

`openTerminalTab()` (defined at line 1257) opens a shell PTY tab and sets `showTerminal = true`. No argument needed — it uses `repoFolderPath.value` internally.

- [ ] **Step 4: Verify type-check passes**

```bash
cd apps/desktop && pnpm build
```

Expected: build completes with no errors. The `openAgents` event reference is gone from both emitter and consumer.

- [ ] **Step 5: Visual verification** (optional if time allows)

```bash
cd apps/desktop && pnpm dev:web
```

Open the dev server, load a repo. The header should show a `>_` Terminal button. Clicking it should open a shell PTY tab (or a new one if one already exists).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/AppHeader.vue apps/desktop/src/App.vue
git commit -m "feat(ux): rename Agents→Terminal in header, open PTY tab directly on click"
```

---

## Task 3: TerminalPanel — "+" dropdown + App.vue panel wiring

**Files:**
- Modify: `apps/desktop/src/components/TerminalPanel.vue:8` (defineEmits)
- Modify: `apps/desktop/src/components/TerminalPanel.vue:~169` (onBeforeUnmount — add listener cleanup)
- Modify: `apps/desktop/src/components/TerminalPanel.vue:~1–170` (script: add dropdown state + handlers)
- Modify: `apps/desktop/src/components/TerminalPanel.vue:208` (template: `+` button → dropdown)
- Modify: `apps/desktop/src/components/TerminalPanel.vue:225+` (CSS: `.tp__new-wrap`, `.tp__menu`, `.tp__menu-item`)
- Modify: `apps/desktop/src/App.vue:2726–2732` (TerminalPanel binding: add `@new-agent` and `@open-sessions`)

**Interfaces:**
- Consumes: `terminal.menuShell`, `terminal.menuClaude`, `terminal.menuCodex`, `terminal.menuSessions` from Task 1
- Consumes: `onLaunchAgent(payload: { path: string; tool: string })` from App.vue (line 1277) — unchanged function, wired to new `@new-agent` event
- Produces: `(e: "new-agent", tool: string): void` and `(e: "open-sessions"): void` emits

No new unit tests: pure template change. Verification via type-check + visual check in dev server.

- [ ] **Step 1: Expand `defineEmits` in `TerminalPanel.vue`** (line 8):

```typescript
// Before:
const emit = defineEmits<{ (e: "close"): void; (e: "new"): void }>();

// After:
const emit = defineEmits<{
  (e: "close"): void;
  (e: "new"): void;
  (e: "new-agent", tool: string): void;
  (e: "open-sessions"): void;
}>();
```

- [ ] **Step 2: Add dropdown state and handlers in `TerminalPanel.vue` script** — insert after the existing `const sessions = ...` and `const tabs = ...` lines (around line 12):

```typescript
// ─── "+" dropdown ────────────────────────────────────────
const showDropdown = ref(false);

function onDocumentClickClose() {
  showDropdown.value = false;
}

function openDropdown(e: MouseEvent) {
  e.stopPropagation();
  if (showDropdown.value) {
    showDropdown.value = false;
    document.removeEventListener("click", onDocumentClickClose);
  } else {
    showDropdown.value = true;
    document.addEventListener("click", onDocumentClickClose);
  }
}

function selectDropdownItem(action: () => void) {
  showDropdown.value = false;
  document.removeEventListener("click", onDocumentClickClose);
  action();
}
```

- [ ] **Step 3: Clean up listener in `onBeforeUnmount`** — at the end of the `onBeforeUnmount` block (around line 167, before the closing `}`):

```typescript
// Add this line at the end of the onBeforeUnmount callback, before the closing }):
  document.removeEventListener("click", onDocumentClickClose);
```

The full `onBeforeUnmount` after the change looks like:

```typescript
onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
  for (const entry of xterms.values()) {
    entry.ro.disconnect();
    entry.term.dispose();
  }
  xterms.clear();
  document.removeEventListener("click", onDocumentClickClose);
});
```

- [ ] **Step 4: Replace the `+` button in the template** (line 208):

```html
<!-- Before (line 208): -->
      <button class="tp__new" :title="t('terminal.newTab')" @click="emit('new')">+</button>

<!-- After: -->
      <div class="tp__new-wrap">
        <button class="tp__new" :title="t('terminal.newTab')" @click="openDropdown">+</button>
        <div v-if="showDropdown" class="tp__menu" @click.stop>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('new'))">
            {{ t('terminal.menuShell') }}
          </button>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('new-agent', 'claude'))">
            {{ t('terminal.menuClaude') }}
          </button>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('new-agent', 'codex'))">
            {{ t('terminal.menuCodex') }}
          </button>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('open-sessions'))">
            {{ t('terminal.menuSessions') }}
          </button>
        </div>
      </div>
```

- [ ] **Step 5: Add CSS for the dropdown** — in the `<style scoped>` block, after existing `.tp__new` rules (or at the end of the style section):

```css
.tp__new-wrap {
  position: relative;
}

.tp__menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--bg-elevated, var(--color-bg-secondary));
  border: 1px solid var(--border, var(--color-border));
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  min-width: 140px;
  padding: 2px 0;
}

.tp__menu-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text, var(--color-text));
  white-space: nowrap;
}

.tp__menu-item:hover {
  background: var(--hover, var(--color-hover));
}
```

- [ ] **Step 6: Update the TerminalPanel binding in `App.vue`** (lines 2726–2732):

```html
<!-- Before: -->
      <TerminalPanel
        v-if="showTerminal && repoFolderPath"
        ref="terminalPanelRef"
        :repo-path="repoFolderPath"
        @close="showTerminal = false"
        @new="openTerminalTab()"
      />

<!-- After: -->
      <TerminalPanel
        v-if="showTerminal && repoFolderPath"
        ref="terminalPanelRef"
        :repo-path="repoFolderPath"
        @close="showTerminal = false"
        @new="openTerminalTab()"
        @new-agent="(tool: string) => repoFolderPath && onLaunchAgent({ path: repoFolderPath, tool })"
        @open-sessions="showAgents = true"
      />
```

Note: `repoFolderPath` in the template is the auto-unwrapped value of `ref<string | undefined>`. The `v-if="showTerminal && repoFolderPath"` guard ensures it's truthy here, but TypeScript in templates can't always infer that — the `repoFolderPath &&` guard makes it explicit.

- [ ] **Step 7: Verify type-check passes**

```bash
cd apps/desktop && pnpm build
```

Expected: no TypeScript errors. The new emit signatures must match usage at the call site.

- [ ] **Step 8: Visual verification** (optional but recommended)

```bash
cd apps/desktop && pnpm dev:web
```

1. Load a repo → click "Terminal" button → shell tab opens immediately (not an empty panel)
2. In the terminal panel, click `+` → dropdown appears with 4 items
3. Click "Shell" → new shell tab opens; dropdown closes
4. Click `+` → click "Claude Code" → new tab opens, `claude` is typed into it
5. Click `+` → click "Codex" → new tab opens, `codex` is typed into it
6. Click `+` → click "View sessions" → AgentSessionsPanel opens
7. Click anywhere outside the dropdown → dropdown closes

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/components/TerminalPanel.vue apps/desktop/src/App.vue
git commit -m "feat(ux): + dropdown in TerminalPanel (Shell/Claude/Codex/Sessions) + App.vue wiring"
```

---

## Self-review

**Spec coverage:**
- ✅ Header button renamed Agents → Terminal (`terminal.headerLabel`, terminal icon, `openTerminal` event)
- ✅ Clicking header button opens a shell tab directly (`openTerminalTab()`)
- ✅ `+` dropdown with Shell, Claude Code, Codex, View sessions
- ✅ `@new-agent` wired to `onLaunchAgent` in App.vue
- ✅ `@open-sessions` wired to `showAgents = true`
- ✅ AgentSessionsPanel unchanged (still accessible via "View sessions")
- ✅ All 5 locales updated

**No placeholders:** All steps contain exact code, exact file paths with line numbers, exact commands.

**Type consistency:**
- `openTerminal` defined in AppHeader emits → consumed in App.vue as `@open-terminal`
- `new-agent` emitted as `(e: "new-agent", tool: string)` → consumed as `(tool: string) => ...`
- `open-sessions` emitted as `(e: "open-sessions")` → consumed as `showAgents = true`
- `onLaunchAgent` signature at line 1277: `(payload: { path: string; tool: string })` — matches usage
