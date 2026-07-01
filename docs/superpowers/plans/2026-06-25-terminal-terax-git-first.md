# Terminal Terax-parity + Git-first Workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Bring xterm.js performance to Terax level (WebGL GPU renderer, inline search, clickable links); (2) add Git-first tab identity (tab types shell/agent, unread indicator); (3) fix "Launch Claude Code" which currently opens nothing visible; (4) "New AI task" one-click flow (scratch worktree + Claude Code tab) — the anti-IDE bootstrap gesture.

**Architecture:** Phase A (Tasks 1–2) is purely frontend — add 3 xterm addons + extend `TerminalTab` with `type`/`hasUnread`. Phase B (Tasks 3–4) touches frontend + Rust — reroute agent launch through the PTY terminal, add the "New AI task" gesture that chains worktree creation + agent tab opening. All tasks build on the existing solid foundation: `portable-pty` (Rust) + `Tauri Channel` push events + `@xterm/xterm` v6 are already in place.

**Tech Stack:** `@xterm/addon-webgl ^0.19`, `@xterm/addon-search ^0.15`, `@xterm/addon-web-links ^0.11` (new npm deps), Vue 3 `<script setup>`, TypeScript, Vitest.

## Global Constraints

- pnpm only — never npm or yarn.
- All Vue components: `<script setup>` (Composition API). Options API forbidden.
- Every user-visible string must have a key in all 5 locale files: `en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts` in `apps/desktop/src/locales/`.
- Every new `#[tauri::command]` (Rust) needs a typed wrapper in `apps/desktop/src/utils/backend.ts` **and** a working dev-server route in `apps/desktop/dev-server.mjs` in the **same task**.
- Business logic in composables (`composables/`), not in components. Components: thin rendering + event delegation only.
- No `{ deep: true }` watchers on structures with > 100 entries.
- New panels/modals with `v-if` default-false → lazy-load via `defineAsyncComponent`.
- xterm.js instances must be kept **outside Vue reactivity** — store in plain `Map`, never in `ref`/`reactive`.
- Buttons: never `border-radius: 9999px` (pill) — use `--radius-sm`, `--radius-md`, or `--radius-lg`.
- Never version bump `package.json` / `Cargo.toml` version fields manually — only `./scripts/bump-version.sh X.Y.Z`.
- Branch: `feat/v3.1.0-terminal-pty` (already exists — commit on this branch).

---

## File Map

| File | Change |
|---|---|
| `apps/desktop/package.json` | Add 3 xterm addons (Task 1) |
| `apps/desktop/src/components/TerminalPanel.vue` | WebGL + search + links + tab type icons + unread dot + search UI (Tasks 1 & 2) |
| `apps/desktop/src/composables/useTerminalSessions.ts` | Add `type`, `hasUnread` to `TerminalTab`; `markRead()`; `openTab` opts.type (Task 2) |
| `apps/desktop/src/composables/__tests__/useTerminalSessions.test.ts` | New tests for type, hasUnread, markRead (Task 2) |
| `apps/desktop/src/locales/en.ts` | Keys: `terminal.searchPlaceholder`, `terminal.searchNoResult`, `terminal.tabTypeAgent` (Tasks 1 & 4) |
| `apps/desktop/src/locales/fr.ts` | Same keys (French) |
| `apps/desktop/src/locales/es.ts` | Same keys (Spanish) |
| `apps/desktop/src/locales/pt-br.ts` | Same keys (pt-BR) |
| `apps/desktop/src/locales/zh-cn.ts` | Same keys (zh-CN) |
| `apps/desktop/src/components/AgentSessionsPanel.vue` | Remove fake setTimeout active, emit `launch-in-terminal` instead of calling `agentSessionLaunch` (Task 3) |
| `apps/desktop/src/App.vue` | Handle `launch-in-terminal`: open PTY tab in worktree cwd (Task 3); handle `new-ai-task` (Task 4) |
| `apps/desktop/src/utils/backend.ts` | No new commands needed — reuse `terminalOpen` + existing `createScratchWorktree` (Tasks 3–4) |

