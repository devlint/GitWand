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
import { useI18n } from "../composables/useI18n";
import { useAIProvider } from "../composables/useAIProvider";
import { useReleaseNotes, latestTag as findLatestTag } from "../composables/useReleaseNotes";

const { t, locale } = useI18n();
const ai = useAIProvider();
const {
  isGenerating: isGeneratingReleaseNotes,
  generate: generateReleaseNotes,
  lastError: releaseNotesError,
} = useReleaseNotes();

// ─── Release notes modal (Phase 1.3.4) ────────────────────
const releaseNotesOpen = ref(false);
const releaseNotesFrom = ref("");
const releaseNotesTo = ref("HEAD");
const releaseNotesMarkdown = ref("");
const releaseNotesCopied = ref(false);

async function openReleaseNotes() {
  releaseNotesMarkdown.value = "";
  releaseNotesTo.value = "HEAD";
  releaseNotesCopied.value = false;
  const tag = await findLatestTag(props.cwd);
  releaseNotesFrom.value = tag || "";
  releaseNotesOpen.value = true;
}

function closeReleaseNotes() {
  releaseNotesOpen.value = false;
}

async function runGenerateReleaseNotes() {
  releaseNotesCopied.value = false;
  try {
    const md = await generateReleaseNotes(
      props.cwd,
      releaseNotesFrom.value,
      releaseNotesTo.value,
      { locale: locale.value },
    );
    releaseNotesMarkdown.value = md;
  } catch {
    releaseNotesMarkdown.value = "";
  }
}

async function copyReleaseNotes() {
  if (!releaseNotesMarkdown.value) return;
  try {
    await navigator.clipboard.writeText(releaseNotesMarkdown.value);
    releaseNotesCopied.value = true;
    setTimeout(() => {
      releaseNotesCopied.value = false;
    }, 1500);
  } catch {
    // ignore — clipboard permissions may not be granted in some envs
  }
}

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
  /** True when the current branch has no upstream configured. */
  needsPublish?: boolean;
}>();

const emit = defineEmits<{
  changeView: [mode: ViewMode];
  sync: [];
  push: [];
}>();

// ─── Dashboard data ────────────────────────────────────────
const loading = ref(true);
const recentCommits = ref<GitLogEntry[]>([]);
const branches = ref<GitBranch[]>([]);
const remoteInfo = ref<RemoteInfo | null>(null);
const fileCount = ref(0);
const openPrs = ref(0);
const mergedPrs = ref(0);
const readmeContent = ref<string | null>(null);
const readmeError = ref(false);
const readmeTab = ref<"formatted" | "raw">("formatted");
const contributorCount = ref(0);
const lastCommitDate = ref("");
const weeklyCommits = ref(0);
const previousWeekCommits = ref(0);

// ─── Computed stats ────────────────────────────────────────
const totalChanges = computed(
  () => props.status.staged + props.status.unstaged + props.status.untracked
);
const localBranches = computed(
  () => branches.value.filter((b) => !b.isRemote)
);

/** Commits per day for the last 7 days (oldest → newest). Used for sparkline. */
const sparklinePoints = computed(() => {
  const counts = new Array(7).fill(0);
  const now = Date.now();
  for (const c of recentCommits.value) {
    const daysAgo = Math.floor((now - new Date(c.date).getTime()) / (24 * 3600 * 1000));
    if (daysAgo >= 0 && daysAgo < 7) counts[6 - daysAgo]++;
  }
  return counts;
});

/** Trend vs previous 7d: positive means acceleration. */
const commitTrendPct = computed(() => {
  if (previousWeekCommits.value === 0) {
    return weeklyCommits.value > 0 ? 100 : 0;
  }
  return Math.round(
    ((weeklyCommits.value - previousWeekCommits.value) / previousWeekCommits.value) * 100
  );
});

/** Commits grouped by type (feat, fix, docs, chore, other) based on conventional prefix. */
const commitsByType = computed(() => {
  const buckets = { feat: 0, fix: 0, docs: 0, chore: 0, other: 0 };
  for (const c of recentCommits.value) {
    const prefix = c.message.toLowerCase().match(/^(feat|fix|docs|chore|refactor|test|style|perf|build|ci)/);
    const key = prefix?.[1] ?? "other";
    if (key === "feat") buckets.feat++;
    else if (key === "fix") buckets.fix++;
    else if (key === "docs") buckets.docs++;
    else if (key === "other") buckets.other++;
    else buckets.chore++; // everything else (refactor, test, chore, …)
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
  return {
    ...buckets,
    total,
    featPct: Math.round((buckets.feat / total) * 100),
    fixPct: Math.round((buckets.fix / total) * 100),
    docsPct: Math.round((buckets.docs / total) * 100),
    chorePct: Math.round((buckets.chore / total) * 100),
    otherPct: Math.round((buckets.other / total) * 100),
  };
});

/** Top contributors (max 3) with commit count in the loaded window. */
const topContributors = computed(() => {
  const counts = new Map<string, { name: string; email: string; count: number }>();
  for (const c of recentCommits.value) {
    const key = c.email || c.author;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { name: c.author, email: c.email, count: 1 });
  }
  const list = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  const max = list[0]?.count ?? 1;
  return list.slice(0, 4).map((c) => ({ ...c, pct: Math.round((c.count / max) * 100) }));
});

/** Commits per day for the last 14 days (oldest → newest). Used for bar chart. */
const barChartDays = computed(() => {
  const days: { count: number; label: string; isWeekend: boolean }[] = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (let i = 13; i >= 0; i--) {
    const day = new Date(now);
    day.setDate(day.getDate() - i);
    const dayStart = day.getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;
    const count = recentCommits.value.filter((c) => {
      const t = new Date(c.date).getTime();
      return t >= dayStart && t < dayEnd;
    }).length;
    const dow = day.getDay();
    days.push({
      count,
      label: ["D", "L", "M", "M", "J", "V", "S"][dow],
      isWeekend: dow === 0 || dow === 6,
    });
  }
  return days;
});

