---
title: "Pairing Claude Code with GitWand: letting AI agents ship without the merge nightmare"
description: "How GitWand's MCP server closes the gap between an AI agent that can write code and one that can actually merge it — without blowing up your history."
date: 2026-04-24
head:
  - - meta
    - property: og:title
      content: "Pairing Claude Code with GitWand: letting AI agents ship without the merge nightmare"
  - - meta
    - property: og:description
      content: "How GitWand's MCP server closes the gap between an AI agent that can write code and one that can actually merge it — without blowing up your history."
  - - meta
    - name: twitter:title
      content: "Pairing Claude Code with GitWand: letting AI agents ship without the merge nightmare"
---

# Pairing Claude Code with GitWand: letting AI agents ship without the merge nightmare

AI coding agents have gotten good at writing code. What they're still bad at is *landing* it — handling the messy, stateful, unforgiving part of Git that comes after the last line is written. Merge conflicts, stale branches, partial resolutions, history that makes no sense. That's the unsexy 20% that blocks the other 80%.

GitWand's MCP server was built to close that gap. This post shows how I use it with Claude Code, what the handoff actually looks like, and where it still breaks.

---

## The problem with AI agents and Git

A capable coding agent today can take a task, open a branch, write a feature, and even write a decent commit message. What it cannot do reliably is handle the merge conflict that appears when its branch intersects with everything else happening on the repo.

The typical failure mode: the agent hits a conflict, sees the raw `<<<<<<<` markers, guesses at a resolution based on the surrounding code, applies something plausible-looking — and introduces a silent regression. Or it panics and stops. Neither is useful.

The root cause is that merge conflict resolution is not a code understanding problem alone. It's a *versioning* problem. You need to know: which change came from where, what the base state was, whether the two changes are actually compatible, and — critically — when to *not* decide and ask a human instead. That's exactly what GitWand's engine was built for.

---

## The setup: one command

```bash
claude mcp add gitwand -- npx -y @gitwand/mcp
```

That's it. The MCP server runs locally over stdio — no API key, no network access, no account. It exposes five tools and three resources to any MCP-compatible client.

**Tools:**
- `gitwand_status` — repo state, current conflicts, ahead/behind counts
- `gitwand_preview_merge` — simulate a merge with zero side effects and return a risk assessment
- `gitwand_resolve_conflicts` — run the auto-resolver, return what was resolved and what wasn't
- `gitwand_explain_hunk` — natural-language explanation of a specific conflict
- `gitwand_apply_resolution` — write a manual resolution decided by the agent

**Resources:**
- `gitwand://repo/conflicts` — current conflict list with per-hunk context
- `gitwand://repo/policy` — active `.gitwandrc` policy (which patterns are allowed, minimum confidence)
- `gitwand://hunk/{file}/{line}` — full ours/theirs/base content for a specific hunk

---

## The workflow

The pattern I've settled on has three phases. GitWand handles the first; the agent takes over on the second; the third only happens in edge cases.

### Phase 1: preview before touching anything

Before the agent merges or rebases, it calls `gitwand_preview_merge`. This runs `git merge-file -p --diff3` in a temporary directory — no index changes, no worktree changes, no history side effects. It returns:

```json
{
  "totalHunks": 12,
  "autoResolvable": 10,
  "pending": 2,
  "riskLevel": "low",
  "pendingHunks": [
    {
      "file": "src/api/users.ts",
      "startLine": 142,
      "type": "complex",
      "confidence": 31,
      "oursLines": ["  return user.id ?? generateId()"],
      "theirsLines": ["  return user.externalId || user.id"],
      "baseLines": ["  return user.id"]
    }
  ]
}
```

The agent sees upfront: 10 of 12 conflicts will be handled automatically, 2 need attention, risk is low. It can brief you on this before doing anything, which is the right behavior.

### Phase 2: auto-resolve, then handle the residual

The agent calls `gitwand_resolve_conflicts`. GitWand runs its full classification pipeline — 8 deterministic patterns, composite confidence scoring, format-aware resolvers for JSON/YAML/TypeScript imports — and writes the resolved content back to disk. It returns a `pendingHunks` array for everything it couldn't safely handle.

For the 95%+ of conflicts that are trivial (whitespace changes, one-side additions, same change on both sides, import reorders, lockfile updates), the agent doesn't see them at all. GitWand writes the correct resolution and moves on.

