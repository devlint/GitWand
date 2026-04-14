<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import {
  getGitLog,
  getGitBranches,
  gitRemoteInfo,
  gitFileCount,
  readFile,
  ghListPrs,
  type GitLogEntry,
  type GitBranch,
  type RemoteInfo,
} from "../utils/backend";
import type { ViewMode } from "../composables/useGitRepo";

const props = defineProps<{
  cwd: string;
  branch: string;
  status: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
  };
  ahead: number;
  behind: number;
}>();

const emit = defineEmits<{
  changeView: [mode: ViewMode];
}>();

// ─── Dashboard data ────────────────────────────────────────
const loading = ref(true);
const recentCommits = ref<GitLogEntry[]>([]);
const branches = ref<GitBranch[]>([]);
const remoteInfo = ref<RemoteInfo | null>(null);
const fileCount = ref(0);
const openPrs = ref(0);
const readmeContent = ref<string | null>(null);
const readmeError = ref(false);
const readmeTab = ref<"formatted" | "raw">("formatted");
const contributorCount = ref(0);
const lastCommitDate = ref("");
const weeklyCommits = ref(0);

// ─── Computed stats ────────────────────────────────────────
const totalChanges = computed(
  () => props.status.staged + props.status.unstaged + props.status.untracked
);
const localBranches = computed(
  () => branches.value.filter((b) => !b.isRemote)
);
const remoteBranches = computed(
  () => branches.value.filter((b) => b.isRemote)
);

// ─── Load dashboard data ───────────────────────────────────
async function loadDashboard() {
  if (!props.cwd) return;
  loading.value = true;

  const results = await Promise.allSettled([
    getGitLog(props.cwd, 50),
    getGitBranches(props.cwd),
    gitRemoteInfo(props.cwd),
    gitFileCount(props.cwd).catch(() => 0),
    ghListPrs(props.cwd, "open").catch(() => []),
    loadReadme(),
  ]);

  // Commits
  if (results[0].status === "fulfilled") {
    recentCommits.value = results[0].value;
    // Unique authors
    const authors = new Set(recentCommits.value.map((c) => c.email));
    contributorCount.value = authors.size;
    // Last commit date
    if (recentCommits.value.length > 0) {
      lastCommitDate.value = recentCommits.value[0].date;
    }
    // Commits in last 7 days
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    weeklyCommits.value = recentCommits.value.filter(
      (c) => new Date(c.date).getTime() > oneWeekAgo
    ).length;
  }
  // Branches
  if (results[1].status === "fulfilled") {
    branches.value = results[1].value;
  }
  // Remote
  if (results[2].status === "fulfilled") {
    remoteInfo.value = results[2].value;
  }
  // File count
  if (results[3].status === "fulfilled") {
    fileCount.value = results[3].value as number;
  }
  // PRs
  if (results[4].status === "fulfilled") {
    openPrs.value = (results[4].value as any[]).length;
  }

  loading.value = false;
}

