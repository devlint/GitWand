<script setup lang="ts">
type CV = boolean | 'partial' | 'soon'
interface Row {
  category?: boolean; label: string; note?: string; highlight?: boolean
  gw?: CV; gk?: CV; fork?: CV; sm?: CV; ghd?: CV; gb?: CV; tower?: CV
}

// Competitor data fact-checked July 2026. Order matches the deep-dive pages,
// with Tower appended (it has no deep dive but is in the landscape).
const COLS = [
  { key: 'gw',    name: 'GitWand',        sub: 'Free · MIT',        gw: true },
  { key: 'gk',    name: 'GitKraken',      sub: 'Free / ~$5/mo Pro' },
  { key: 'fork',  name: 'Fork',           sub: '$59.99 · Native' },
  { key: 'sm',    name: 'Sublime Merge',  sub: '$99 · Native' },
  { key: 'ghd',   name: 'GitHub Desktop', sub: 'Free · Electron' },
  { key: 'gb',    name: 'GitButler',      sub: 'Free · Tauri/Rust' },
  { key: 'tower', name: 'Tower',          sub: '$69/yr · Native' },
] as const

const ROWS: Row[] = [
  { category: true, label: 'Workflow' },
  { label: 'Free & open source',       gw: true, gk: false,     fork: false, sm: false, ghd: true,      gb: true,  tower: false },
  { label: 'Native app (no Electron)', gw: true, gk: false,     fork: true,  sm: true,  ghd: false,     gb: true,  tower: true  },
  { label: 'Linux support',            gw: true, gk: true,      fork: false, sm: true,  ghd: false,     gb: true,  tower: false },
  { label: 'CLI tool',                 gw: true, gk: true,      fork: false, sm: false, ghd: false,     gb: true,  tower: false },
  { label: 'VS Code extension',        gw: true, gk: true,      fork: false, sm: false, ghd: false,     gb: false, tower: false },

  { category: true, label: 'Conflict resolution' },
  { label: 'Deterministic auto-resolve',        gw: true, gk: 'partial', fork: false, sm: false, ghd: 'partial', gb: false, tower: false, highlight: true },
  { label: 'Confidence score per hunk',         gw: true, gk: false,     fork: false, sm: false, ghd: false,     gb: false, tower: false, highlight: true },
  { label: 'Decision trace per hunk',           gw: true, gk: false,     fork: false, sm: false, ghd: false,     gb: false, tower: false, highlight: true },
  { label: 'Zero-impact merge/rebase preview',  gw: true, gk: false,     fork: false, sm: false, ghd: false,     gb: false, tower: false, highlight: true },
  { label: 'Predict rebase & cherry-pick',      gw: true, gk: false,     fork: false, sm: false, ghd: false,     gb: false, tower: false, highlight: true },
  { label: 'Scratch-worktree resolution',       gw: true, gk: false,     fork: false, sm: false, ghd: false,     gb: false, tower: false, highlight: true },

  { category: true, label: 'Power Git' },
  { label: 'Interactive rebase',        gw: true,  gk: true,  fork: true,  sm: true,  ghd: false, gb: true,  tower: true  },
  { label: 'Split commit by hunks',     gw: true,  gk: false, fork: false, sm: true,  ghd: false, gb: false, tower: false },
  { label: 'Worktrees',                 gw: true,  gk: true,  fork: true,  sm: false, ghd: true,  gb: false, tower: true  },
  { label: 'Virtual / stacked branches',gw: false, gk: false, fork: false, sm: false, ghd: false, gb: true,  tower: false },
  { label: 'Multi-repo workspaces',     gw: true,  gk: true,  fork: true,  sm: false, ghd: false, gb: false, tower: 'partial' },
  { label: 'Cross-repo dashboard',      gw: true,  gk: true,  fork: false, sm: false, ghd: false, gb: false, tower: false },

  { category: true, label: 'Code review & forges' },
  { label: 'In-app PR/MR review',       gw: true, gk: true,  fork: 'partial', sm: false, ghd: 'partial', gb: 'partial', tower: false },
  { label: 'GitHub · GitLab · Bitbucket · Azure', gw: true, gk: true, fork: true, sm: false, ghd: false, gb: false, tower: true },
  { label: 'Inline CI check annotations', gw: true, gk: true, fork: false, sm: false, ghd: false, gb: false, tower: false },

  { category: true, label: 'AI & agents', note: 'GitWand uses the coding-agent CLIs you already have (Claude Code, Codex, opencode…). No built-in model, no account.' },
  { label: 'Launch coding agents in-app', gw: true, gk: true,      fork: false, sm: false, ghd: false,     gb: true,  tower: 'partial' },
  { label: 'MCP server for AI agents',    gw: true, gk: true,      fork: false, sm: false, ghd: false,     gb: true,  tower: false },
  { label: 'AI conflict explanation',     gw: true, gk: 'partial', fork: false, sm: false, ghd: 'partial', gb: false, tower: false },
  { label: 'AI commit messages',          gw: true, gk: true,      fork: true,  sm: false, ghd: true,      gb: 'partial', tower: true },
]