const barChartMax = computed(() => Math.max(1, ...barChartDays.value.map((d) => d.count)));

/** Heatmap: 7 rows (Mon-Sun) × 26 columns (weeks). Values are commit counts. */
const heatmapCells = computed(() => {
  // Build a map of YYYY-MM-DD → count
  const counts = new Map<string, number>();
  for (const c of recentCommits.value) {
    const d = new Date(c.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Start: 26 weeks ago, aligned on Monday
  const start = new Date(today);
  start.setDate(start.getDate() - 26 * 7);
  // Align to Monday
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);

  const cols: { week: string; cells: { date: string; count: number; level: number }[] }[] = [];
  for (let w = 0; w < 26; w++) {
    const weekCells = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(day.getDate() + w * 7 + d);
      if (day > today) {
        weekCells.push({ date: "", count: 0, level: 0 });
        continue;
      }
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const count = counts.get(key) ?? 0;
      let level = 0;
      if (count >= 10) level = 4;
      else if (count >= 5) level = 3;
      else if (count >= 2) level = 2;
      else if (count >= 1) level = 1;
      weekCells.push({ date: key, count, level });
    }
    cols.push({ week: `w${w}`, cells: weekCells });
  }
  return cols;
});

/** Month labels to position under the heatmap (locale-aware). */
const heatmapMonths = computed(() => {
  const today = new Date();
  const locale = typeof navigator !== "undefined" ? navigator.language : "fr-FR";
  const labels: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    labels.push(d.toLocaleDateString(locale, { month: "short" }));
  }
  return labels;
});

/** Smooth polyline points string for the sparkline (viewBox 100x24). */
const sparklinePath = computed(() => {
  const vals = sparklinePoints.value;
  const max = Math.max(1, ...vals);
  const step = 100 / (vals.length - 1);
  return vals.map((v, i) => `${(i * step).toFixed(1)},${(22 - (v / max) * 18).toFixed(1)}`).join(" ");
});

const sparklineArea = computed(() => `${sparklinePath.value} 100,24 0,24`);

/** Health score — lightweight heuristic: penalties for conflicts, stale divergence, dirty tree. */
const healthScore = computed(() => {
  let score = 100;
  if (props.status.conflicted > 0) score -= 30;
  if (props.behind > 20) score -= 15;
  else if (props.behind > 5) score -= 8;
  if (totalChanges.value > 30) score -= 10;
  if (weeklyCommits.value === 0) score -= 5;
  return Math.max(0, Math.min(100, score));
});

const healthLabel = computed(() => {
  const s = healthScore.value;
  if (s >= 90) return t("dashboard.healthExcellent");
  if (s >= 70) return t("dashboard.healthGood");
  if (s >= 50) return t("dashboard.healthFair");
  return t("dashboard.healthPoor");
});

/** Suggested next action based on repo state. */
const nextAction = computed(() => {
  if (props.status.conflicted > 0) {
    return { label: t("dashboard.nextResolveConflicts", props.status.conflicted), view: "changes" as ViewMode, action: null };
  }
  if (totalChanges.value > 0) {
    return { label: t("dashboard.nextCommit", totalChanges.value), view: "changes" as ViewMode, action: null };
  }
  if (props.ahead > 0) {
    return { label: t("dashboard.nextPush", props.ahead), view: null, action: "push" as const };
  }
  if (props.needsPublish) {
    return { label: t("dashboard.nextPublish"), view: null, action: "push" as const };
  }
  if (props.behind > 0) {
    return { label: t("dashboard.nextSync", props.behind), view: null, action: "sync" as const };
  }
  if (openPrs.value > 0) {
    return { label: t("dashboard.nextReviewPrs", openPrs.value), view: "prs" as ViewMode, action: null };
  }
  return { label: t("dashboard.nextAllCaughtUp"), view: "history" as ViewMode, action: null };
});

function runNextAction() {
  if (nextAction.value.action === "push") emit("push");
  else if (nextAction.value.action === "sync") emit("sync");
  else if (nextAction.value.view) emit("changeView", nextAction.value.view);
}

