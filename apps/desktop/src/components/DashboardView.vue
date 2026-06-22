<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import {
  getGitLog,
  getGitShortlog,
  readFile,
  openExternalUrl,
  type GitLogEntry,
  type ShortlogEntry,
} from "../utils/backend";
import type { ViewMode } from "../composables/useGitRepo";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import { avatarStyle, avatarInitials as initials } from "../composables/useAvatar";
import { useAIProvider } from "../composables/useAIProvider";
import { useReleaseNotes, latestTag as findLatestTag } from "../composables/useReleaseNotes";
import { renderMarkdown, safeHtml } from "../composables/useSafeHtml";
import AiSparkle from "./AiSparkle.vue";

const { t, locale } = useI18n();
const { settings } = useSettings();
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
  selectCommit: [hashFull: string];
  sync: [];
  push: [];
}>();

// ─── Dashboard data ────────────────────────────────────────
const loading = ref(true);
const recentCommits = ref<GitLogEntry[]>([]);
const readmeContent = ref<string | null>(null);
const readmeError = ref(false);
const readmeTab = ref<"formatted" | "raw">("formatted");
const readmeFormattedEl = ref<HTMLElement | null>(null);
// Path (repo-relative) of the doc currently shown in the README pane. Relative
// `.md` links inside the README swap this out; `README.md` is the home doc.
const readmeDoc = ref("README.md");
/**
 * Full-history per-author commit counts. Populated from `git shortlog -sne HEAD`,
 * which sums the entire HEAD history rather than just a recent window — way more
 * accurate than aggregating `recentCommits` (biased toward who committed last).
 * Sorted desc by count (already done by `-n` flag, defended in Rust as well).
 */
const allContributors = ref<ShortlogEntry[]>([]);
const fortnightCommits = ref(0);
const previousFortnightCommits = ref(0);

