<script setup lang="ts">
const GROUPS = [
  {
    title: 'New in v3.13 — Agent Workspaces',
    items: [
      ['Worktrees that set themselves up', 'Describe your environment once in .gitwandrc (ignored files to copy, setup, teardown, URL). Each new worktree starts from a freshly fetched base and comes up ready to run; GitWand asks before running the repo’s commands.'],
      ['Merge an agent’s work back', 'Bring a task’s work into your branch as a merge, a rebase or a squash, through the same preview as any other merge. Both checkouts are snapshotted first, nothing is stashed or aborted behind your back.'],
      ['Removal that cleans up', 'Removing a worktree stops its processes, snapshots its files and runs teardown, which has to succeed. Locked worktrees and other tools’ worktrees are never touched.'],
      ['Restore a removed worktree', 'The Time Machine lists removed worktrees and restores one as a new worktree, uncommitted files, index and setup included.'],
    ],
  },
  {
    title: 'Conflict engine',
    items: [
      ['Smart resolution', '8 deterministic patterns with a pattern registry and confidence scoring. Conflicts that carry no decision are resolved without intervention, each with a trace.'],
      ['Merge & auto-resolve', 'The Conflict Predictor runs the real merge, applies what clears your confidence bar and stops on what needs you. It never aborts on your behalf.'],
      ['A confidence bar you set', 'minConfidenceScore (0–100) in the app, .gitwandrc, the CLI and MCP. Per-hunk checkboxes let you decline one resolution without declining the rest.'],
      ['Token-level merge', 'Both sides changed disjoint tokens on the same line — GitWand decomposes it token by token and proposes the merge. Never auto-applied: you confirm it in a panel.'],
      ['2-way base recovery', 'Reconstructs the diff3 base from the git index so the base-dependent patterns work even on repos using git’s default conflict style.'],
      ['History-aware AI fallback', 'Opt-in: when a hunk goes to a model, the prompt says why each side changed it, from the commits since the merge base. A repository can turn it off for everyone.'],
    ],
  },
  {
    title: 'Core Git',
    items: [
      ['Git Tree', 'Your history as a graph, with uncommitted work as a WIP row at the top. Follows every ref move as it happens, even from a terminal.'],
      ['Integrated Pull Requests', 'Review GitHub, GitLab, Bitbucket, Azure DevOps, Gitea and Forgejo PRs in the app — comments, reviews, CI status, conflict preview, and auto-merge once checks pass.'],
      ['Visual diff', 'Unified diff viewer with syntax highlighting, hunk-level staging, merge preview, and hunks you can edit in place.'],
      ['Safer branch moves', 'Reset --keep refuses instead of discarding an edit, opt-in auto fast-forward after fetch, Cherry-pick as WIP, and a Time Machine snapshot before every rewrite.'],
      ['Split a commit by hunks', 'Break a commit in two by picking files and lines — handles added, deleted and renamed files.'],
      ['Tags manager', 'List, create, push and delete local and remote tags. AI-suggested next semantic version.'],
    ],
  },
  {
    title: 'Power user',
    items: [
      ['Git worktrees', 'Work on several branches at once without stashing. Each worktree opens as a tab, created in one click, set up by your repo’s own commands.'],
      ['Submodule management', 'List, initialize and update submodules with status badges, open them as tabs.'],
      ['Advanced file history', 'Pickaxe search (-S/-G), blame by line range, a diff algorithm selector, and a Compare tab that follows renames.'],
      ['Commit context menu', 'Right-click actions: checkout, reset, revert, new branch, tag, cherry-pick (or as WIP), view on forge, copy SHA.'],
      ['Fork & triangular workflow', '“↑N fork” badge in the sync button so push remote ≠ upstream — no accidental pushes to origin.'],
      ['Integrated terminal & AI agents', 'GitWand’s own terminal emulator, fast even without a GPU: truecolor, search, clickable links, Nerd Font icons. Typed tabs launch Claude Code, Codex, opencode or Antigravity, and “New AI task” runs an agent in its own worktree.'],
      ['File explorer & editor', 'A file browser for the whole working tree, with a badge on every changed file and the folders above it, a diff or editor per tab, blame, and “Scope here”.'],
    ],
  },
  {
    title: 'AI (opt-in)',
    items: [
      ['AI merge insight', 'Plain-English conflict explanation, AI risk summary before rebase/merge, semantic squash in interactive rebase.'],
      ['AI code review & PR', 'Generated or redrafted PR titles and descriptions, per-hunk AI critique in the Review panel, branch-name suggestions, and a “ctx” field for what the diff can’t say.'],
      ['AI commit & history', 'Generated commit and stash messages, semantically-ranked Absorb, blame context and release notes, with per-repo templates and output language.'],
      ['Agents at arm’s length', 'AI CLIs run in an empty environment and a throwaway folder, without your forge tokens; API keys live in the system keychain.'],
      ['MCP server', 'Expose GitWand to Claude Code, Cursor, Windsurf and any MCP client. One command: npx -y @gitwand/mcp.'],
    ],
  },
] as const