/** Deterministic hue for an avatar from a string (same author → same color). */
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function avatarStyle(key: string) {
  const h = hueFor(key);
  return {
    background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 45%))`,
  };
}

function initials(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Detect conventional-commit type for tag colouring. */
function commitType(msg: string): string {
  const m = msg.toLowerCase().match(/^(feat|fix|docs|chore|refactor|test|style|perf|build|ci)/);
  return m?.[1] ?? "";
}

/** Message stripped of its `type(scope):` prefix for cleaner display. */
function commitMessageBody(msg: string): string {
  return msg.replace(/^(feat|fix|docs|chore|refactor|test|style|perf|build|ci)(\([^)]+\))?:\s*/i, "");
}

// ─── Load dashboard data ───────────────────────────────────
async function loadDashboard() {
  if (!props.cwd) return;
  loading.value = true;

  const results = await Promise.allSettled([
    getGitLog(props.cwd, 250),
    getGitBranches(props.cwd),
    gitRemoteInfo(props.cwd),
    gitFileCount(props.cwd).catch(() => 0),
    ghListPrs(props.cwd, "open").catch(() => []),
    ghListPrs(props.cwd, "merged").catch(() => []),
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
    // Commits in last 7 days + previous 7 days for trend
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    weeklyCommits.value = recentCommits.value.filter(
      (c) => now - new Date(c.date).getTime() < weekMs
    ).length;
    previousWeekCommits.value = recentCommits.value.filter((c) => {
      const diff = now - new Date(c.date).getTime();
      return diff >= weekMs && diff < 2 * weekMs;
    }).length;
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
  // PRs (open + merged for the "N merged this week" hint)
  if (results[4].status === "fulfilled") {
    openPrs.value = (results[4].value as any[]).length;
  }
  if (results[5].status === "fulfilled") {
    const list = results[5].value as any[];
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    mergedPrs.value = list.filter((p) => {
      const d = p.mergedAt || p.closedAt || p.updatedAt;
      return d && new Date(d).getTime() > weekAgo;
    }).length;
  }

  loading.value = false;
}

async function loadReadme() {
  readmeError.value = false;
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
  if (diffMins < 1) return t("date.now");
  if (diffMins < 60) return t("date.minutesAgo", diffMins);
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return t("date.hoursAgo", diffHrs);
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return t("date.daysAgo", diffDays);
  return d.toLocaleDateString();
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

// ─── Markdown → HTML (basic) ───────────────────────────────
function renderMarkdown(md: string): string {
  const headerInfo = extractReadmeHeader(md);
  let body = headerInfo.rest;

  // Code blocks are replaced with opaque placeholders BEFORE any other
  // markdown transformation runs. Otherwise shell comments inside them
  // (like `# Browser dev mode`) get picked up by the H1 regex below
  // and rendered as huge headings.
  const codeBlocks: string[] = [];
  body = body.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const placeholder = `\u0000CODE_BLOCK_${codeBlocks.length}\u0000`;
    codeBlocks.push(`<pre class="md-code-block"><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return placeholder;
  });

  // Also strip HTML comments early — the README often uses them as
  // section dividers, and we don't want them dumped as raw text.
  body = body.replace(/<!--[\s\S]*?-->/g, "");

  let html = body
    .replace(/(?:^\|.+\|\s*\n)(^\|[-| :]+\|\s*\n)((?:^\|.+\|\s*\n)*)/gm, (_m) => {
      const lines = _m.trim().split("\n");
      const headCells = lines[0].split("|").filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join("");
      const rows = lines.slice(2).map(line => {
        const cells = line.split("|").filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      return `<table class="md-table"><thead><tr>${headCells}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .replace(/^######\s+(.+)$/gm, (_m, t) => `<h6 id="${slugify(t)}">${t}</h6>`)
    .replace(/^#####\s+(.+)$/gm, (_m, t) => `<h5 id="${slugify(t)}">${t}</h5>`)
    .replace(/^####\s+(.+)$/gm, (_m, t) => `<h4 id="${slugify(t)}">${t}</h4>`)
    .replace(/^###\s+(.+)$/gm, (_m, t) => `<h3 id="${slugify(t)}">${t}</h3>`)
    .replace(/^##\s+(.+)$/gm, (_m, t) => `<h2 id="${slugify(t)}">${t}</h2>`)
    .replace(/^#\s+(.+)$/gm, (_m, t) => `<h1 id="${slugify(t)}">${t}</h1>`)
    .replace(/^[\s]*[-*]\s+\[x\]\s+(.+)$/gm, '<li class="md-check md-checked">$1</li>')
    .replace(/^[\s]*[-*]\s+\[ \]\s+(.+)$/gm, '<li class="md-check">$1</li>')
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
      if (src.startsWith("assets/") || src.startsWith("./") || src.startsWith("../")) {
        return `<span class="md-img-placeholder" title="${escapeHtml(alt)}">${escapeHtml(alt || "image")}</span>`;
      }
      return `<img src="${src}" alt="${escapeHtml(alt)}" class="md-img">`;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link">$1</a>')
    .replace(/^---+$/gm, '<hr class="md-hr">')
    .replace(/^[\s]*[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/^[\s]*\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/^>\s+(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

  html = html.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, "<ul>$1</ul>");

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

  // Restore the code blocks last.
  html = html.replace(/\u0000CODE_BLOCK_(\d+)\u0000/g, (_m, idx) => {
    const i = parseInt(idx, 10);
    return codeBlocks[i] ?? "";
  });

  return headerInfo.headerHtml + html;
}

function extractReadmeHeader(md: string): { headerHtml: string; rest: string } {
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

  const titleMatch = headerBlock.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const strongMatch = headerBlock.match(/<strong>([^<]+)<\/strong>/);

  const navLinks: { text: string; href: string }[] = [];
  const navRegex = /<a\s+href="([^"]+)">([^<]+)<\/a>/g;
  let navMatch;
  while ((navMatch = navRegex.exec(headerBlock)) !== null) {
    navLinks.push({ href: navMatch[1], text: navMatch[2] });
  }

  const badges: { alt: string; src: string }[] = [];
  const badgeRegex = /<img\s+alt="([^"]*)"[^>]*src="([^"]+)"[^>]*>/g;
  let badgeMatch;
  while ((badgeMatch = badgeRegex.exec(headerBlock)) !== null) {
    if (badgeMatch[2].includes("shields.io") || badgeMatch[2].includes("badge")) {
      badges.push({ alt: badgeMatch[1], src: badgeMatch[2] });
    }
  }

  let headerHtml = '<div class="md-readme-header">';
  if (titleMatch) headerHtml += `<h1 class="md-readme-title">${titleMatch[1]}</h1>`;
  if (strongMatch) headerHtml += `<p class="md-readme-tagline">${strongMatch[1]}</p>`;
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
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
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
      <span>{{ t("dashboard.loading") }}</span>
    </div>

    <template v-else>
      <!-- ─── Hero row ───────────────────────────────────── -->
      <section class="hero">
        <!-- Card 1: Repo state -->
        <div class="hero-card hero-card--primary">
          <div class="hero-eyebrow">{{ t("dashboard.repoState") }}</div>
          <h2 class="hero-title">
            <template v-if="status.conflicted > 0">{{ t("dashboard.stateConflicts") }}</template>
            <template v-else-if="totalChanges > 0">{{ t("dashboard.stateDirty", totalChanges) }}</template>
            <template v-else-if="ahead > 0">{{ t("dashboard.stateAhead", ahead) }}</template>
            <template v-else-if="behind > 0">{{ t("dashboard.stateBehind", behind) }}</template>
            <template v-else>{{ t("dashboard.stateClean") }}</template>
          </h2>
          <p class="hero-sub">
            <template v-if="ahead > 0 || behind > 0">
              {{ t("dashboard.stateVsRemote", branch) }}
            </template>
            <template v-else>{{ t("dashboard.stateOnBranch", branch) }}</template>
          </p>
          <div class="hero-chips">
            <span class="chip" :class="status.conflicted > 0 ? 'chip--danger' : 'chip--success'">
              ● {{ status.conflicted > 0 ? t("dashboard.chipConflicts", status.conflicted) : t("dashboard.chipNoConflict") }}
            </span>
            <span class="chip chip--info" v-if="ahead > 0">↑ {{ t("dashboard.chipAhead", ahead) }}</span>
            <span class="chip" v-else>↑ 0</span>
            <span class="chip chip--warning" v-if="behind > 0">↓ {{ t("dashboard.chipBehind", behind) }}</span>
            <span class="chip" v-else>↓ 0</span>
          </div>
        </div>

        <!-- Card 2: Health score -->
        <div class="hero-card">
          <div class="hero-eyebrow">{{ t("dashboard.healthTitle") }}</div>
          <div class="health-score" :class="{
            'health-score--good': healthScore >= 70,
            'health-score--fair': healthScore >= 50 && healthScore < 70,
            'health-score--poor': healthScore < 50,
          }">
            {{ healthScore }}<span class="health-denom">/100</span>
          </div>
          <p class="hero-sub">{{ healthLabel }}</p>
          <div class="health-bar">
            <span :style="{ width: healthScore + '%' }"></span>
          </div>
        </div>

        <!-- Card 3: Next action -->
        <div class="hero-card">
          <div class="hero-eyebrow">{{ t("dashboard.nextStep") }}</div>
          <div class="next-title">{{ nextAction.label }}</div>
          <p class="hero-sub" v-if="lastCommitDate">
            {{ t("dashboard.lastActivity") }} {{ formatDate(lastCommitDate) }}
          </p>
          <button class="btn-hero" @click="runNextAction">
            {{ t("dashboard.openAction") }} →
          </button>
        </div>
      </section>

      <!-- ─── Metric cards ──────────────────────────────── -->
      <section class="stats-grid">
        <!-- Commits 7d with sparkline -->
        <button class="stat-card" @click="emit('changeView', 'history')">
          <div class="stat-head">
            <div class="stat-icon stat-icon--accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <span v-if="commitTrendPct !== 0" class="trend" :class="commitTrendPct > 0 ? 'trend--up' : 'trend--down'">
              {{ commitTrendPct > 0 ? "▲" : "▼" }} {{ Math.abs(commitTrendPct) }}%
            </span>
          </div>
          <div class="stat-value">{{ weeklyCommits }}</div>
          <div class="stat-label">{{ t("dashboard.metricCommits") }}</div>
          <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none">
            <polyline
              :points="sparklineArea"
              fill="var(--color-accent-soft)"
              stroke="none"
            />
            <polyline
              :points="sparklinePath"
              fill="none"
              stroke="var(--color-accent)"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <!-- Branches -->
        <button class="stat-card" @click="emit('changeView', 'graph')">
          <div class="stat-head">
            <div class="stat-icon stat-icon--info">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/>
                <path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>
              </svg>
            </div>
          </div>
          <div class="stat-value">{{ localBranches.length }}</div>
          <div class="stat-label">{{ t("dashboard.metricBranches") }}</div>
          <div class="bullet-row">
            <div class="bullet bullet--success" :style="{ flex: Math.max(1, localBranches.length) }"></div>
            <div class="bullet bullet--warning" :style="{ flex: branches.length - localBranches.length || 0.001 }"></div>
          </div>
        </button>

        <!-- Contributors -->
        <div class="stat-card">
          <div class="stat-head">
            <div class="stat-icon stat-icon--success">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>
              </svg>
            </div>
          </div>
          <div class="stat-value">{{ contributorCount }}</div>
          <div class="stat-label">{{ t("dashboard.metricContributors") }}</div>
          <div class="avatar-stack">
            <span
              v-for="(c, i) in topContributors.slice(0, 4)"
              :key="c.email"
              class="avatar avatar--sm"
              :style="{ ...avatarStyle(c.email || c.name), zIndex: 10 - i }"
              :title="c.name"
            >{{ initials(c.name) }}</span>
          </div>
        </div>

        <!-- Working tree -->
        <button class="stat-card" :class="{ 'stat-card--alert': totalChanges > 0 }" @click="emit('changeView', 'changes')">
          <div class="stat-head">
            <div class="stat-icon" :class="totalChanges > 0 ? 'stat-icon--warning' : 'stat-icon--muted'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <span v-if="totalChanges === 0" class="chip chip--success chip--sm">{{ t("dashboard.chipClean") }}</span>
          </div>
          <div class="stat-value">{{ totalChanges }}</div>
          <div class="stat-label">{{ t("dashboard.metricChanges") }}</div>
          <div v-if="totalChanges > 0" class="stat-breakdown">
            <span v-if="status.staged > 0" class="stat-pill stat-pill--success">{{ status.staged }} {{ t("dashboard.staged") }}</span>
            <span v-if="status.unstaged > 0" class="stat-pill stat-pill--warning">{{ status.unstaged }} {{ t("dashboard.modified") }}</span>
            <span v-if="status.untracked > 0" class="stat-pill stat-pill--muted">{{ status.untracked }} {{ t("dashboard.new") }}</span>
          </div>
        </button>

        <!-- Files tracked -->
        <div class="stat-card">
          <div class="stat-head">
            <div class="stat-icon stat-icon--accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 7h16M4 12h16M4 17h10"/>
              </svg>
            </div>
          </div>
          <div class="stat-value">{{ formatNumber(fileCount) }}</div>
          <div class="stat-label">{{ t("dashboard.metricFiles") }}</div>
          <div class="filler"></div>
        </div>

        <!-- Open PRs -->
        <button class="stat-card" @click="emit('changeView', 'prs')">
          <div class="stat-head">
            <div class="stat-icon" :class="openPrs > 0 ? 'stat-icon--accent' : 'stat-icon--muted'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
                <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
              </svg>
            </div>
          </div>
          <div class="stat-value">{{ openPrs }}</div>
          <div class="stat-label">{{ t("dashboard.metricPrs") }}</div>
          <div class="stat-hint" v-if="mergedPrs > 0">
            {{ t("dashboard.prsMergedThisWeek", mergedPrs) }}
          </div>
          <div class="stat-hint" v-else>&nbsp;</div>
        </button>
      </section>

      <!-- ─── Heatmap + Contributors ───────────────────── -->
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head">
            <h3 class="panel-title">{{ t("dashboard.heatmapTitle") }}</h3>
            <button class="panel-link" @click="emit('changeView', 'history')">
              {{ t("dashboard.viewAll") }} →
            </button>
          </div>
          <div class="heatmap">
            <div class="heatmap-days">
              <span>{{ t("dashboard.dayMon") }}</span>
              <span></span>
              <span>{{ t("dashboard.dayWed") }}</span>
              <span></span>
              <span>{{ t("dashboard.dayFri") }}</span>
              <span></span>
              <span></span>
            </div>
            <div class="heatmap-grid-wrap">
              <div class="heatmap-grid">
                <div
                  v-for="col in heatmapCells"
                  :key="col.week"
                  class="heatmap-col"
                >
                  <div
                    v-for="(cell, i) in col.cells"
                    :key="i"
                    class="heatmap-cell"
                    :class="`heatmap-cell--l${cell.level}`"
                    :title="cell.date ? `${cell.date}: ${cell.count}` : ''"
                  ></div>
                </div>
              </div>
              <div class="heatmap-foot">
                <span v-for="m in heatmapMonths" :key="m">{{ m }}</span>
                <div class="heatmap-legend">
                  <span class="legend-label">{{ t("dashboard.less") }}</span>
                  <span class="heatmap-cell heatmap-cell--l0"></span>
                  <span class="heatmap-cell heatmap-cell--l1"></span>
                  <span class="heatmap-cell heatmap-cell--l2"></span>
                  <span class="heatmap-cell heatmap-cell--l3"></span>
                  <span class="heatmap-cell heatmap-cell--l4"></span>
                  <span class="legend-label">{{ t("dashboard.more") }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h3 class="panel-title">{{ t("dashboard.contributorsTitle") }}</h3>
          </div>
          <div class="contributors">
            <div v-for="c in topContributors" :key="c.email" class="contrib">
              <span class="avatar" :style="avatarStyle(c.email || c.name)">{{ initials(c.name) }}</span>
              <div class="contrib-body">
                <div class="contrib-name">{{ c.name }}</div>
                <div class="contrib-bar"><span :style="{ width: c.pct + '%' }"></span></div>
              </div>
              <div class="contrib-stat">{{ c.count }}</div>
            </div>
            <div v-if="topContributors.length === 0" class="contrib-empty">
              {{ t("dashboard.noContributors") }}
            </div>

            <div class="contrib-divider" v-if="commitsByType.total > 0"></div>

            <div v-if="commitsByType.total > 0" class="type-section">
              <div class="type-label">{{ t("dashboard.commitTypes") }}</div>
              <div class="type-bar">
                <span class="type-bar--feat" :style="{ flex: commitsByType.feat || 0.001 }" :title="`feat ${commitsByType.featPct}%`"></span>
                <span class="type-bar--fix" :style="{ flex: commitsByType.fix || 0.001 }" :title="`fix ${commitsByType.fixPct}%`"></span>
                <span class="type-bar--docs" :style="{ flex: commitsByType.docs || 0.001 }" :title="`docs ${commitsByType.docsPct}%`"></span>
                <span class="type-bar--chore" :style="{ flex: commitsByType.chore || 0.001 }" :title="`chore ${commitsByType.chorePct}%`"></span>
                <span class="type-bar--other" :style="{ flex: commitsByType.other || 0.001 }" :title="`other ${commitsByType.otherPct}%`"></span>
              </div>
              <div class="type-legend">
                <span v-if="commitsByType.feat > 0"><span class="dot dot--feat"></span>feat {{ commitsByType.featPct }}%</span>
                <span v-if="commitsByType.fix > 0"><span class="dot dot--fix"></span>fix {{ commitsByType.fixPct }}%</span>
                <span v-if="commitsByType.docs > 0"><span class="dot dot--docs"></span>docs {{ commitsByType.docsPct }}%</span>
                <span v-if="commitsByType.chore > 0"><span class="dot dot--chore"></span>chore {{ commitsByType.chorePct }}%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ─── Commits + Bar chart ──────────────────────── -->
      <section class="grid-2">
        <div class="panel">
          <div class="panel-head">
            <h3 class="panel-title">{{ t("dashboard.recentCommits") }}</h3>
            <div class="panel-actions">
              <button
                v-if="ai.isAvailable.value"
                class="btn btn--ai panel-link-ai"
                :title="t('dashboard.releaseNotesHint')"
                @click="openReleaseNotes"
              >
                ✨ {{ t('dashboard.releaseNotes') }}
              </button>
              <button class="panel-link" @click="emit('changeView', 'history')">
                {{ t("dashboard.viewAll") }} →
              </button>
            </div>
          </div>
          <ul class="commits">
            <li
              v-for="c in recentCommits.slice(0, 6)"
              :key="c.hashFull"
              class="commit"
              @click="emit('changeView', 'history')"
            >
              <span class="avatar avatar--sm" :style="avatarStyle(c.email || c.author)">{{ initials(c.author) }}</span>
              <div class="commit-body">
                <div class="commit-title">
                  <span v-if="commitType(c.message)" class="tag" :class="`tag--${commitType(c.message)}`">
                    {{ commitType(c.message) }}
                  </span>
                  <span class="commit-msg">{{ commitMessageBody(c.message) }}</span>
                </div>
                <div class="commit-sub">{{ c.author }} · {{ formatDate(c.date) }}</div>
              </div>
              <code class="commit-hash">{{ c.hash }}</code>
            </li>
            <li v-if="recentCommits.length === 0" class="commit-empty">
              {{ t("dashboard.noCommits") }}
            </li>
          </ul>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h3 class="panel-title">{{ t("dashboard.chartTitle") }}</h3>
          </div>
          <div class="chart" role="img" :aria-label="t('dashboard.chartTitle')">
            <div
              v-for="(day, i) in barChartDays"
              :key="i"
              class="bar-wrap"
              :title="`${day.count}`"
            >
              <div class="bar-val" v-if="day.count > 0">{{ day.count }}</div>
              <div
                class="bar"
                :class="{ 'bar--weekend': day.isWeekend, 'bar--empty': day.count === 0 }"
                :style="{ height: `${(day.count / barChartMax) * 82}%` }"
              ></div>
              <div class="bar-label">{{ day.label }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- ─── README card (kept, slight styling refresh) ─── -->
      <div class="card readme-card" v-if="readmeContent !== null">
        <div class="card-header">
          <h3 class="panel-title">
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
              {{ t("dashboard.formatted") }}
            </button>
            <button
              class="readme-tab"
              :class="{ 'readme-tab--active': readmeTab === 'raw' }"
              @click="readmeTab = 'raw'"
            >
              {{ t("dashboard.raw") }}
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
          <span>{{ t("dashboard.noReadme") }}</span>
        </div>
      </div>
    </template>

    <!-- ── Release notes modal (Phase 1.3.4) ────────────── -->
    <div
      v-if="releaseNotesOpen"
      class="rn-overlay overlay-backdrop"
      @click.self="closeReleaseNotes"
    >
      <div class="rn-modal" role="dialog" aria-modal="true">
        <header class="rn-head">
          <h3 class="rn-title">✨ {{ t('dashboard.releaseNotesTitle') }}</h3>
          <button class="rn-close" @click="closeReleaseNotes" aria-label="Close">✕</button>
        </header>
        <p class="rn-desc">{{ t('dashboard.releaseNotesDesc') }}</p>
        <div class="rn-refs">
          <label class="rn-field">
            <span>{{ t('dashboard.releaseNotesFrom') }}</span>
            <input v-model="releaseNotesFrom" type="text" class="rn-input mono" :placeholder="locale === 'fr' ? 'ex. v1.2.0' : 'e.g. v1.2.0'" />
          </label>
          <span class="rn-sep">..</span>
          <label class="rn-field">
            <span>{{ t('dashboard.releaseNotesTo') }}</span>
            <input v-model="releaseNotesTo" type="text" class="rn-input mono" placeholder="HEAD" />
          </label>
          <button
            class="rn-generate"
            :disabled="isGeneratingReleaseNotes || !releaseNotesFrom.trim() || !releaseNotesTo.trim()"
            @click="runGenerateReleaseNotes"
          >
            <span v-if="isGeneratingReleaseNotes">…</span>
            <span v-else>{{ t('dashboard.releaseNotesGenerate') }}</span>
          </button>
        </div>
        <p v-if="releaseNotesError" class="rn-error">{{ releaseNotesError }}</p>
        <div class="rn-output">
          <textarea
            v-model="releaseNotesMarkdown"
            class="rn-textarea mono"
            rows="16"
            spellcheck="false"
            :placeholder="t('dashboard.releaseNotesPlaceholder')"
          />
        </div>
        <footer class="rn-foot">
          <button
            class="rn-copy"
            :disabled="!releaseNotesMarkdown"
            @click="copyReleaseNotes"
          >
            {{ releaseNotesCopied ? t('dashboard.releaseNotesCopied') : t('dashboard.releaseNotesCopy') }}
          </button>
          <button class="rn-close-btn" @click="closeReleaseNotes">
            {{ t('common.close') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  padding: var(--space-7) var(--space-8);
  overflow-y: auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
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

.spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ───────── Hero ───────── */
.hero {
  display: grid;
  grid-template-columns: 1.3fr 1fr 1fr;
  gap: var(--space-5);
}

.hero-card {
  padding: var(--space-6) var(--space-6);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 160px;
}

.hero-card--primary {
  background:
    radial-gradient(circle at 100% 0%, var(--color-accent-soft), transparent 55%),
    linear-gradient(135deg, var(--color-bg-secondary), var(--color-bg-tertiary));
  border-color: var(--color-accent-soft);
}

.hero-eyebrow {
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
}

.hero-title {
  font-size: var(--font-size-xl);
  font-weight: 600;
  margin: 0;
  line-height: 1.2;
}

.hero-sub {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  margin: 0;
}

.hero-chips {
  display: flex;
  gap: var(--space-2);
  margin-top: auto;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-3);
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}
.chip--sm { padding: 1px var(--space-2); font-size: var(--font-size-sm); }
.chip--success { background: var(--color-success-soft); color: var(--color-success); }
.chip--danger { background: var(--color-danger-soft); color: var(--color-danger); }
.chip--info { background: var(--color-info-soft); color: var(--color-info); }
.chip--warning { background: var(--color-warning-soft); color: var(--color-warning); }

/* Health score */
.health-score {
  font-size: 38px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--color-success);
  margin-top: var(--space-1);
}
.health-score--fair { color: var(--color-warning); }
.health-score--poor { color: var(--color-danger); }
.health-denom {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-weight: 500;
}
.health-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--color-bg-tertiary);
  overflow: hidden;
  margin-top: auto;
}
.health-bar > span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--color-accent), var(--color-accent-hover));
  transition: width var(--transition-base);
}
.health-score--fair ~ .health-bar > span { background: linear-gradient(90deg, var(--color-warning), #fbbf24); }
.health-score--poor ~ .health-bar > span { background: linear-gradient(90deg, var(--color-danger), #f87171); }

/* Next action */
.next-title {
  font-size: var(--font-size-md);
  font-weight: 600;
  margin-top: var(--space-1);
  line-height: 1.35;
}
.btn-hero {
  margin-top: auto;
  padding: var(--space-3) var(--space-4);
  background: var(--color-accent);
  color: var(--color-accent-text);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-weight: 500;
  font-size: var(--font-size-sm);
  transition: background var(--transition-fast);
}
.btn-hero:hover { background: var(--color-accent-hover); }

/* ───────── Stat cards ───────── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: var(--space-4);
}

@media (max-width: 1100px) {
  .stats-grid { grid-template-columns: repeat(3, 1fr); }
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  cursor: default;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
  text-align: left;
  font-family: inherit;
  color: inherit;
  overflow: hidden;
}

button.stat-card { cursor: pointer; }
button.stat-card:hover {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
  transform: translateY(-1px);
}

.stat-card--alert { border-color: var(--color-warning); }

.stat-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.stat-icon {
  width: 32px; height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
}
.stat-icon--accent { background: var(--color-accent-soft); color: var(--color-accent); }
.stat-icon--info { background: var(--color-info-soft); color: var(--color-info); }
.stat-icon--success { background: var(--color-success-soft); color: var(--color-success); }
.stat-icon--warning { background: var(--color-warning-soft); color: var(--color-warning); }
.stat-icon--muted { background: var(--color-bg-tertiary); color: var(--color-text-muted); }

.trend {
  font-size: var(--font-size-sm);
  font-weight: 600;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
}
.trend--up { color: var(--color-success); background: var(--color-success-soft); }
.trend--down { color: var(--color-danger); background: var(--color-danger-soft); }

.stat-value {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  margin-top: var(--space-2);
}

.stat-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}

.stat-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  margin-top: var(--space-1);
  min-height: 1em;
}

.spark { width: 100%; height: 22px; margin-top: var(--space-2); }
.filler { flex: 1; }

.bullet-row { display: flex; gap: 3px; margin-top: var(--space-2); }
.bullet { height: 4px; border-radius: 2px; }
.bullet--success { background: var(--color-success); }
.bullet--warning { background: var(--color-warning); }

.avatar-stack {
  display: flex;
  margin-top: var(--space-2);
}
.avatar-stack .avatar + .avatar { margin-left: -6px; }

.stat-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.stat-pill {
  font-size: var(--font-size-sm);
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  font-weight: 500;
}
.stat-pill--success { background: var(--color-success-soft); color: var(--color-success); }
.stat-pill--warning { background: var(--color-warning-soft); color: var(--color-warning); }
.stat-pill--muted { background: var(--color-bg-tertiary); color: var(--color-text-muted); }

/* ───────── Avatar ───────── */
.avatar {
  width: 28px; height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  color: white;
  flex-shrink: 0;
  border: 2px solid var(--color-bg-secondary);
}
.avatar--sm {
  width: 22px; height: 22px;
  font-size: 10px;
  border-width: 2px;
}

/* ───────── Grid 2-col panels ───────── */
.grid-2 {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: var(--space-5);
}

@media (max-width: 1100px) {
  .grid-2 { grid-template-columns: 1fr; }
}

.panel {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.panel-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-md);
  font-weight: 600;
  margin: 0;
}

.panel-link {
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast);
}
.panel-link:hover { background: var(--color-accent-soft); }

/* ───────── Heatmap ───────── */
.heatmap {
  padding: var(--space-5);
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: var(--space-3);
}

.heatmap-days {
  display: grid;
  grid-template-rows: repeat(7, 12px);
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-subtle);
  padding-top: 2px;
}

.heatmap-grid-wrap { min-width: 0; }

.heatmap-grid {
  display: grid;
  grid-template-columns: repeat(26, 1fr);
  gap: 3px;
}

.heatmap-col {
  display: grid;
  grid-template-rows: repeat(7, 12px);
  gap: 3px;
}

.heatmap-cell {
  background: var(--color-bg-tertiary);
  border-radius: 2px;
  width: 100%;
  transition: transform var(--transition-fast);
}
.heatmap-cell:hover { transform: scale(1.2); }
.heatmap-cell--l0 { background: var(--color-bg-tertiary); }
.heatmap-cell--l1 { background: rgba(139, 92, 246, 0.25); }
.heatmap-cell--l2 { background: rgba(139, 92, 246, 0.5); }
.heatmap-cell--l3 { background: rgba(139, 92, 246, 0.75); }
.heatmap-cell--l4 { background: var(--color-accent); }

.heatmap-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: var(--space-3);
  font-size: 11px;
  color: var(--color-text-subtle);
  gap: var(--space-2);
  flex-wrap: wrap;
}

.heatmap-foot .heatmap-cell { width: 10px; height: 10px; display: inline-block; }

.heatmap-legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
}

.legend-label { margin: 0 2px; }

/* ───────── Contributors ───────── */
.contributors {
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.contrib {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: var(--space-3);
}

.contrib-body { min-width: 0; }

.contrib-name {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.contrib-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--color-bg-tertiary);
  overflow: hidden;
  margin-top: 3px;
}
.contrib-bar > span {
  display: block;
  height: 100%;
  background: var(--color-accent);
  border-radius: 2px;
  transition: width var(--transition-base);
}

.contrib-stat {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.contrib-divider {
  height: 1px;
  background: var(--color-border);
  margin: var(--space-2) 0;
}

.contrib-empty {
  padding: var(--space-5);
  color: var(--color-text-subtle);
  font-size: var(--font-size-sm);
  text-align: center;
}

.type-section { display: flex; flex-direction: column; gap: var(--space-2); }

.type-label {
  font-size: var(--font-size-sm);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  color: var(--color-text-subtle);
}

.type-bar {
  display: flex;
  gap: 3px;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
}

.type-bar > span { display: block; height: 100%; }
.type-bar--feat { background: var(--color-success); }
.type-bar--fix { background: var(--color-danger); }
.type-bar--docs { background: var(--color-info); }
.type-bar--chore { background: var(--color-warning); }
.type-bar--other { background: var(--color-text-subtle); }

.type-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.type-legend span { display: inline-flex; align-items: center; gap: var(--space-1); }

.dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.dot--feat { background: var(--color-success); }
.dot--fix { background: var(--color-danger); }
.dot--docs { background: var(--color-info); }
.dot--chore { background: var(--color-warning); }

/* ───────── Commits ───────── */
.commits {
  list-style: none;
  margin: 0;
  padding: var(--space-2) 0;
}

.commit {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3) var(--space-5);
  border-left: 2px solid transparent;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.commit:hover {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

.commit-body { min-width: 0; }

.commit-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.commit-msg {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-sub {
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  margin-top: 1px;
}

.tag {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 11px;
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-weight: 600;
  flex-shrink: 0;
  text-transform: lowercase;
}
.tag--feat { background: var(--color-success-soft); color: var(--color-success); }
.tag--fix { background: var(--color-danger-soft); color: var(--color-danger); }
.tag--docs { background: var(--color-info-soft); color: var(--color-info); }
.tag--chore,
.tag--refactor,
.tag--test,
.tag--style,
.tag--perf,
.tag--build,
.tag--ci { background: var(--color-bg-tertiary); color: var(--color-text-muted); }

.commit-hash {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
}

.commit-empty {
  padding: var(--space-6);
  color: var(--color-text-subtle);
  font-size: var(--font-size-sm);
  text-align: center;
}

/* ───────── Bar chart ───────── */
.chart {
  padding: var(--space-5);
  height: 220px;
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  position: relative;
}

.bar-wrap {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  position: relative;
  min-width: 0;
  padding-bottom: 18px;
}

.bar-val {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-bottom: 3px;
}

.bar {
  width: 100%;
  border-radius: 4px 4px 0 0;
  background: linear-gradient(180deg, var(--color-accent), var(--color-accent-soft));
  min-height: 2px;
  transition: opacity var(--transition-fast);
}
.bar--weekend { background: linear-gradient(180deg, var(--color-info), rgba(96, 165, 250, 0.25)); }
.bar--empty { background: var(--color-bg-tertiary); min-height: 3px; }
.bar-wrap:hover .bar { opacity: 0.8; }

.bar-label {
  position: absolute;
  bottom: 2px;
  font-size: 11px;
  color: var(--color-text-subtle);
}

/* ───────── README card (trimmed — only styling deltas kept) ───────── */
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
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.readme-card {
  display: flex;
  flex-direction: column;
  /* Override the generic `.card { overflow: hidden }` so long READMEs
     aren't clipped at the card boundary. The outer dashboard scroll
     handles vertical overflow. */
  overflow: visible;
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
  /* No max-height: let the README flow with the outer dashboard scroll
     rather than nesting a second scroll area inside the card. */
  flex: 1;
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
.readme-formatted :deep(p) { margin: 0 0 var(--space-4) 0; }
.readme-formatted :deep(ul),
.readme-formatted :deep(ol) {
  margin: 0 0 var(--space-4) 0;
  padding-left: var(--space-7);
}
.readme-formatted :deep(li) { margin-bottom: var(--space-2); }

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
.readme-formatted :deep(.md-link:hover) { text-decoration: underline; }

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
.readme-formatted :deep(strong) { font-weight: 600; }

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
  background: linear-gradient(135deg, var(--color-accent), #d946ef);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
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
.readme-formatted :deep(.md-badge) { height: 20px; }

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

.readme-formatted :deep(.md-img) {
  max-width: 100%;
  border-radius: var(--radius-md);
  margin: var(--space-3) 0;
}
.readme-formatted :deep(.md-img-placeholder) { display: none; }

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
.readme-raw code { font-family: inherit; }

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

.panel-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel-link-ai {
  min-height: 26px;
  padding: 4px 12px;
  font-size: var(--font-size-sm);
}

/* ─── Release notes modal ────────────────────────────── */
.rn-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 24px;
  /* backdrop tint + blur come from the global .overlay-backdrop class */
}

.rn-modal {
  width: min(760px, 100%);
  max-height: 90vh;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.35));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rn-head {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.rn-title {
  flex: 1;
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.rn-close {
  background: none;
  border: none;
  font-size: 16px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px 8px;
}

.rn-close:hover { color: var(--color-text); }

.rn-desc {
  margin: 0;
  padding: 12px 20px 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.rn-refs {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 20px;
}

.rn-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.rn-input {
  padding: 6px 10px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  outline: none;
}

.rn-input:focus { border-color: var(--color-accent); }

.rn-sep {
  padding-bottom: 6px;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.rn-generate {
  padding: 6px 14px;
  background: var(--color-accent);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  color: var(--color-accent-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  white-space: nowrap;
}

.rn-generate:hover:not(:disabled) { filter: brightness(1.08); }
.rn-generate:disabled { opacity: 0.5; cursor: not-allowed; }

.rn-error {
  margin: 0;
  padding: 0 20px 8px;
  font-size: var(--font-size-sm);
  color: var(--color-danger, #ef4444);
}

.rn-output {
  flex: 1;
  min-height: 0;
  padding: 0 20px 12px;
  display: flex;
}

.rn-textarea {
  width: 100%;
  flex: 1;
  min-height: 260px;
  padding: 12px 14px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  resize: vertical;
  outline: none;
}

.rn-textarea:focus { border-color: var(--color-accent); }

.rn-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
}

.rn-copy,
.rn-close-btn {
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  border: 1px solid var(--color-border);
}

.rn-copy {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}

.rn-copy:hover:not(:disabled) { filter: brightness(1.08); }
.rn-copy:disabled { opacity: 0.5; cursor: not-allowed; }

.rn-close-btn {
  background: transparent;
  color: var(--color-text);
}

.rn-close-btn:hover { background: var(--color-bg-secondary); }
</style>