function ic(v?: CV) { return v === true ? '✓' : v === 'partial' ? '~' : v === 'soon' ? 'soon' : '✗' }
function cc(v?: CV) { return v === true ? 'y' : v === 'partial' ? 'p' : v === 'soon' ? 's' : 'n' }
</script>

<template>
  <div class="cmp-block">
    <div class="cmp-wrap">
      <table class="cmp">
        <thead>
          <tr>
            <th></th>
            <th v-for="c in COLS" :key="c.key" :class="{ 'cmp-gw': c.key === 'gw' }">
              {{ c.name }}<span>{{ c.sub }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in ROWS" :key="r.label">
            <tr v-if="r.category" class="cmp-cat">
              <td :colspan="COLS.length + 1">{{ r.label }}<span v-if="r.note" class="cmp-note">{{ r.note }}</span></td>
            </tr>
            <tr v-else :class="{ 'cmp-hl': r.highlight }">
              <td class="cmp-feat">{{ r.label }}<span v-if="r.highlight" class="cmp-uniq">GitWand</span></td>
              <td v-for="c in COLS" :key="c.key" :class="{ 'cmp-gw': c.key === 'gw' }">
                <span :class="'c-' + cc((r as any)[c.key])">{{ ic((r as any)[c.key]) }}</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="cmp-legend"><span class="c-y">✓</span> yes &nbsp; <span class="c-p">~</span> partial &nbsp; <span class="c-n">✗</span> no &nbsp;·&nbsp; Fact-checked July 2026 — spot something off? <a href="https://github.com/devlint/GitWand/issues">open an issue</a>.</p>
  </div>
</template>

<style scoped>
.cmp-block{
  --purple:#8B5CF6;--green:#10B981;
  --bg:#0c0c1a;--border:rgba(124,58,237,0.18);--border-soft:rgba(255,255,255,0.08);
  --text:#e2e8f0;--muted:#94a3b8;
  margin:24px 0;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
.cmp-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--bg);}
.cmp{width:100%;border-collapse:collapse;font-size:13.5px;min-width:760px;color:var(--text);}
.cmp th,.cmp td{padding:11px 13px;text-align:center;border-bottom:1px solid var(--border-soft);}
.cmp thead th{color:var(--muted);font-weight:700;vertical-align:top;}
.cmp thead th span{display:block;font-size:11px;font-weight:500;opacity:0.7;margin-top:3px;}
.cmp thead th.cmp-gw{color:var(--purple);}
.cmp-feat{text-align:left;font-weight:500;color:var(--text);}
.cmp-uniq{margin-left:8px;font-size:10px;color:var(--purple);border:1px solid var(--border);border-radius:6px;padding:1px 6px;white-space:nowrap;}
.cmp-gw{background:rgba(124,58,237,0.09);}
.cmp-cat td{text-align:left;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);background:rgba(255,255,255,0.02);padding-top:18px;}
.cmp-note{display:block;text-transform:none;letter-spacing:0;font-weight:400;font-size:12px;color:var(--muted);margin-top:4px;}
.cmp-hl{background:rgba(124,58,237,0.03);}
.c-y{color:var(--green);font-weight:700;}
.c-n{color:var(--muted);opacity:0.45;}
.c-p{color:#fbbf24;}
.c-s{font-size:11px;color:var(--purple);}
.cmp-legend{font-size:12.5px;color:var(--muted);margin:10px 2px 0;}
.cmp-legend a{color:var(--purple);}
</style>
