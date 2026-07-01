# Terminal Hub UX — Design Spec

> **Context:** Follow-on to `2026-06-23-v3.1.0-terminal-pty-design.md`. The PTY terminal is implemented on `feat/v3.1.0-terminal-pty`. This spec covers the UX rework that makes the terminal the primary launch point for AI agents.

---

## Problem

The current UX forces a two-step path to open Claude Code:
1. Click "Agents" button in the header → AgentSessionsPanel modal opens
2. Click "Launch" on a session row → PTY tab opens

For the 90% case (current repo, launch claude), the modal is pure friction.  
The modal's unique value — cross-worktree git state (ahead/behind/modified counts) — is only relevant when managing multiple worktrees simultaneously.

---

## Solution: Hub terminal + "+" menu

### Entry point — Header button

The "Agents" button in `AppHeader.vue` is repurposed as the **Terminal** button:

- **Icon:** terminal/prompt (`>_`) style SVG, replaces the bot icon
- **Label:** `terminal.headerLabel` ("Terminal"), replaces `agents.headerLabel`
- **Event:** `openTerminal` (was `openAgents`)
- **Behavior:** clicking it calls `openTerminalTab(cwd)` directly in App.vue — opens a plain shell PTY tab and shows the panel. No more "show empty panel, wait for user to click +".

### "+" dropdown in TerminalPanel

The existing `+` button in the TerminalPanel tab bar becomes a **dropdown menu** (small absolute-positioned popover, dismissed on outside-click, no new dependency):

| Item | Keyboard | Action |
|---|---|---|
| Shell | — | Opens a plain PTY tab (same as current `@new`) |
| Claude Code | — | Opens a PTY tab + writes `claude\n` |
| Codex | — | Opens a PTY tab + writes `codex\n` |
| View sessions | — | Shows AgentSessionsPanel (cross-worktree overview) |

**New emits on TerminalPanel:**

```ts
(e: "new"): void                    // shell — unchanged
(e: "new-agent", tool: string): void // "claude" | "codex"
(e: "open-sessions"): void           // cross-worktree overview
```

App.vue wires `@new-agent` identically to the existing `onLaunchAgent`: open a PTY tab for `cwd`, write `${tool}\n`.

### AgentSessionsPanel — demoted, unchanged

AgentSessionsPanel retains all current behavior (list sessions by worktree, click to launch in PTY, open Cursor/Windsurf externally). The only change is that it's no longer reachable from the header:

- `openAgents` event removed from AppHeader
- `showAgents` in App.vue is now triggered by `@open-sessions` from TerminalPanel

No internal changes to `AgentSessionsPanel.vue`.

---

## Files touched

| File | Change |
|---|---|
| `AppHeader.vue` | Rename Agents button → Terminal button; change icon, event name (`openAgents` → `openTerminal`), i18n key |
| `App.vue` | Wire `openTerminal` → `openTerminalTab(cwd)`; wire `@open-sessions` → `showAgents = true`; remove `@open-agents` from AppHeader |
| `TerminalPanel.vue` | `+` → dropdown; add `new-agent` and `open-sessions` emits |
| `locales/en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts` | Add 5 new keys (see below) |

---

## i18n keys (all 5 locales)

```ts
terminal: {
  // existing keys (newTab, hide, closeTab) …
  headerLabel: "Terminal",    // button label in header
  menuShell:   "Shell",
  menuClaude:  "Claude Code",
  menuCodex:   "Codex",
  menuSessions: "View sessions",
}
```

French / Spanish / pt-BR / zh-CN translations included in the implementation.

---

## Out of scope

- Detecting whether `claude`/`codex` are installed before showing menu items (future)
- Keyboard shortcuts for dropdown items (future)
- Any visual change to AgentSessionsPanel itself