type CV = boolean | 'partial' | 'soon'
interface Row { category?: boolean; label: string; note?: string; highlight?: boolean; gw?: CV; ghd?: CV; gk?: CV; fork?: CV; tower?: CV; sm?: CV }
const ROWS: Row[] = [
  { category: true, label: 'Workflow' },
  { label: 'Free & open source',       gw: true, ghd: true,  gk: false, fork: false, tower: false, sm: false },
  { label: 'Native app (no Electron)', gw: true, ghd: false, gk: false, fork: true,  tower: true,  sm: true  },
  { label: 'Linux',                    gw: true, ghd: false, gk: true,  fork: false, tower: false, sm: true  },
  { label: 'CLI tool',                 gw: true, ghd: false, gk: true,  fork: false, tower: false, sm: false },
  { label: 'VS Code extension',        gw: true, ghd: false, gk: true,  fork: false, tower: false, sm: false },
  { category: true, label: 'Conflict resolution' },
  { label: 'Auto-resolve conflicts',            gw: true, ghd: false, gk: 'partial', fork: false, tower: false, sm: false, highlight: true },
  { label: 'Confidence scoring per hunk',       gw: true, ghd: false, gk: true,      fork: false, tower: false, sm: false, highlight: true },
  { label: 'Zero-impact merge / rebase preview',gw: true, ghd: false, gk: 'partial', fork: false, tower: false, sm: false, highlight: true },
  { label: 'Predict rebase & cherry-pick',      gw: true, ghd: false, gk: 'partial', fork: 'partial', tower: false, sm: false, highlight: true },
  { label: 'Scratch worktree resolution',       gw: true, ghd: false, gk: false,     fork: false, tower: false, sm: false, highlight: true },
  { label: 'Validation feedback (residual markers)', gw: true, ghd: false, gk: false, fork: false, tower: false, sm: false, highlight: true },
  { category: true, label: 'Power Git' },
  { label: 'Interactive rebase',   gw: true, ghd: 'partial', gk: true,  fork: true,  tower: true,  sm: true  },
  { label: 'Worktrees',            gw: true, ghd: false,     gk: true,  fork: true,  tower: true,  sm: false },
  { label: 'Split commit by hunks',gw: true, ghd: false,     gk: false, fork: false, tower: false, sm: false },
  { label: 'Multi-repo workspaces',gw: true, ghd: false,     gk: true,  fork: true,  tower: 'partial', sm: false },
  { label: 'Cross-repo dashboard', gw: true, ghd: false,     gk: true,  fork: false, tower: false, sm: false },
  { category: true, label: 'AI & agents', note: 'GitWand connects to your own LLM — Claude, OpenAI-compatible, or Ollama. No built-in model.' },
  { label: 'AI conflict explanation', gw: true, ghd: false, gk: 'partial', fork: false, tower: false, sm: false, highlight: true },
  { label: 'MCP server for AI agents',gw: true, ghd: false, gk: true,      fork: false, tower: false, sm: false },
  { label: 'PR activity notifications',gw: true,ghd: false, gk: true,      fork: false, tower: false, sm: false },
]
function ic(v?: CV){ return v===true?'✓':v==='partial'?'~':v==='soon'?'soon':'✗' }
function cc(v?: CV){ return v===true?'y':v==='partial'?'p':v==='soon'?'s':'n' }
</script>