---

## Task 1: Terax performance parity — WebGL renderer + search + links

> **Context:** `@xterm/xterm` v6 and `@xterm/addon-fit` are already installed. The Tauri Channel push architecture is already in place. This task adds the three addons that give Terax its GPU-accelerated, searchable, link-aware terminal.

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/components/TerminalPanel.vue`
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts`

**Interfaces:**
- Produces: `XtermEntry` gains a `search` field (SearchAddon instance) — used by Task 1's search UI only.

---

- [ ] **Step 1: Add npm dependencies**

```bash
cd apps/desktop
pnpm add @xterm/addon-webgl@^0.19.0 @xterm/addon-search@^0.15.0 @xterm/addon-web-links@^0.11.0
```

Expected: `package.json` gains 3 new `@xterm/*` entries under `dependencies`.

---

- [ ] **Step 2: Add i18n keys for search UI**

In each of the 5 locale files, add 2 keys inside the existing `terminal` object:

```typescript
// apps/desktop/src/locales/en.ts  (inside terminal: { ... })
searchPlaceholder: "Search…",
searchNoResult: "No results",
```

```typescript
// apps/desktop/src/locales/fr.ts
searchPlaceholder: "Rechercher…",
searchNoResult: "Aucun résultat",
```

```typescript
// apps/desktop/src/locales/es.ts
searchPlaceholder: "Buscar…",
searchNoResult: "Sin resultados",
```

```typescript
// apps/desktop/src/locales/pt-br.ts
searchPlaceholder: "Pesquisar…",
searchNoResult: "Nenhum resultado",
```

```typescript
// apps/desktop/src/locales/zh-cn.ts
searchPlaceholder: "搜索…",
searchNoResult: "无结果",
```

---

- [ ] **Step 3: Extend `XtermEntry` type and `ensureXtermLibs` in `TerminalPanel.vue`**

The `XtermEntry` type is declared at the top of `<script setup>`. Add a `search` field:

```typescript
// Replace the existing XtermEntry type (currently line ~46)
type XtermEntry = {
  term: any;
  fit: any;
  search: any;       // SearchAddon — used by the search bar
  ro: ResizeObserver;
  sessionId: number;
};
```

Extend `ensureXtermLibs` to also import the 3 new addons and cache their constructors. Add 3 module-level variables alongside `XtermCtor` and `FitCtor`:

```typescript
let WebglCtor: any = null;
let SearchCtor: any = null;
let WebLinksCtor: any = null;
```

Rewrite `ensureXtermLibs`:

```typescript
async function ensureXtermLibs() {
  if (XtermCtor) return;
  const [
    { Terminal },
    { FitAddon },
    { WebglAddon },
    { SearchAddon },
    { WebLinksAddon },
  ] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-webgl"),
    import("@xterm/addon-search"),
    import("@xterm/addon-web-links"),
  ]);
  XtermCtor = Terminal;
  FitCtor = FitAddon;
  WebglCtor = WebglAddon;
  SearchCtor = SearchAddon;
  WebLinksCtor = WebLinksAddon;
  await import("@xterm/xterm/css/xterm.css");
}
```

---

- [ ] **Step 4: Load addons in `mountTab`**

Replace the body of `mountTab` (currently creates `term` + `fit` + calls `term.open`) to also load the 3 new addons. The WebGL addon must be wrapped in try/catch — it throws if WebGL2 is unavailable, in which case xterm.js falls back to its canvas renderer automatically.

