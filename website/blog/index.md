---
title: Blog — GitWand
description: Technical articles on Git workflows, AI-powered conflict resolution, and open-source development. Written by the team behind GitWand.
---

# Blog

<div class="blog-list">
  <a href="/blog/v2-5-llm-fallback" class="blog-card">
    <div class="blog-meta">May 11, 2026 · 14 min read</div>
    <h2 class="blog-title">Why we made LLM resolution opt-in (and how): GitWand v2.5</h2>
    <p class="blog-excerpt">The new <code>llm_proposed</code> pattern sits at priority 998, off by default. Why opt-in, why the v2.4 post-merge validator is the gate, why <code>@gitwand/core</code> still ships zero <code>fetch()</code> calls — and the MCP path that needs no API key.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/agent-sessions-automations-v2-8" class="blog-card">
    <div class="blog-meta">May 2, 2026 · 18 min read</div>
    <h2 class="blog-title">Hooks, workspaces, agent sessions, and automations: what went into GitWand v2.7 and v2.8</h2>
    <p class="blog-excerpt">Git hooks manager, multi-repo workspaces, worktree quick-create (⌘⇧N), cross-platform AI agent detection with lsof and /proc/cwd, a daemonless automation scheduler, and conflict resolution memory — six features across two releases.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/state-of-merge-conflict-resolution-2026" class="blog-card">
    <div class="blog-meta">Apr 26, 2026 · 12 min read</div>
    <h2 class="blog-title">The state of automatic merge conflict resolution in 2026: a survey, and where GitWand is headed</h2>
    <p class="blog-excerpt">Five families of techniques, from RCS in 1986 to ConGra in 2024 — textual diff, AST-based structural merge, semantic merge, refactoring-aware tools, and LLMs. What's in GitWand today, and the v2 roadmap that follows the literature.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/claude-code-gitwand-ai-agents" class="blog-card">
    <div class="blog-meta">Apr 24, 2026 · 9 min read</div>
    <h2 class="blog-title">Pairing Claude Code with GitWand: letting AI agents ship without the merge nightmare</h2>
    <p class="blog-excerpt">How GitWand's MCP server closes the gap between an AI agent that can write code and one that can actually merge it — the preview-first pattern, the auto-resolve handoff, and where it still breaks.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/contributing-to-open-source-with-forks" class="blog-card">
    <div class="blog-meta">Apr 23, 2026 · 7 min read</div>
    <h2 class="blog-title">Contributing to open source with a fork: a GitWand walkthrough</h2>
    <p class="blog-excerpt">The fork → clone → upstream → PR workflow, step by step. How GitWand's triangular-workflow badge surfaces the right information at the right time — something GitHub Desktop still doesn't do.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/auto-merge-failure-modes" class="blog-card">
    <div class="blog-meta">Apr 23, 2026 · 8 min read</div>
    <h2 class="blog-title">How often does GitWand's auto-merge get it wrong? A catalog of known failure modes</h2>
    <p class="blog-excerpt">Honest per-pattern catalog of where the conflict classifier can be wrong, the structural safeguards that keep the blast radius small, and the design trade-offs behind each one.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/split-commit-by-hunks" class="blog-card">
    <div class="blog-meta">Apr 21, 2026 · 9 min read</div>
    <h2 class="blog-title">Splitting a commit by hunks: what went into GitWand v1.7.0</h2>
    <p class="blog-excerpt">How I added a hunk-level commit splitter to GitWand, why merge commits needed a hard block, and the patch-header bug that only surfaced on file creations.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/worktrees-submodules-auto-update" class="blog-card">
    <div class="blog-meta">Apr 20, 2026 · 8 min read</div>
    <h2 class="blog-title">Worktrees, submodules, and a broken auto-updater: what went into GitWand v1.6.3</h2>
    <p class="blog-excerpt">How I added Git worktree and submodule management to a Tauri desktop app, and fixed four silent bugs that were keeping auto-update from ever working.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/why-i-built-another-git-client" class="blog-card">
    <div class="blog-meta">Apr 20, 2026 · 8 min read</div>
    <h2 class="blog-title">Why I built another Git client</h2>
    <p class="blog-excerpt">There are already a dozen Git GUIs. Here's what was missing from all of them — and why I spent a year building GitWand anyway.</p>
    <span class="blog-read">Read article →</span>
  </a>
  <a href="/blog/automatic-merge-conflict-resolution" class="blog-card">
    <div class="blog-meta">Apr 20, 2026 · 10 min read</div>
    <h2 class="blog-title">How I built automatic merge conflict resolution: pattern classification and composite confidence scoring</h2>
    <p class="blog-excerpt">Pattern-based engine that auto-resolves trivial Git merge conflicts using classification, composite confidence scoring, and format-aware resolvers for JSON and Markdown.</p>
    <span class="blog-read">Read article →</span>
  </a>
</div>

<style>
.blog-list {
  margin-top: 2rem;
}
.blog-card {
  display: block;
  padding: 1.75rem 2rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  text-decoration: none !important;
  color: inherit;
  transition: border-color 0.2s, background 0.2s;
  margin-bottom: 1.25rem;
}
.blog-card:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}
.blog-meta {
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  margin-bottom: 0.5rem;
  font-family: var(--vp-font-family-mono);
}
.blog-title {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 0 0 0.6rem;
  line-height: 1.4;
  border: none;
  padding: 0;
}
.blog-excerpt {
  font-size: 0.9rem;
  color: var(--vp-c-text-2);
  margin: 0 0 1rem;
  line-height: 1.6;
}
.blog-read {
  font-size: 0.85rem;
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
.blog-read:hover {
  text-decoration: underline;
}
</style>