// ─── Computed stats ────────────────────────────────────────
/** Trend vs previous 14d: positive means acceleration. */
const fortnightTrendPct = computed(() => {
  if (previousFortnightCommits.value === 0) {
    return fortnightCommits.value > 0 ? 100 : 0;
  }
  return Math.round(
    ((fortnightCommits.value - previousFortnightCommits.value) / previousFortnightCommits.value) * 100
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

/**
 * All contributors with commit count over the entire HEAD history, plus a
 * `pct` field (relative to the top contributor) for the bar visualization.
 * No slicing — the panel scrolls horizontally to expose the whole list.
 */
const topContributors = computed(() => {
  const list = allContributors.value;
  const max = list[0]?.count ?? 1;
  return list.map((c) => ({
    ...c,
    pct: Math.round((c.count / max) * 100),
  }));
});

/** Total contributor count — derived directly from the shortlog list. */
const contributorCount = computed(() => allContributors.value.length);

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

  // Boot-perf: only fetch what the trimmed dashboard renders — commit log
  // (heatmap / bar chart / commit-types), the README, and the full-history
  // shortlog (contributors panel). The branch / PR-count / file-count probes
  // were dropped when their cards were removed; those tabs load lazily.
  const results = await Promise.allSettled([
    getGitLog(props.cwd, 250, true),
    loadReadme(),
    getGitShortlog(props.cwd).catch(() => [] as ShortlogEntry[]),
  ]);

  // Commits
  if (results[0].status === "fulfilled") {
    recentCommits.value = results[0].value;
    // Commits in last 14 days + previous 14 days for trend
    const now = Date.now();
    const fortnightMs = 14 * 24 * 60 * 60 * 1000;
    fortnightCommits.value = recentCommits.value.filter(
      (c) => now - new Date(c.date).getTime() < fortnightMs
    ).length;
    previousFortnightCommits.value = recentCommits.value.filter((c) => {
      const diff = now - new Date(c.date).getTime();
      return diff >= fortnightMs && diff < 2 * fortnightMs;
    }).length;
  }
  // Shortlog (full-history per-author) — drives contributorCount + the
  // contributors panel. results[1] is loadReadme (no return value to
  // capture); results[2] is the shortlog.
  if (results[2].status === "fulfilled") {
    allContributors.value = results[2].value;
  }

  loading.value = false;
}

async function loadReadme() {
  readmeError.value = false;
  const candidates = ["README.md", "readme.md", "Readme.md", "README.MD"];
  for (const name of candidates) {
    try {
      readmeContent.value = await readFile(props.cwd, name);
      readmeDoc.value = name;
      return;
    } catch {
      // try next
    }
  }
  readmeContent.value = null;
  readmeError.value = true;
}

// Resolve a repo-relative href (`./ROADMAP.md`, `docs/x.md`, `../FOO.md`)
// against the directory of the doc currently shown, stripping any query/hash.
// Returns a clean repo-relative path; `safe_repo_path()` on the Rust side
// rejects anything that escapes the repo.
function resolveRepoPath(href: string): string {
  const clean = href.replace(/[?#].*$/, "");
  const baseDir = readmeDoc.value.includes("/")
    ? readmeDoc.value.replace(/\/[^/]*$/, "")
    : "";
  const segments = (baseDir ? baseDir.split("/") : []).concat(clean.split("/"));
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// Load another markdown doc from the repo into the README pane. Returns false
// when the file can't be read so the caller can fall back.
async function openRepoDoc(href: string): Promise<boolean> {
  const path = resolveRepoPath(href);
  if (!/\.(md|markdown)$/i.test(path)) return false;
  try {
    readmeContent.value = await readFile(props.cwd, path);
    readmeDoc.value = path;
    readmeError.value = false;
    readmeFormattedEl.value?.scrollTo({ top: 0 });
    return true;
  } catch {
    return false;
  }
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

// ─── README rendering ──────────────────────────────────────
// Markdown parsing is delegated to the shared `useSafeHtml` composable
// (markdown-it + DOMPurify). The only README-specific step kept here is
// `extractReadmeHeader`, which promotes the HTML block that many
// projects ship at the top of their README (title, tagline, nav links,
// shields.io badges) into a dedicated styled header. Anything below
// that block is run through the standard markdown-it renderer.
function renderReadme(md: string): string {
  const { headerHtml, rest } = extractReadmeHeader(md);
  // Strip HTML comments early — READMEs often use them as section
  // dividers, and we don't want them rendered as text. markdown-it's
  // `html: false` mode escapes them, which looks noisy in the UI.
  const cleaned = rest.replace(/<!--[\s\S]*?-->/g, "");
  // READMEs soft-wrap single newlines (GitHub behaviour) — disable `breaks` so
  // wrapped prose isn't broken up with spurious <br> tags.
  return headerHtml + renderMarkdown(cleaned, { breaks: false });
}

// The README is injected via `v-html`, so its anchors are plain DOM links the
// Tauri webview can't act on by itself: `http(s)` links would navigate the app
// away (or no-op), and in-page `#anchor` links don't reliably scroll inside the
// dashboard's own scroll container. Intercept every click here:
//   - external `http(s)` → hand off to the OS browser (same as PR markdown)
//   - `#anchor` → scroll the matching heading (slug `id`) into view
//   - repo-relative `.md` (e.g. `./ROADMAP.md`) → render it in the pane in-place
//   - anything else → swallow so the webview never navigates away from the app
function onReadmeLinkClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement | null)?.closest("a");
  const href = anchor?.getAttribute("href");
  if (!href) return;

  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    void openExternalUrl(href);
    return;
  }

  if (href.startsWith("#")) {
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const target = readmeFormattedEl.value?.querySelector(
      `#${CSS.escape(id)}`,
    );
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  // Repo-relative link (e.g. `./ROADMAP.md`). The webview would otherwise
  // navigate to the dev/app origin (`http://localhost:1420/ROADMAP.md`) and
  // break out of the app. Try to render the target markdown in-place instead.
  e.preventDefault();
  void openRepoDoc(href);
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
    // Using <div> (not <nav>) so DOMPurify's tag whitelist does not
    // drop the element — the class still carries the styling intent.
    headerHtml += `<div class="md-readme-nav">${navLinks.map(l => `<a href="${l.href}" class="md-link">${l.text}</a>`).join('<span class="md-readme-sep">&bull;</span>')}</div>`;
  }
  if (badges.length > 0) {
    // P1.5 — README badges (CI shields, npm, etc.) are external images that
    // can hang the network for tens of seconds when the badge host is slow
    // (corporate firewall on github.com observed at Dendreo: 14.7s TLS
    // handshake → window felt frozen). Three hints to keep the dashboard
    // fluid even when badges fail to resolve:
    //   - loading="lazy": only fetch when scrolled into view
    //   - decoding="async": decode off the main thread, no jank
    //   - referrerpolicy="no-referrer": don't leak local paths in Referer
    headerHtml += `<div class="md-readme-badges">${badges.map(b => `<img src="${b.src}" alt="${b.alt}" class="md-badge" loading="lazy" decoding="async" referrerpolicy="no-referrer">`).join(" ")}</div>`;
  }
  headerHtml += '</div>';

  return { headerHtml, rest };
}

onMounted(loadDashboard);
watch(() => props.cwd, loadDashboard);

// ─── Contributors rail — arrow navigation ──────────────────
const contribScroll = ref<HTMLElement | null>(null);
const contribCanLeft = ref(false);
const contribCanRight = ref(false);

function updateContribArrows() {
  const el = contribScroll.value;
  if (!el) return;
  // 20px dead-zone at each end so the arrow stays hidden near the edges.
  const edge = 20;
  contribCanLeft.value = el.scrollLeft > edge;
  contribCanRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - edge;
}

// `scroll` fires per frame during momentum scroll, and updateContribArrows
// reads layout (scrollWidth → forced reflow). Coalesce to one read per frame.
let arrowTick = false;
function onContribScroll() {
  if (arrowTick) return;
  arrowTick = true;
  requestAnimationFrame(() => {
    arrowTick = false;
    updateContribArrows();
  });
}

function scrollContrib(dir: 1 | -1) {
  const el = contribScroll.value;
  if (!el) return;
  el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
}

// Recompute arrow visibility whenever the list changes.
watch(topContributors, () => nextTick(updateContribArrows), { immediate: true });
</script>

<template>
  <div class="dashboard">
    <!-- Loading skeleton -->
    <div v-if="loading" class="dashboard-loading">
      <div class="spinner"></div>
      <span>{{ t("dashboard.loading") }}</span>
    </div>

    <template v-else>
      <!-- ─── Contributors + Recent commits ─────────────── -->
      <section v-if="!settings.dashboardHideContributors" class="row-contrib">
        <!-- Contributors -->
        <div class="panel">
          <div class="panel-head">
            <h3 class="panel-title">
              {{ t("dashboard.contributorsTitle") }}
              <span class="panel-count">{{ contributorCount }}</span>
            </h3>
          </div>
          <div class="contributors">
            <!-- Horizontal scrollable list (v2.0) — every contributor over the
                 entire HEAD history, not just a recent window. Card width is
                 ~33% so a third card peeks in to cue the scroll. -->
            <div v-if="topContributors.length > 0" class="contributors-rail">
              <button
                v-if="contribCanLeft"
                type="button"
                class="contrib-arrow contrib-arrow--left"
                :aria-label="t('common.previous')"
                @click="scrollContrib(-1)"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div
                ref="contribScroll"
                class="contributors-scroll"
                :class="{ 'contributors-scroll--dense': topContributors.length > 4 }"
                role="list"
                :aria-label="t('dashboard.contributorsTitle')"
                @scroll="onContribScroll"
              >
                <div
                  v-for="c in topContributors"
                  :key="c.email"
                  class="contrib"
                  role="listitem"
                  :title="`${c.name} <${c.email}> · ${c.count}`"
                >
                  <span class="avatar" :style="avatarStyle(c.email || c.name)">{{ initials(c.name) }}</span>
                  <div class="contrib-body">
                    <div class="contrib-name">{{ c.name }}</div>
                    <div class="contrib-bar"><span :style="{ width: c.pct + '%' }"></span></div>
                  </div>
                  <div class="contrib-stat">{{ c.count }}</div>
                </div>
              </div>
              <button
                v-if="contribCanRight"
                type="button"
                class="contrib-arrow contrib-arrow--right"
                :aria-label="t('common.next')"
                @click="scrollContrib(1)"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
            <div v-else class="contrib-empty">
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

      <!-- ─── Activity + Commits/day + Recent commits ──── -->
      <section v-if="!settings.dashboardHideActivity" class="row-activity">
        <!-- Activity — last 6 months (far left) -->
        <div class="panel">
          <div class="panel-head">
            <h3 class="panel-title">{{ t("dashboard.heatmapTitle") }}</h3>
          </div>
          <div class="heatmap">
            <div class="heatmap-days">
              <span>{{ t("dashboard.dayMon") }}</span>
              <span>{{ t("dashboard.dayTue") }}</span>
              <span>{{ t("dashboard.dayWed") }}</span>
              <span>{{ t("dashboard.dayThu") }}</span>
              <span>{{ t("dashboard.dayFri") }}</span>
              <span>{{ t("dashboard.daySat") }}</span>
              <span>{{ t("dashboard.daySun") }}</span>
            </div>
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
              <div class="heatmap-months">
                <span v-for="m in heatmapMonths" :key="m">{{ m }}</span>
              </div>
            </div>
          </div>
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

        <!-- Commits per day (14d) -->
        <div class="panel">
          <div class="panel-head panel-head--chart">
            <h3 class="panel-title">{{ t("dashboard.chartTitle") }}</h3>
            <span class="chart-total panel-count">{{ fortnightCommits }} {{ t("dashboard.chartCommits") }}</span>
            <span
              v-if="fortnightTrendPct !== 0"
              class="trend chart-trend"
              :class="fortnightTrendPct > 0 ? 'trend--up' : 'trend--down'"
            >
              {{ fortnightTrendPct > 0 ? "▲" : "▼" }} {{ Math.abs(fortnightTrendPct) }}%
            </span>
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

        <!-- Recent commits -->
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
                <span class="dv-ai-label">
                  <AiSparkle :size="13" />
                  {{ t('dashboard.releaseNotes') }}
                </span>
              </button>
            </div>
          </div>
          <ul class="commits">
            <li
              v-for="c in recentCommits.slice(0, 6)"
              :key="c.hashFull"
              class="commit"
              @click="emit('selectCommit', c.hashFull)"
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
      </section>

      <!-- ─── README card (kept, slight styling refresh) ─── -->
      <div class="card readme-card" :class="{ 'readme--first': settings.dashboardReadmeFirst }" v-if="!settings.dashboardHideReadme && readmeContent !== null">
        <div class="card-header">
          <h3 class="panel-title">
            <button
              v-if="readmeDoc !== 'README.md'"
              class="readme-back"
              :title="t('dashboard.backToReadme')"
              @click="loadReadme"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 3h5l1 1h6v9H2V3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
            </svg>
            {{ readmeDoc }}
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
            ref="readmeFormattedEl"
            class="readme-formatted"
            @click="onReadmeLinkClick"
            v-html="safeHtml(renderReadme(readmeContent))"
          />
          <pre v-else class="readme-raw"><code>{{ readmeContent }}</code></pre>
        </div>
      </div>

      <div class="card readme-empty" :class="{ 'readme--first': settings.dashboardReadmeFirst }" v-else-if="!settings.dashboardHideReadme && readmeError">
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
          <h3 class="rn-title">
            <AiSparkle :size="16" />
            {{ t('dashboard.releaseNotesTitle') }}
          </h3>
          <button class="rn-close" @click="closeReleaseNotes" aria-label="Close">✕</button>
        </header>
        <p class="rn-desc">{{ t('dashboard.releaseNotesDesc') }}</p>
        <div class="rn-refs">
          <label class="rn-field">
            <span>{{ t('dashboard.releaseNotesFrom') }}</span>
            <input v-model="releaseNotesFrom" type="text" class="rn-input mono" :placeholder="t('dashboard.releaseNotesFromPlaceholder')" />
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

/* "README first" dashboard option — pull the README card above the
   contributors / activity rows without reordering the DOM. */
.readme--first { order: -1; }

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

/* ───────── Dashboard rows ───────── */
/* Contributors — full width on its own row. */
.row-contrib {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
}

/* Activity heatmap · Commits/day · Recent commits — three equal columns.
   `minmax(0, …)` lets the panels shrink so their inner scroll/ellipsis
   content can't blow out the grid. */
.row-activity {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-5);
}

@media (max-width: 1100px) {
  .row-contrib,
  .row-activity { grid-template-columns: 1fr; }
}

.trend {
  font-size: var(--font-size-sm);
  font-weight: 600;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
}
.trend--up { color: var(--color-success); background: var(--color-success-soft); }
.trend--down { color: var(--color-danger); background: var(--color-danger-soft); }

/* ───────── Avatar ───────── */
.avatar {
  width: 28px; height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  border: 1.5px solid currentColor;
}
.avatar--sm {
  width: 22px; height: 22px;
  font-size: 10px;
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

.panel-head--chart {
  justify-content: flex-start;
  gap: var(--space-2);
}
.chart-trend {
  margin-left: auto;
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
  /* Cell band (row 1) + foot (row 2). Days and cells share row 1 so their
     7 tracks line up exactly. Capped at 210px, anchored to the top. */
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: var(--space-3);
  height: 210px;
  max-height: 210px;
  min-height: 0;
}

.heatmap-days {
  grid-column: 1;
  grid-row: 1;
  display: grid;
  grid-template-rows: repeat(7, 1fr);
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-subtle);
}

/* Center each label vertically within its 12px row so the day lines up
   with the heatmap cell instead of sitting at the top of the track. */
.heatmap-days span {
  display: flex;
  align-items: center;
  line-height: 1;
}

.heatmap-grid {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(26, 1fr);
  gap: 3px;
}

.heatmap-col {
  display: grid;
  grid-template-rows: repeat(7, 1fr);
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
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  margin-top: var(--space-3);
  font-size: 11px;
  color: var(--color-text-subtle);
  gap: var(--space-2);
}

/* Months span the full grid width on their own row so they line up under
   the columns instead of fighting the legend for horizontal space. */
.heatmap-months {
  display: flex;
  justify-content: space-between;
}

.heatmap-legend .heatmap-cell { width: 14px; height: 14px; display: inline-block; }

/* Legend sits outside the heatmap and fills the leftover space below it,
   centered both vertically and horizontally in that gap. */
.heatmap-legend {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 var(--space-4) var(--space-6);
  font-size: 13px;
  color: var(--color-text-subtle);
}

.legend-label { margin: 0 2px; }

/* ───────── Contributors ───────── */
.contributors {
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Rail = scroll viewport + overlaid prev/next arrows. */
.contributors-rail {
  position: relative;
}

/* Horizontal scrollable rail (v2.0). The full contributor list lives here;
   each card snaps to the start, and ~33% width means a third card peeks
   in to make the scrollability obvious. `mask-image` fades both edges
   as an extra cue; navigation is driven by the overlaid arrows. */
.contributors-scroll {
  display: flex;
  flex-direction: row;
  gap: var(--space-3);
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  /* Arrows replace the scrollbar as the navigation affordance. */
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* Negative margin + matching padding lets the cards bleed to the panel
     edges visually while keeping the scrollbar clear of the panel border. */
  padding: 0 var(--space-5) 0;
  /* Fade both edges so cards appear to slide behind the panel sides. */
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--space-6),
    #000 calc(100% - var(--space-6)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--space-6),
    #000 calc(100% - var(--space-6)),
    transparent 100%
  );
}
.contributors-scroll::-webkit-scrollbar {
  display: none;
}

/* Prev/next arrows — overlaid on the rail edges, replacing the scrollbar. */
.contrib-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  cursor: pointer;
  box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.25);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.contrib-arrow:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent);
}
.contrib-arrow--left {
  left: calc(var(--space-2) * -1);
}
.contrib-arrow--right {
  right: calc(var(--space-2) * -1);
}