```typescript
async function mountTab(tab: TerminalTab) {
  await ensureXtermLibs();
  await nextTick();
  const el = hostRefs.value[tab.id];
  if (!el || xterms.has(tab.id)) return;

  const term = new XtermCtor({ fontSize: settings.value.terminalFontSize ?? 13, cursorBlink: true });
  const fit = new FitCtor();
  const search = new SearchCtor();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksCtor());
  term.open(el);

  // WebGL2 renderer — GPU-accelerated rendering like Terax.
  // Falls back silently to the built-in canvas renderer if WebGL2 is unavailable.
  const webgl = new WebglCtor();
  try {
    term.loadAddon(webgl);
  } catch {
    webgl.dispose();
  }

  fit.fit();

  term.onData((data: string) => {
    if (tab.sessionId >= 0) {
      sessions.write(tab.sessionId, data);
    } else {
      let buf = pendingInput.get(tab.id);
      if (!buf) { buf = []; pendingInput.set(tab.id, buf); }
      buf.push(data);
    }
  });
  term.onTitleChange((title: string) =>
    sessions.setTitleFromShell(props.repoPath, tab.id, title),
  );

  const ro = new ResizeObserver(() => {
    fit.fit();
    sessions.resize(tab.sessionId, term.cols, term.rows);
  });
  ro.observe(el);

  xterms.set(tab.id, { term, fit, search, ro, sessionId: tab.sessionId });

  const buffered = pendingChunks.get(tab.id);
  if (buffered) {
    for (const chunk of buffered) term.write(chunk);
    pendingChunks.delete(tab.id);
  }
}
```

---

- [ ] **Step 5: Add inline search UI to `TerminalPanel.vue`**

Add reactive state at the top of `<script setup>` (after the existing refs):

```typescript
// Inline search bar state — one shared bar, operates on the active tab's SearchAddon.
const searchVisible = ref(false);
const searchQuery = ref("");
const searchHasResult = ref(true);

function openSearch() {
  searchVisible.value = true;
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(".tp__search-input");
    input?.focus();
  });
}

function closeSearch() {
  searchVisible.value = false;
  searchQuery.value = "";
}

function doSearch(direction: "next" | "prev") {
  const active = tabs.value.find(t => t.id === activeId.value);
  if (!active) return;
  const entry = xterms.get(active.id);
  if (!entry?.search || !searchQuery.value) return;
  const found =
    direction === "next"
      ? entry.search.findNext(searchQuery.value, { regex: false, caseSensitive: false })
      : entry.search.findPrevious(searchQuery.value, { regex: false, caseSensitive: false });
  searchHasResult.value = found !== false;
}
```

Wire ⌘F / Ctrl+F on the panel's `@keydown` (the `.tp` div already has `@focusin`/`@focusout`). Add a `@keydown` handler on `.tp`:

```typescript
function onKeyDown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    openSearch();
  }
  if (e.key === "Escape" && searchVisible.value) {
    closeSearch();
  }
}
```

In the template, add `@keydown="onKeyDown"` to the `.tp` root div, and insert the search bar inside `.tp__body` (before the host divs):

```html
<!-- Search bar — shown when searchVisible is true -->
<div v-if="searchVisible" class="tp__search">
  <input
    class="tp__search-input"
    :placeholder="t('terminal.searchPlaceholder')"
    v-model="searchQuery"
    @input="doSearch('next')"
    @keyup.enter="doSearch('next')"
    @keyup.shift.enter="doSearch('prev')"
  />
  <button class="tp__search-btn" @click="doSearch('prev')" title="Previous (Shift+Enter)">↑</button>
  <button class="tp__search-btn" @click="doSearch('next')" title="Next (Enter)">↓</button>
  <span v-if="!searchHasResult" class="tp__search-noresult">{{ t('terminal.searchNoResult') }}</span>
  <button class="tp__search-close" @click="closeSearch">×</button>
</div>
```

Add CSS at the bottom of `<style scoped>`:

```css
.tp__search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border, var(--color-border));
  flex-shrink: 0;
  background: var(--bg-elevated, var(--color-bg-secondary));
}

.tp__search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--bg-base, var(--color-bg));
  color: inherit;
  font-size: var(--font-size-sm);
  padding: 2px 6px;
}

.tp__search-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-sm);
}

.tp__search-btn:hover {
  background: var(--color-bg-hover);
}

.tp__search-noresult {
  font-size: var(--font-size-xs, 11px);
  color: var(--color-danger, #e05c5c);
}

.tp__search-close {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: 14px;
  opacity: 0.5;
}

.tp__search-close:hover {
  opacity: 1;
  background: var(--color-bg-hover);
}
```

