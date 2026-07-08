<script setup lang="ts">
const GROUPS = [
  {
    title: 'Core Git',
    items: [
      ['Smart resolution', '8 deterministic patterns with a pattern registry and confidence scoring. 95%+ of trivial conflicts resolved without intervention.'],
      ['Integrated Pull Requests', 'Review GitHub, GitLab, Bitbucket and Azure DevOps PRs directly in the app — comments, reviews, CI status, conflict preview.'],
      ['Visual diff', 'Unified diff viewer with syntax highlighting, hunk-level staging, and merge preview.'],
      ['Folder tree diff', 'Flat ↔ tree toggle in the file list with per-folder aggregates, click-to-filter and a resizable sidebar.'],
      ['Split a commit by hunks', 'Break a commit in two by picking files and lines — handles added, deleted and renamed files.'],
      ['Tags manager', 'List, create, push and delete local and remote tags. AI-suggested next semantic version.'],
    ],
  },
  {
    title: 'Power user',
    items: [
      ['Git worktrees', 'Work on multiple branches at once without stashing. Each worktree opens as a tab, created in one click.'],
      ['Submodule management', 'List, initialize and update submodules with status badges, open them as tabs.'],
      ['Advanced file history', 'Pickaxe search (-S/-G), blame by line range, and a diff algorithm selector.'],
      ['History & graph', 'Full history, interactive DAG graph, file blame and natural-language commit search.'],
      ['Commit context menu', '12 right-click actions: checkout, reset, revert, new branch, tag, cherry-pick, view on forge, copy SHA.'],
      ['Fork & triangular workflow', '“↑N fork” badge in the sync button so push remote ≠ upstream — no accidental pushes to origin.'],
      ['Integrated terminal & AI agents', 'A real PTY terminal in-app — WebGL rendering, inline search, clickable links, typed tabs. Beyond a plain shell, first-class agent tabs launch Claude Code, Codex, opencode or Antigravity, and “New AI task” runs an agent in an isolated scratch worktree.'],
      ['File explorer & editor', 'A gitignore-aware working-tree file tree with a built-in CodeMirror 6 editor: syntax highlighting, a lock/edit toggle, undo and save — read and tweak files without leaving GitWand.'],
    ],
  },
  {
    title: 'AI (opt-in)',
    items: [
      ['AI merge insight', 'Plain-English conflict explanation, AI risk summary before rebase/merge, semantic squash in interactive rebase.'],
      ['AI code review & PR', 'Auto-generated PR title and description, per-hunk AI critique in the Review panel, branch-name suggestions.'],
      ['AI commit & history', 'Generated commit and stash messages, semantically-ranked Absorb, blame context and release notes.'],
      ['MCP server', 'Expose GitWand to Claude Code, Cursor, Windsurf and any MCP client. One command: npx -y @gitwand/mcp.'],
    ],
  },
  {
    title: 'New in v3.4',
    items: [
      ['Token-level merge', 'Both sides changed disjoint tokens on the same line — GitWand decomposes it token by token and proposes the merge. Never auto-applied: you confirm it in a panel.'],
      ['2-way base recovery', 'Reconstructs the diff3 base from the git index so the base-dependent patterns work even on repos using git’s default conflict style — where they used to sit inert.'],
      ['Resolution preview + per-hunk confirm', 'Every auto-resolvable hunk shows its result before you apply it, and “Resolve auto” confirms a per-hunk summary instead of applying blind.'],
      ['Recoverable-before-model metric', 'See how much of the residual is still resolved deterministically before any AI — in the CLI, the merge editor, and a cumulative local tally in Settings.'],
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
        <p class="ph-secsub">Feature-by-feature against the most popular Git clients. Fact-checked July 2026.</p>
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
  --purple:#8B5CF6;--purple-d:#7C3AED;--green:#10B981;
  --bg:#0c0c1a;--bg2:#111120;--card:#16162a;
  --border:rgba(124,58,237,0.18);--border-soft:rgba(255,255,255,0.06);
  --text:#e2e8f0;--muted:#94a3b8;
  background:var(--bg);color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
.ph-inner{max-width:1080px;margin:0 auto;padding:0 24px;}
.ph-hero{padding:80px 0 56px;text-align:center;background:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(124,58,237,0.18) 0%,transparent 70%),var(--bg);border-bottom:1px solid var(--border-soft);}
.ph-badge{display:inline-block;font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;color:var(--purple);background:rgba(124,58,237,0.1);border:1px solid var(--border);margin-bottom:18px;}
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
.cmp-gw{background:rgba(124,58,237,0.07);}
.cmp-cat td{text-align:left;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);background:var(--bg);padding-top:18px;}
.cmp-note{display:block;text-transform:none;letter-spacing:0;font-weight:400;font-size:12px;color:var(--muted);margin-top:4px;}
.cmp-hl{background:rgba(124,58,237,0.03);}
.c-y{color:var(--green);font-weight:700;}.c-n{color:var(--muted);opacity:0.45;}
.c-p{color:#fbbf24;}.c-s{font-size:11px;color:var(--purple);}
@media(max-width:640px){.ph-h1{font-size:32px;}.ph-h2{font-size:24px;}}
</style>