For the `pendingHunks`, the agent has the full context — `oursLines`, `theirsLines`, `baseLines`, the classification attempt, and the confidence score that caused the pattern to bail. With that, a capable model can make a real decision rather than a guess.

If the agent resolves a pending hunk, it calls `gitwand_apply_resolution` with the chosen content. GitWand validates the result (no residual markers, valid syntax for JSON/YAML) before writing.

### Phase 3: when the agent doesn't know either

This is the case that matters most for safety. If the agent reads a pending hunk, calls `gitwand_explain_hunk` to get a natural-language breakdown, and still isn't confident — it should stop and surface the conflict to a human. The design of the MCP response makes this easy: `pendingHunks` with a `confidence: 31` and `type: "complex"` is a clear signal that this is not a case for automation.

This is the thing I wanted to get right from the start: the system should be *loudly* uncertain, not quietly wrong.

---

## Worktrees: one branch per agent

The workflow above is even cleaner when the agent works on its own worktree. Claude Code supports running tasks in parallel across worktrees, and GitWand's desktop app has first-class worktree management — you can see every worktree as a tab, with its own diff, staging area, and merge state.

The pattern I use:

1. Create a worktree for the agent's task: `git worktree add ../gitwand-feat-xyz -b feat/xyz`
2. Point Claude Code at that directory
3. The agent develops in isolation, no interference with main or other agents
4. When ready, preview the merge from the main worktree using `gitwand_preview_merge`
5. Merge, let GitWand resolve, handle residual if any

This is also what GitWand's upcoming **Agent Sessions panel** (v2.2) will surface directly in the UI — a live view of which worktrees have active agent sessions and their current state.

---

## Configuring what GitWand will and won't auto-resolve

By default, GitWand auto-resolves anything above a confidence threshold of 68 (on a 0–100 scale). You can tighten or loosen this per-repo in `.gitwandrc`:

```json
{
  "policy": "prefer-safety",
  "minConfidence": 80,
  "patterns": {
    "generated_file": false
  },
  "generatedFiles": ["*.snap", "coverage/**"]
}
```

`prefer-safety` tells the engine to downgrade confidence on any hunk touching more than one logical scope. With `minConfidence: 80`, roughly half the patterns that would pass in default mode will stay as `pendingHunks` for the agent to review. This is the setting I'd recommend for any agent that's operating on production branches.

The policy applies per-glob too, so you can say: resolve everything freely in `packages/ui/**` but be conservative in `packages/core/**`.

---

## What doesn't work yet

Being honest about the limits:

**Complex semantic conflicts are still hard.** If two branches made incompatible logical changes — both added a field to a function signature but with different types — GitWand correctly classifies this as `complex` and declines. The agent gets the context. Whether it resolves it correctly depends on its understanding of the codebase. GitWand doesn't help here beyond handing off.

**Rebase conflicts are noisier.** In a rebase, each commit's conflicts are resolved sequentially. `gitwand_resolve_conflicts` handles one pass at a time; the agent needs to loop, calling `git rebase --continue` and re-checking after each step. The tooling works, but the loop logic has to live in the agent's reasoning.

**The MCP server doesn't yet expose worktree management.** Creating and switching worktrees from inside the agent still requires shell commands. The GitWand GUI does this well, but the MCP surface hasn't caught up. It's on the roadmap.

---

## The part that surprised me

When I first wired this up, I expected the main value to be conflict resolution — GitWand handling the trivial cases so the agent doesn't have to. That's real, but it's not the thing that changed the workflow most.

The bigger change was `gitwand_preview_merge`. Knowing *before* the merge that there are 2 unresolvable hunks in `src/api/users.ts`, at line 142, with a `confidence: 31` — that changes what the agent does before the merge. It can look at those lines in advance, understand the divergence in context, and make decisions with full information instead of reacting to markers it encounters mid-rebase.

That preview-first pattern is what makes the whole thing feel like collaboration rather than cleanup.

---

## Try it

```bash
# With Claude Code
claude mcp add gitwand -- npx -y @gitwand/mcp

# Then in any Claude Code session on a repo with conflicts:
/resolve
```

The `/resolve` slash command runs the full flow: preview, auto-resolve, surface pending, ask what to do with them.

The MCP server is also listed on the [official MCP Registry](https://mcp-registry.io), so any client that browses the registry will find it without configuration.

The [full documentation](/guide/mcp) covers all five tools, the resource schema, and the `.gitwandrc` policy options.