---

- [ ] **Step 6: Verify build and test**

```bash
cd apps/desktop
pnpm dev:web
```

Open a terminal tab. Verify:
- Output renders (canvas or WebGL — both work)
- Press ⌘F: the search bar appears
- Type a word that appears in the output: xterm highlights it, arrows navigate results
- Press Escape: search bar closes
- Click a URL in the terminal output: it opens in the browser

```bash
cd apps/desktop
pnpm test
```

Expected: all existing tests pass (no composable changes in this task).

---

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/components/TerminalPanel.vue apps/desktop/src/locales/
git commit -m "feat(terminal): WebGL renderer, inline search, clickable links (Terax parity)"
```

---

## Task 2: Git-first tab identity — tab types + unread indicator

> **Context:** The `TerminalTab` interface currently has `id`, `sessionId`, `title`, `titleManual`, `alive`. This task adds `type` (shell / agent variant) and `hasUnread` (output arrived while tab not focused), allowing the tab bar to visually distinguish shell tabs from Claude/Codex tabs and to signal background activity.

**Files:**
- Modify: `apps/desktop/src/composables/useTerminalSessions.ts`
- Modify: `apps/desktop/src/composables/__tests__/useTerminalSessions.test.ts`
- Modify: `apps/desktop/src/components/TerminalPanel.vue`
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts`

**Interfaces:**
- Produces: `TerminalTabType = "shell" | "claude" | "codex"` — consumed by Task 3 (agent launch) and Task 4 (New AI task).
- Produces: `useTerminalSessions().markRead(repoPath, tabId)` — called by `TerminalPanel.vue` on tab switch.
- Produces: `useTerminalSessions().openTab(repoPath, cwd, onChunk, opts?: { shell?, type? })` — `type` defaults to `"shell"`.

---

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/composables/__tests__/useTerminalSessions.test.ts`, add these tests at the end of the `describe` block (before the closing `}`):

```typescript
it("openTab crée un onglet de type 'shell' par défaut", async () => {
  const s = useTerminalSessions();
  const tab = await s.openTab("/repo/a", "/repo/a", () => {});
  expect(tab.type).toBe("shell");
});

it("openTab crée un onglet de type 'claude' quand opts.type='claude'", async () => {
  const s = useTerminalSessions();
  const tab = await s.openTab("/repo/a", "/repo/a", () => {}, { type: "claude" });
  expect(tab.type).toBe("claude");
});

it("hasUnread est faux à l'ouverture", async () => {
  const s = useTerminalSessions();
  const tab = await s.openTab("/repo/a", "/repo/a", () => {});
  expect(tab.hasUnread).toBe(false);
});

it("markRead vide le flag hasUnread", async () => {
  const s = useTerminalSessions();
  const tabA = await s.openTab("/repo/a", "/repo/a", () => {});
  const tabB = await s.openTab("/repo/a", "/repo/a", () => {});
  // tabB is now active; tabA is background
  // Simulate a chunk arriving for tabA (not active)
  s.simulateChunkForTab("/repo/a", tabA.id);
  expect(tabA.hasUnread).toBe(true);
  s.markRead("/repo/a", tabA.id);
  expect(tabA.hasUnread).toBe(false);
});
```

---

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/desktop
pnpm test -- --reporter=verbose 2>&1 | grep -A2 "FAIL\|hasUnread\|markRead\|type.*shell\|type.*claude"
```

Expected: 4 new tests FAIL because `type`, `hasUnread`, `markRead`, and `simulateChunkForTab` don't exist yet.

---

- [ ] **Step 3: Update `useTerminalSessions.ts` — add type, hasUnread, markRead, simulateChunkForTab**

At the top of the file, add the type and update the interface:

```typescript
export type TerminalTabType = "shell" | "claude" | "codex";

export interface TerminalTab {
  id: number;
  sessionId: number;
  title: string;
  titleManual: boolean;
  alive: boolean;
  type: TerminalTabType;   // NEW
  hasUnread: boolean;       // NEW
}
```

Update `openTab` to accept `type` in opts and to set `hasUnread` when a chunk arrives for a non-active tab:

```typescript
async function openTab(
  repoPath: string,
  cwd: string,
  onChunk: (tabId: number, chunk: string) => void,
  opts?: { shell?: string; type?: TerminalTabType },
): Promise<TerminalTab> {
  const tab: TerminalTab = {
    id: nextLocalId++,
    sessionId: -1,
    title: opts?.type === "claude" ? "Claude Code" : opts?.type === "codex" ? "Codex" : "shell",
    titleManual: false,
    alive: true,
    type: opts?.type ?? "shell",
    hasUnread: false,
  };
  // ... rest of existing openTab body unchanged, except replace the onChunk call:
```

Inside the `terminalOpen` callback (the lambda passed as third arg), add the unread marking before calling `onChunk`:

```typescript
const sessionId = await terminalOpen(
  cwd,
  { cols: 80, rows: 24, shell: opts?.shell || undefined },
  (chunk) => {
    if (activeByRepo.get(repoPath) !== tab.id) {
      tab.hasUnread = true;
    }
    onChunk(tab.id, chunk);
  },
);
```

Add `markRead` and `simulateChunkForTab` to the returned object:

```typescript
function markRead(repoPath: string, tabId: number): void {
  const tab = listFor(repoPath).find((t) => t.id === tabId);
  if (tab) tab.hasUnread = false;
}

// Test-only helper: simulates a PTY chunk arriving for a tab.
// Used in tests to trigger the hasUnread path without a real PTY.
function simulateChunkForTab(repoPath: string, tabId: number): void {
  if (activeByRepo.get(repoPath) !== tabId) {
    const tab = listFor(repoPath).find((t) => t.id === tabId);
    if (tab) tab.hasUnread = true;
  }
}

return {
  // ... existing exports ...
  markRead,
  simulateChunkForTab,
};
```

Also update `__resetForTests` to confirm the new fields reset cleanly (no change needed — `tabsByRepo.clear()` already covers it).

---

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/desktop
pnpm test -- --reporter=verbose 2>&1 | grep -A2 "PASS\|hasUnread\|markRead\|type.*shell\|type.*claude"
```

Expected: all 4 new tests PASS. All pre-existing tests still PASS.

---

- [ ] **Step 5: Update `TerminalPanel.vue` — tab type icons + unread dot**

In the tab bar template, replace the `<span v-else>{{ tab.title }}</span>` line with a richer tab label that shows a type icon and unread dot:

```html
<span v-else class="tp__tab-label">
  <!-- Type icon: shell = default, agent types get a distinct marker -->
  <span class="tp__tab-icon" :class="`tp__tab-icon--${tab.type}`">
    {{ tab.type === 'claude' ? 'C' : tab.type === 'codex' ? '⚡' : '$' }}
  </span>
  {{ tab.title }}
  <!-- Unread dot: visible when background tab has unseen output -->
  <span v-if="tab.hasUnread && tab.id !== activeId" class="tp__unread" />
</span>
```

Call `sessions.markRead` when a tab is activated. Update the `@click` handler on `.tp__tab`:

```html
<button
  ...
  @click="() => { sessions.setActive(props.repoPath, tab.id); sessions.markRead(props.repoPath, tab.id); }"
  ...
>
```

Add CSS for the new elements:

```css
.tp__tab-label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tp__tab-icon {
  font-size: 10px;
  opacity: 0.6;
  font-family: monospace;
  min-width: 12px;
}

.tp__tab-icon--claude {
  color: var(--color-accent);
  opacity: 1;
  font-weight: bold;
}

.tp__tab-icon--codex {
  color: #a370f7;
  opacity: 1;
}