.contrib {
  flex: 0 0 calc((100% - var(--space-3) * 3) / 4);
  min-width: 150px;
  scroll-snap-align: start;
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

/* >4 contributors: shrink cards so more fit and a partial card peeks in. */
.contributors-scroll--dense .contrib {
  flex-basis: calc((100% - var(--space-3) * 4) / 6);
}

.contrib:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
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
  gap: var(--space-6);
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
  background: #ffffff;
  color: #000000;
  text-shadow: none;
}
.tag--feat,
.tag--fix,
.tag--docs,
.tag--chore,
.tag--refactor,
.tag--test,
.tag--style,
.tag--perf,
.tag--build,
.tag--ci { background: #ffffff; color: #000000; }

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
  /* flex:1 + min-height lets the chart grow to fill the panel so the bars
     and weekday labels stay anchored to the bottom edge of the block. */
  flex: 1;
  min-height: 220px;
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  position: relative;
}

.chart-total {
  font-size: var(--font-size-md);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* Count badge beside a panel title (contributors). */
.panel-count {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  font-variant-numeric: tabular-nums;
  padding: 1px 6px;
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

.readme-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.readme-back:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
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
/* Badge dimensions are fixed up-front (height + min-width) so the layout
   doesn't reflow when images load asynchronously or fail to resolve. */
.readme-formatted :deep(.md-badge) {
  height: 20px;
  min-width: 60px;
}

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

.btn.btn--ai.panel-link-ai {
  min-height: 26px;
  padding: 4px 12px;
  font-size: var(--font-size-sm);
  border-radius: var(--radius-sm);
  color: var(--color-text);
}
.btn.btn--ai.panel-link-ai:hover:not(:disabled) {
  color: var(--color-ai-text);
  transform: none;
  background:
    linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%) padding-box,
    linear-gradient(135deg, var(--color-accent) 0%, #c084fc 50%, var(--color-accent) 100%) border-box;
}
.dv-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-ai);
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