async function loadReadme() {
  readmeError.value = false;
  // Try common README names
  const candidates = ["README.md", "readme.md", "Readme.md", "README.MD"];
  for (const name of candidates) {
    try {
      readmeContent.value = await readFile(props.cwd, name);
      return;
    } catch {
      // try next
    }
  }
  readmeContent.value = null;
  readmeError.value = true;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

// ─── Markdown → HTML (basic) ───────────────────────────────
function renderMarkdown(md: string): string {
  // ── Phase 0: strip the HTML header block (logo + title + nav + badges)
  // GitHub READMEs often start with raw HTML for centering — we render
  // a clean version ourselves instead of trying to parse it.
  const headerInfo = extractReadmeHeader(md);
  let body = headerInfo.rest;

  let html = body
    // Code blocks (fenced)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
      return `<pre class="md-code-block"><code>${escapeHtml(code.trimEnd())}</code></pre>`;
    })
    // Tables (simple GFM: | col | col |)
    .replace(/(?:^\|.+\|\s*\n)(^\|[-| :]+\|\s*\n)((?:^\|.+\|\s*\n)*)/gm, (_m, _sep, bodyRows, _o, fullStr) => {
      // Re-extract header from the match (line before separator)
      const lines = _m.trim().split("\n");
      const headCells = lines[0].split("|").filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join("");
      const rows = lines.slice(2).map(line => {
        const cells = line.split("|").filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      return `<table class="md-table"><thead><tr>${headCells}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    // Headings (with auto-generated IDs for anchor links)
    .replace(/^######\s+(.+)$/gm, (_m, t) => `<h6 id="${slugify(t)}">${t}</h6>`)
    .replace(/^#####\s+(.+)$/gm, (_m, t) => `<h5 id="${slugify(t)}">${t}</h5>`)
    .replace(/^####\s+(.+)$/gm, (_m, t) => `<h4 id="${slugify(t)}">${t}</h4>`)
    .replace(/^###\s+(.+)$/gm, (_m, t) => `<h3 id="${slugify(t)}">${t}</h3>`)
    .replace(/^##\s+(.+)$/gm, (_m, t) => `<h2 id="${slugify(t)}">${t}</h2>`)
    .replace(/^#\s+(.+)$/gm, (_m, t) => `<h1 id="${slugify(t)}">${t}</h1>`)
    // Checkboxes (must come before generic lists)
    .replace(/^[\s]*[-*]\s+\[x\]\s+(.+)$/gm, '<li class="md-check md-checked">$1</li>')
    .replace(/^[\s]*[-*]\s+\[ \]\s+(.+)$/gm, '<li class="md-check">$1</li>')
    // Bold & italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    // Images (must come BEFORE links to avoid ![...](...) being eaten by link regex)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
      // Skip relative paths that won't resolve in the dashboard context
      if (src.startsWith("assets/") || src.startsWith("./") || src.startsWith("../")) {
        return `<span class="md-img-placeholder" title="${escapeHtml(alt)}">${escapeHtml(alt || "image")}</span>`;
      }
      return `<img src="${src}" alt="${escapeHtml(alt)}" class="md-img">`;
    })
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link">$1</a>')
    // Horizontal rules
    .replace(/^---+$/gm, '<hr class="md-hr">')
    // Unordered lists
    .replace(/^[\s]*[-*]\s+(.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^[\s]*\d+\.\s+(.+)$/gm, '<li>$1</li>')
    // Blockquote
    .replace(/^>\s+(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>')
    // Passthrough remaining HTML blocks (img, a, p, div, details, summary)
    // Already valid HTML → keep as-is

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, "<ul>$1</ul>");

  // Paragraphs — wrap standalone lines
  html = html
    .split("\n\n")
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (
        trimmed.startsWith("<h") ||
        trimmed.startsWith("<p") ||
        trimmed.startsWith("<pre") ||
        trimmed.startsWith("<ul") ||
        trimmed.startsWith("<ol") ||
        trimmed.startsWith("<table") ||
        trimmed.startsWith("<blockquote") ||
        trimmed.startsWith("<hr") ||
        trimmed.startsWith("<li") ||
        trimmed.startsWith("<img") ||
        trimmed.startsWith("<div") ||
        trimmed.startsWith("<details")
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return headerInfo.headerHtml + html;
}

/**
 * Extract the GitHub-style HTML header from a README:
 * logo image, title, tagline, navigation links, badges.
 * Returns clean rendered HTML + the remaining markdown body.
 */
function extractReadmeHeader(md: string): { headerHtml: string; rest: string } {
  // Detect HTML header blocks: lines starting with < until we hit a markdown
  // heading (## ...) or a line that doesn't start with < and isn't blank
  const lines = md.split("\n");
  let headerEnd = 0;
  let inHtmlBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { headerEnd = i + 1; continue; }
    if (line.startsWith("<")) { inHtmlBlock = true; headerEnd = i + 1; continue; }
    if (line === "---") { headerEnd = i + 1; break; }
    if (inHtmlBlock && !line.startsWith("#")) { headerEnd = i + 1; continue; }
    break;
  }

  if (headerEnd === 0) return { headerHtml: "", rest: md };

  const headerBlock = lines.slice(0, headerEnd).join("\n");
  const rest = lines.slice(headerEnd).join("\n");

  // Parse out useful bits from the HTML header
  const imgMatch = headerBlock.match(/<img[^>]+src="([^"]+)"[^>]*>/);
  const titleMatch = headerBlock.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const strongMatch = headerBlock.match(/<strong>([^<]+)<\/strong>/);

  // Extract nav links: <a href="...">text</a>
  const navLinks: { text: string; href: string }[] = [];
  const navRegex = /<a\s+href="([^"]+)">([^<]+)<\/a>/g;
  let navMatch;
  while ((navMatch = navRegex.exec(headerBlock)) !== null) {
    navLinks.push({ href: navMatch[1], text: navMatch[2] });
  }

  // Extract badges: <img alt="..." src="...">
  const badges: { alt: string; src: string }[] = [];
  const badgeRegex = /<img\s+alt="([^"]*)"[^>]*src="([^"]+)"[^>]*>/g;
  let badgeMatch;
  while ((badgeMatch = badgeRegex.exec(headerBlock)) !== null) {
    if (badgeMatch[2].includes("shields.io") || badgeMatch[2].includes("badge")) {
      badges.push({ alt: badgeMatch[1], src: badgeMatch[2] });
    }
  }

  // Build clean header HTML
  let headerHtml = '<div class="md-readme-header">';

  if (titleMatch) {
    headerHtml += `<h1 class="md-readme-title">${titleMatch[1]}</h1>`;
  }
  if (strongMatch) {
    headerHtml += `<p class="md-readme-tagline">${strongMatch[1]}</p>`;
  }
  if (navLinks.length > 0) {
    headerHtml += `<nav class="md-readme-nav">${navLinks.map(l => `<a href="${l.href}" class="md-link">${l.text}</a>`).join('<span class="md-readme-sep">&bull;</span>')}</nav>`;
  }
  if (badges.length > 0) {
    headerHtml += `<div class="md-readme-badges">${badges.map(b => `<img src="${b.src}" alt="${b.alt}" class="md-badge">`).join(" ")}</div>`;
  }

  headerHtml += '</div>';

  return { headerHtml, rest };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")       // strip HTML tags
    .replace(/[^\w\s-]/g, "")      // remove non-word chars
    .replace(/\s+/g, "-")          // spaces → hyphens
    .replace(/-+/g, "-")           // collapse hyphens
    .trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

onMounted(loadDashboard);
watch(() => props.cwd, loadDashboard);
</script>

<template>
  <div class="dashboard">
    <!-- Loading skeleton -->
    <div v-if="loading" class="dashboard-loading">
      <div class="spinner"></div>
      <span>Loading dashboard…</span>
    </div>

    <template v-else>
      <!-- Stat cards grid -->
      <div class="stats-grid">
        <!-- Commits this week -->
        <button class="stat-card" @click="emit('changeView', 'history')">
          <div class="stat-icon stat-icon--accent">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M9 2v4M9 12v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ weeklyCommits }}</span>
            <span class="stat-label">Commits (7d)</span>
          </div>
        </button>

        <!-- Branches -->
        <button class="stat-card" @click="emit('changeView', 'graph')">
          <div class="stat-icon stat-icon--info">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="13" cy="5" r="2" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="9" cy="14" r="2" stroke="currentColor" stroke-width="1.5"/>
              <path d="M5 7v3a4 4 0 004 4M13 7v3a4 4 0 01-4 4" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ localBranches.length }}</span>
            <span class="stat-label">Branches</span>
          </div>
        </button>

        <!-- Contributors -->
        <div class="stat-card">
          <div class="stat-icon stat-icon--success">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="6" r="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M3 16c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ contributorCount }}</span>
            <span class="stat-label">Contributors</span>
          </div>
        </div>

        <!-- Working tree -->
        <button class="stat-card" :class="{ 'stat-card--alert': totalChanges > 0 }" @click="emit('changeView', 'changes')">
          <div class="stat-icon" :class="totalChanges > 0 ? 'stat-icon--warning' : 'stat-icon--muted'">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M10 2H5a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7l-5-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M10 2v5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ totalChanges }}</span>
            <span class="stat-label">Changes</span>
          </div>
          <div v-if="totalChanges > 0" class="stat-breakdown">
            <span v-if="status.staged > 0" class="stat-pill stat-pill--success">{{ status.staged }} staged</span>
            <span v-if="status.unstaged > 0" class="stat-pill stat-pill--warning">{{ status.unstaged }} modified</span>
            <span v-if="status.untracked > 0" class="stat-pill stat-pill--muted">{{ status.untracked }} new</span>
          </div>
        </button>

        <!-- Tracked files -->
        <div class="stat-card">
          <div class="stat-icon stat-icon--muted">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
              <path d="M5 6h8M5 9h6M5 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ formatNumber(fileCount) }}</span>
            <span class="stat-label">Files tracked</span>
          </div>
        </div>

        <!-- Open PRs -->
        <button class="stat-card" @click="emit('changeView', 'prs')">
          <div class="stat-icon" :class="openPrs > 0 ? 'stat-icon--accent' : 'stat-icon--muted'">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="6" cy="5" r="2" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="12" cy="13" r="2" stroke="currentColor" stroke-width="1.5"/>
              <path d="M6 7v6M12 5v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ openPrs }}</span>
            <span class="stat-label">Open PRs</span>
          </div>
        </button>
      </div>

      <!-- Sync status bar -->
      <div class="sync-bar" v-if="ahead > 0 || behind > 0">
        <span v-if="ahead > 0" class="sync-pill sync-pill--ahead">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 2v8M3 5l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {{ ahead }} ahead
        </span>
        <span v-if="behind > 0" class="sync-pill sync-pill--behind">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 10V2M3 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {{ behind }} behind
        </span>
      </div>

      <!-- Recent activity -->
      <div class="section-row">
        <!-- Recent commits -->
        <div class="card recent-commits">
          <div class="card-header">
            <h3 class="card-title">Recent commits</h3>
            <button class="card-link" @click="emit('changeView', 'history')">
              View all
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <ul class="commit-list">
            <li
              v-for="c in recentCommits.slice(0, 8)"
              :key="c.hashFull"
              class="commit-item"
            >
              <code class="commit-hash">{{ c.hash }}</code>
              <span class="commit-msg">{{ c.message }}</span>
              <span class="commit-meta">
                <span class="commit-author">{{ c.author }}</span>
                <span class="commit-date">{{ formatDate(c.date) }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>

      <!-- README card -->
      <div class="card readme-card" v-if="readmeContent !== null">
        <div class="card-header">
          <h3 class="card-title">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 3h5l1 1h6v9H2V3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
            </svg>
            README.md
          </h3>
          <div class="readme-tabs">
            <button
              class="readme-tab"
              :class="{ 'readme-tab--active': readmeTab === 'formatted' }"
              @click="readmeTab = 'formatted'"
            >
              Formatted
            </button>
            <button
              class="readme-tab"
              :class="{ 'readme-tab--active': readmeTab === 'raw' }"
              @click="readmeTab = 'raw'"
            >
              Raw
            </button>
          </div>
        </div>
        <div class="readme-body">
          <div
            v-if="readmeTab === 'formatted'"
            class="readme-formatted"
            v-html="renderMarkdown(readmeContent)"
          />
          <pre v-else class="readme-raw"><code>{{ readmeContent }}</code></pre>
        </div>
      </div>

      <div class="card readme-empty" v-else-if="readmeError">
        <div class="readme-empty-inner">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
            <path d="M8 9h8M8 12h6M8 15h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
          </svg>
          <span>No README.md found in this repository</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dashboard {
  padding: var(--space-8) var(--space-9);
  overflow-y: auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}

.dashboard-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  height: 200px;
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
}

/* ─── Stats grid ─────────────────────────────────────── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: var(--space-5);
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-6);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  cursor: default;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  text-align: left;
  font-family: inherit;
  color: inherit;
}

button.stat-card {
  cursor: pointer;
}

button.stat-card:hover {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.stat-card--alert {
  border-color: var(--color-warning);
}

.stat-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
}

.stat-icon--accent {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.stat-icon--info {
  background: var(--color-info-soft);
  color: var(--color-info);
}

.stat-icon--success {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.stat-icon--warning {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.stat-icon--muted {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.stat-value {
  font-size: var(--font-size-3xl);
  font-weight: 700;
  line-height: 1;
  color: var(--color-text);
}

.stat-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.stat-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.stat-pill {
  font-size: var(--font-size-sm);
  padding: 1px var(--space-3);
  border-radius: var(--radius-pill);
  font-weight: 500;
}

.stat-pill--success {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.stat-pill--warning {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.stat-pill--muted {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

/* ─── Sync bar ───────────────────────────────────────── */
.sync-bar {
  display: flex;
  gap: var(--space-3);
}

.sync-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  font-weight: 600;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-pill);
}

.sync-pill--ahead {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.sync-pill--behind {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

/* ─── Cards ──────────────────────────────────────────── */
.section-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-5);
}

.card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--color-border);
}

.card-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.card-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast);
}

.card-link:hover {
  background: var(--color-accent-soft);
}

/* ─── Recent commits ─────────────────────────────────── */
.commit-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.commit-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
}

.commit-item:last-child {
  border-bottom: none;
}

.commit-hash {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
}

.commit-msg {
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-meta {
  display: flex;
  gap: var(--space-3);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.commit-author {
  font-weight: 500;
}

/* ─── README card ────────────────────────────────────── */
.readme-card {
  flex: 1;
  min-height: 200px;
  display: flex;
  flex-direction: column;
}

.readme-tabs {
  display: flex;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-pill);
  padding: 2px;
}

.readme-tab {
  font-size: var(--font-size-sm);
  font-weight: 500;
  padding: var(--space-1) var(--space-4);
  border-radius: var(--radius-pill);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.readme-tab--active {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  box-shadow: var(--shadow-xs);
}

.readme-body {
  flex: 1;
  overflow-y: auto;
  max-height: 500px;
}

.readme-formatted {
  padding: var(--space-6) var(--space-7);
  font-size: var(--font-size-md);
  line-height: 1.65;
  color: var(--color-text);
}

.readme-formatted :deep(h1) {
  font-size: var(--font-size-3xl);
  font-weight: 700;
  margin: 0 0 var(--space-5) 0;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.readme-formatted :deep(h2) {
  font-size: var(--font-size-xl);
  font-weight: 600;
  margin: var(--space-7) 0 var(--space-4) 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.readme-formatted :deep(h3) {
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin: var(--space-6) 0 var(--space-3) 0;
}

.readme-formatted :deep(h4),
.readme-formatted :deep(h5),
.readme-formatted :deep(h6) {
  font-size: var(--font-size-md);
  font-weight: 600;
  margin: var(--space-5) 0 var(--space-2) 0;
}

.readme-formatted :deep(p) {
  margin: 0 0 var(--space-4) 0;
}

.readme-formatted :deep(ul),
.readme-formatted :deep(ol) {
  margin: 0 0 var(--space-4) 0;
  padding-left: var(--space-7);
}

.readme-formatted :deep(li) {
  margin-bottom: var(--space-2);
}

.readme-formatted :deep(.md-code-block) {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-5);
  overflow-x: auto;
  margin: 0 0 var(--space-4) 0;
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.readme-formatted :deep(.md-inline-code) {
  background: var(--color-bg-tertiary);
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 0.9em;
}

.readme-formatted :deep(.md-link) {
  color: var(--color-accent);
  text-decoration: none;
}

.readme-formatted :deep(.md-link:hover) {
  text-decoration: underline;
}

.readme-formatted :deep(.md-blockquote) {
  border-left: 3px solid var(--color-accent-soft);
  padding-left: var(--space-5);
  color: var(--color-text-muted);
  margin: 0 0 var(--space-4) 0;
}

.readme-formatted :deep(.md-hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: var(--space-6) 0;
}

.readme-formatted :deep(strong) {
  font-weight: 600;
}

/* ─── README header (parsed from HTML header block) ─── */
.readme-formatted :deep(.md-readme-header) {
  text-align: center;
  padding: var(--space-7) 0 var(--space-5);
  margin-bottom: var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.readme-formatted :deep(.md-readme-title) {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  margin: 0 0 var(--space-3);
}

.readme-formatted :deep(.md-readme-tagline) {
  color: var(--color-text-muted);
  font-size: var(--font-size-md);
  margin: 0 0 var(--space-5);
}

.readme-formatted :deep(.md-readme-nav) {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-5);
  font-size: var(--font-size-sm);
}

.readme-formatted :deep(.md-readme-sep) {
  color: var(--color-text-subtle);
  margin: 0 var(--space-1);
}

.readme-formatted :deep(.md-readme-badges) {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.readme-formatted :deep(.md-badge) {
  height: 20px;
}

/* ─── Tables ─── */
.readme-formatted :deep(.md-table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 var(--space-5) 0;
  font-size: var(--font-size-sm);
}

.readme-formatted :deep(.md-table th),
.readme-formatted :deep(.md-table td) {
  text-align: left;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
}

.readme-formatted :deep(.md-table th) {
  background: var(--color-bg-tertiary);
  font-weight: var(--font-weight-semibold);
}

.readme-formatted :deep(.md-table tr:nth-child(even) td) {
  background: var(--color-bg);
}

/* ─── Checkboxes ─── */
.readme-formatted :deep(.md-check) {
  list-style: none;
  margin-left: calc(-1 * var(--space-7));
  padding-left: 0;
}

.readme-formatted :deep(.md-check::before) {
  content: "☐ ";
  color: var(--color-text-muted);
}

.readme-formatted :deep(.md-checked::before) {
  content: "☑ ";
  color: var(--color-success);
}

/* ─── Images ─── */
.readme-formatted :deep(.md-img) {
  max-width: 100%;
  border-radius: var(--radius-md);
  margin: var(--space-3) 0;
}

.readme-formatted :deep(.md-img-placeholder) {
  display: none; /* Hide broken relative images gracefully */
}

.readme-raw {
  padding: var(--space-6) var(--space-7);
  margin: 0;
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--color-text-muted);
  background: var(--color-bg);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.readme-raw code {
  font-family: inherit;
}

.readme-empty {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
}

.readme-empty-inner {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-7) var(--space-8);
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
}
</style>