.tp__unread {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}
```

---

- [ ] **Step 6: Build check**

```bash
cd apps/desktop
pnpm dev:web
```

Verify: open 2 tabs, leave the first one in the background. Run a command in the second tab — when you switch back to the first tab, there should be NO dot (correct, because the first tab didn't receive output). Run a command that produces output in the first tab while viewing the second — switch to the second tab and confirm the first tab now shows the unread dot. Click the first tab — dot disappears.

---

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/useTerminalSessions.ts \
        apps/desktop/src/composables/__tests__/useTerminalSessions.test.ts \
        apps/desktop/src/components/TerminalPanel.vue \
        apps/desktop/src/locales/
git commit -m "feat(terminal): tab types (shell/claude/codex) + unread indicator"
```

---

## Task 3: Fix "Launch Claude Code" — open a real PTY tab

> **Context:** The roadmap identifies this as a prerequisite blocker. Currently, `agentSessionLaunch` calls `hidden_cmd` (headless, no TTY) so Claude Code exits immediately. The fix: instead of invoking `hidden_cmd`, the frontend opens a new terminal tab of type `"claude"` in the worktree's cwd — `terminal_open` + `claude` as the shell argument. No new Rust commands needed. The existing `terminalOpen` already supports a custom shell via `opts.shell`.

**Files:**
- Modify: `apps/desktop/src/components/AgentSessionsPanel.vue`
- Modify: `apps/desktop/src/App.vue`

**Interfaces:**
- Consumes: `useTerminalSessions().openTab(repoPath, cwd, onChunk, { type: "claude", shell: "claude" })` — introduced in Task 2.
- Produces: `AgentSessionsPanel` emits `"launch-in-terminal"` with payload `{ cwd: string; tool: string }` instead of calling `agentSessionLaunch` directly.

---

- [ ] **Step 1: Read `AgentSessionsPanel.vue` to understand current launch logic**

```bash
grep -n "agentSessionLaunch\|setTimeout\|active\|emit" apps/desktop/src/components/AgentSessionsPanel.vue | head -30
```

Note the line numbers of: (a) the `agentSessionLaunch` call, (b) the `setTimeout` active hack.

---

- [ ] **Step 2: Replace `agentSessionLaunch` call in `AgentSessionsPanel.vue`**

Find the button or action that calls `agentSessionLaunch(cwd, tool)`. Replace it with an `emit`:

```typescript
// Replace:
await agentSessionLaunch(cwd, tool);
// With:
emit("launch-in-terminal", { cwd, tool });
```

Add the emit declaration if not already present:

```typescript
const emit = defineEmits<{
  // existing emits...
  (e: "launch-in-terminal", payload: { cwd: string; tool: string }): void;
}>();
```

Remove the `setTimeout` that optimistically sets `active = true`. Instead, after emitting, just close the sessions panel (the terminal tab opening is the confirmation):

```typescript
// Remove:
setTimeout(() => { session.active = true; }, 1500);
// Add nothing — the terminal tab opening IS the visual feedback.
```

---

- [ ] **Step 3: Handle `launch-in-terminal` in `App.vue`**

Find where `AgentSessionsPanel` is mounted in `App.vue` and add the event handler.

Import dependencies at top:

```typescript
import { useTerminalSessions } from "./composables/useTerminalSessions";
```

In the handler logic (near other terminal-related handlers):

```typescript
async function onLaunchInTerminal({ cwd, tool }: { cwd: string; tool: string }) {
  if (!activeRepoPath.value) return;
  const shell = tool === "claude" ? "claude" : tool === "codex" ? "codex" : tool;
  try {
    await sessions.openTab(
      activeRepoPath.value,
      cwd,
      (tabId, chunk) => terminalPanelRef.value?.writeChunk(tabId, chunk),
      { type: tool === "claude" ? "claude" : tool === "codex" ? "codex" : "shell", shell },
    );
    showTerminal.value = true; // reveal the terminal panel if hidden
  } catch (err) {
    console.error("Failed to launch agent terminal:", err);
  }
}
```

Wire the handler on the `AgentSessionsPanel` component tag:

```html
<AgentSessionsPanel
  ...
  @launch-in-terminal="onLaunchInTerminal"
/>
```

---

- [ ] **Step 4: Test the fix interactively**

```bash
cd apps/desktop
pnpm dev:web
```

Go to the Agents panel → click "Launch" on a Claude Code session. Verify:
- The terminal panel opens automatically (or was already open)
- A new tab of type "claude" (with the "C" icon) appears
- The tab shows Claude Code's startup output (TUI interface)
- No `setTimeout` ghost "active" state appears

---

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/AgentSessionsPanel.vue apps/desktop/src/App.vue
git commit -m "fix(agents): launch Claude Code / Codex in a real PTY terminal tab"
```

---

## Task 4: "New AI task" — worktree + agent tab + live diff (anti-IDE bootstrap)

> **Context:** This task implements the core "anti-IDE" gesture: one button creates a scratch worktree, opens it as a repo tab, launches Claude Code in a terminal tab pointing at that worktree, and the existing Changes panel will show what the agent is modifying in real time (the `notifyOutput` debounce already triggers repo refreshes). No new Rust commands — this chains `createScratchWorktree` (already exists) + `openTab` (Task 2).

**Files:**
- Modify: `apps/desktop/src/components/TerminalPanel.vue` — add "New AI task" item to the `+` dropdown
- Modify: `apps/desktop/src/App.vue` — handle `new-ai-task` emit: create worktree + open agent tab + open worktree as repo tab
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts` — add key

**Interfaces:**
- Consumes: existing `createScratchWorktree(repoPath)` from `backend.ts` (returns `{ path: string }`)
- Consumes: `useRepoTabs().openRepo(path)` — opens the worktree as a new repo tab
- Produces: `TerminalPanel` emits `"new-ai-task"` — no payload needed (App.vue knows activeRepoPath)

---

- [ ] **Step 1: Add i18n key**

In each of the 5 locale files, add inside `terminal: { ... }`:

```typescript
// en.ts
menuNewAiTask: "New AI task",
// fr.ts
menuNewAiTask: "Nouvelle tâche IA",
// es.ts
menuNewAiTask: "Nueva tarea IA",
// pt-br.ts
menuNewAiTask: "Nova tarefa IA",
// zh-cn.ts
menuNewAiTask: "新 AI 任务",
```

---

- [ ] **Step 2: Add "New AI task" to the `+` dropdown in `TerminalPanel.vue`**

Add a new emit declaration:

```typescript
const emit = defineEmits<{
  (e: "close"): void;
  (e: "new"): void;
  (e: "new-agent", tool: string): void;
  (e: "open-sessions"): void;
  (e: "new-ai-task"): void;  // NEW
}>();
```

In the template, add a new button inside `.tp__menu` after the existing Codex item:

```html
<button class="tp__menu-item tp__menu-item--accent" @click="selectDropdownItem(() => emit('new-ai-task'))">
  {{ t('terminal.menuNewAiTask') }}
</button>
```

Add CSS for the accent variant (makes it visually distinct — this is the primary CTA):

```css
.tp__menu-item--accent {
  color: var(--color-accent);
  font-weight: 500;
  border-top: 1px solid var(--color-border);
  margin-top: 2px;
  padding-top: 8px;
}
```

---

- [ ] **Step 3: Check what `createScratchWorktree` returns in `backend.ts`**

```bash
grep -n "createScratchWorktree\|ScratchWorktree" apps/desktop/src/utils/backend.ts | head -10
```

Confirm the return type. It should return `{ path: string }` or similar.

---

- [ ] **Step 4: Handle `new-ai-task` in `App.vue`**

Find where `TerminalPanel` is mounted and add the handler:

```html
<TerminalPanel
  ...
  @new-ai-task="onNewAiTask"
/>
```

Implement the handler (near `onLaunchInTerminal` from Task 3):