<template>
  <div class="gw-page">
    <section class="ph-hero">
      <div class="ph-inner">
        <span class="ph-badge">Features</span>
        <h1 class="ph-h1">Everything you need for Git <br> <span class="grad">native and free.</span></h1>
        <p class="ph-sub">A complete daily workflow with no performance compromise, across three consistent interfaces: desktop app, CLI and VS Code. Below: the full feature set, and an honest feature-by-feature comparison with the popular clients.</p>
        <div class="ph-ctas">
          <a href="/" class="ph-btn ph-btn--primary">Download GitWand</a>
          <a href="/guide/getting-started" class="ph-btn">Documentation →</a>
        </div>
      </div>
    </section>

    <section class="ph-section">
      <div class="ph-inner">
        <div v-for="g in GROUPS" :key="g.title" class="fgroup">
          <h2 class="ph-h2 fgroup-title">{{ g.title }}</h2>
          <div class="fgrid">
            <div v-for="it in g.items" :key="it[0]" class="fcard">
              <h3 class="fcard-title">{{ it[0] }}</h3>
              <p class="fcard-desc">{{ it[1] }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="ph-section ph-section--alt">
      <div class="ph-inner">
        <h2 class="ph-h2">How GitWand compares</h2>
        <p class="ph-secsub">Feature-by-feature against the most popular Git clients. Fact-checked July 2026; worktree, forge and agent rows re-checked November 2026.</p>
        <CompareMatrix />
        <div class="ph-ctas ph-ctas--center">
          <a href="/compare/" class="ph-btn">Full comparisons →</a>
          <a href="/conflict-engine" class="ph-btn">See the conflict engine →</a>
          <a href="/ai-agents" class="ph-btn">AI &amp; agents →</a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.gw-page{
  --purple:var(--nc-accent-300);--purple-d:var(--nc-accent-600);--green:var(--nc-settled);
  --bg:var(--nc-canvas);--bg2:var(--nc-bg);--card:var(--nc-surface);
  --border:var(--nc-neutral-800);--border-soft:var(--nc-rule-soft);
  --text:var(--nc-text);--muted:var(--nc-neutral-400);
  background:var(--bg);color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
.ph-inner{max-width:1080px;margin:0 auto;padding:0 24px;}
.ph-hero{padding:80px 0 56px;text-align:center;background:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(145, 132, 217,0.18) 0%,transparent 70%),var(--bg);border-bottom:1px solid var(--border-soft);}
.ph-badge{display:inline-block;font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;color:var(--purple);background:rgba(145, 132, 217,0.1);border:1px solid var(--border);margin-bottom:18px;}
.ph-h1{font-size:44px;line-height:1.15;font-weight:800;letter-spacing:-0.02em;margin:0 auto 18px;max-width:820px;}
.ph-h1 .grad{background:linear-gradient(135deg,var(--purple),var(--green));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
.ph-sub{font-size:18px;line-height:1.65;color:var(--muted);max-width:700px;margin:0 auto 28px;}
.ph-ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.ph-ctas--center{margin-top:36px;}
.ph-btn{padding:11px 22px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;color:var(--text);border:1px solid var(--border-soft);transition:border-color .15s,color .15s;}
.ph-btn:hover{border-color:var(--purple);color:var(--purple);}
.ph-btn--primary{background:var(--purple-d);color:#fff;border-color:var(--purple-d);}
.ph-btn--primary:hover{background:var(--purple);color:#fff;}
.ph-section{padding:72px 0;}
.ph-section--alt{background:var(--bg2);border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);}
.ph-h2{font-size:30px;font-weight:800;letter-spacing:-0.01em;text-align:center;margin:0 0 10px;}
.ph-secsub{font-size:16px;color:var(--muted);text-align:center;max-width:660px;margin:0 auto 40px;line-height:1.6;}
.fgroup{margin-bottom:48px;}
.fgroup-title{text-align:left;font-size:22px;margin-bottom:20px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;}
.fcard{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;}
.fcard-title{font-size:16px;font-weight:700;margin:0 0 8px;}
.fcard-desc{font-size:14px;line-height:1.6;color:var(--muted);margin:0;}
.cmp-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;}
.cmp{width:100%;border-collapse:collapse;font-size:13.5px;min-width:720px;}
.cmp th,.cmp td{padding:12px 14px;text-align:center;border-bottom:1px solid var(--border-soft);}
.cmp thead th{color:var(--muted);font-weight:700;vertical-align:top;}
.cmp thead th span{display:block;font-size:11px;font-weight:500;opacity:0.7;margin-top:3px;}
.cmp thead th.cmp-gw{color:var(--purple);}
.cmp-feat{text-align:left;font-weight:500;color:var(--text);}
.cmp-uniq{margin-left:8px;font-size:10px;color:var(--purple);border:1px solid var(--border);border-radius:6px;padding:1px 6px;}
.cmp-gw{background:rgba(145, 132, 217,0.07);}
.cmp-cat td{text-align:left;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);background:var(--bg);padding-top:18px;}
.cmp-note{display:block;text-transform:none;letter-spacing:0;font-weight:400;font-size:12px;color:var(--muted);margin-top:4px;}
.cmp-hl{background:rgba(145, 132, 217,0.03);}
.c-y{color:var(--green);font-weight:700;}.c-n{color:var(--muted);opacity:0.45;}
.c-p{color:var(--nc-waiting);}.c-s{font-size:11px;color:var(--purple);}
@media(max-width:640px){.ph-h1{font-size:32px;}.ph-h2{font-size:24px;}}
</style>