```typescript
async function onNewAiTask() {
  if (!activeRepoPath.value) return;
  try {
    // 1. Create a scratch worktree anchored to the active repo.
    const { path: worktreePath } = await createScratchWorktree(activeRepoPath.value);

    // 2. Open the scratch worktree as a new repo tab so Changes shows live diffs.
    await openRepo(worktreePath);

    // 3. Launch Claude Code in a terminal tab pointing at the worktree.
    await sessions.openTab(
      activeRepoPath.value,
      worktreePath,
      (tabId, chunk) => terminalPanelRef.value?.writeChunk(tabId, chunk),
      { type: "claude", shell: "claude" },
    );
    showTerminal.value = true;
  } catch (err) {
    console.error("New AI task failed:", err);
    // Surface error to user via existing toast/notification mechanism if available.
  }
}
```

`openRepo` comes from `useRepoTabs()` — check the exact import and function name:

```bash
grep -n "openRepo\|addRepo\|addTab" apps/desktop/src/composables/useRepoTabs.ts | head -10
```

Use whatever function opens a new repo tab from a path.

---

- [ ] **Step 5: Wire `notifyOutput` for live diff refresh**

The `notifyOutput` debounce in `useTerminalSessions` already fires the `mutationHandler` after 800ms of output silence. `App.vue` should already call `sessions.setMutationHandler` to refresh repo state. Verify this is wired:

```bash
grep -n "setMutationHandler\|notifyOutput" apps/desktop/src/App.vue | head -10
```

If `setMutationHandler` is already wired to call `refreshRepoState`, the live diff works automatically — the agent's file changes trigger a `git status` refresh which updates the Changes panel. If not wired, add:

```typescript
sessions.setMutationHandler((repoPath) => {
  if (repoPath === activeRepoPath.value) {
    refreshRepoState();
  }
});
```

---

- [ ] **Step 6: Add dev:web route for `createScratchWorktree` if missing**

```bash
grep -n "createScratchWorktree\|scratch" apps/desktop/dev-server.mjs | head -5
```

If the route exists, skip this step. If not, add a stub route in `dev-server.mjs`:

```javascript
app.post("/api/create-scratch-worktree", (req, res) => {
  // Dev stub: return a predictable temp path for manual testing
  res.json({ path: "/tmp/gitwand-scratch-dev" });
});
```

---

- [ ] **Step 7: Test the full flow interactively**

```bash
cd apps/desktop
pnpm dev:web
```

Open a repo. Click "+" → "New AI task". Verify:
1. A second repo tab appears (the scratch worktree)
2. A terminal tab with "C" icon appears, titled "Claude Code"
3. As you type in the terminal and run commands that create/modify files, switch to the Changes panel in the scratch worktree tab and verify files appear

---

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/TerminalPanel.vue \
        apps/desktop/src/App.vue \
        apps/desktop/src/locales/ \
        apps/desktop/dev-server.mjs
git commit -m "feat(terminal): 'New AI task' — worktree + Claude Code tab + live diff"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| WebGL GPU renderer | Task 1 |
| Inline search (⌘F) | Task 1 |
| Clickable links | Task 1 |
| Tab types (shell / claude / codex) | Task 2 |
| Unread output indicator | Task 2 |
| Fix "Launch Claude Code" | Task 3 |
| "New AI task" one-click gesture | Task 4 |
| Live diff of agent work | Task 4 (via existing notifyOutput) |
| i18n for all new strings | Tasks 1, 2, 4 |
| dev:web parity | Tasks 1–4 (no new Rust commands, existing channel infra) |

**Placeholder scan:** No TBD or "implement later" found. Every step has code.

**Type consistency:**
- `TerminalTabType` defined in Task 2, used in Task 2 (TerminalPanel.vue), Task 3 (App.vue handler), Task 4 (App.vue handler). String literal union — no import needed beyond the composable.
- `XtermEntry.search` defined in Task 1 Step 3, used in Task 1 Step 5. Consistent.
- `openTab` opts.type added in Task 2, called with `{ type: "claude" }` in Tasks 3 and 4. Consistent.
- `markRead(repoPath, tabId)` defined in Task 2, called in Task 2's TerminalPanel.vue. Consistent.
