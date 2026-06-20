<script setup lang="ts">
import { ref, onMounted, computed, watch, toRef } from "vue";
import { saveSettings as persistAppSettings } from "../composables/useSettings";
import { avatarStyle, avatarInitials } from "../composables/useAvatar";
import { useLaunchpadWip } from "../composables/useLaunchpadWip";
import { useLaunchpadPrs } from "../composables/useLaunchpadPrs";
import { useLaunchpadInbox, type InboxTier, type InboxAction, type InboxCase } from "../composables/useLaunchpadInbox";
import { useLaunchpadIssues } from "../composables/useLaunchpadIssues";
import { useLaunchpadScope } from "../composables/useLaunchpadScope";
import { useRepoActionCards, type RepoCardKind } from "../composables/useRepoActionCards";
import { useLaunchpadPins } from "../composables/useLaunchpadPins";
import { useLaunchpadTeam } from "../composables/useLaunchpadTeam";
import type { TeamMemberActivity, OverlappingPr } from "../composables/useLaunchpadTeam";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import type { WorkspaceRepo } from "../utils/backend";
import type { PrWithRepo } from "../composables/useLaunchpadPrs";
import type { IssueFilter, IssueWithRepo } from "../composables/useLaunchpadIssues";

const props = defineProps<{
  repos: WorkspaceRepo[];
}>();

const emit = defineEmits<{
  /** Open a PR in the in-app review surface (PrDetailView) — handled by App.vue. */
  (e: "open-pr", pr: PrWithRepo): void;
  /** Open an issue in the in-app IssueDetailView — handled by App.vue. */
  (e: "open-issue", issue: IssueWithRepo): void;
  /** Open a repo's Changes view (local action card CTA) — handled by App.vue. */
  (e: "open-repo-changes", repoPath: string): void;
}>();

// close event removed — navigation is now handled by the sidebar viewMode switch

const { t } = useI18n();
const { settings } = useSettings();

// Scope (v3): which of the open repo tabs the Launchpad shows. `scopedRepos`
// drives every fetch; the selection is persisted (see useLaunchpadScope).
const {
  scopedRepos,
  isAll: scopeIsAll,
  isSelected: scopeIsSelected,
  setAll: scopeSetAll,
  toggle: scopeToggle,
} = useLaunchpadScope(toRef(props, "repos"));
const scopeMenuOpen = ref(false);
const scopeLabel = computed(() => {
  if (scopeIsAll.value) return t("launchpad.scopeAll");
  const sel = props.repos.filter((r) => scopeIsSelected(r.path));
  return sel.length === 1 ? sel[0].name : t("launchpad.scopeCount", sel.length);
});

// Whether the Team tab is enabled at all. When false, the tab is hidden and
// the team activity is never fetched (perf-sensitive setups / solo teams).
const teamTabEnabled = computed(() => settings.value.launchpadTeamTabEnabled !== false);

// Lazy-load flag for the Team tab. The team fetch is the most expensive call
// in the Launchpad (N × `gh pr view --json files`, ~10s on a 50-PR workspace),
// so we hold off until the user explicitly opens the tab. WIP / PRs / Issues
// stay eager because their per-tab badges need real numbers at boot.
const teamLoaded = ref(false);

const { wip, loading: wipLoading, error: wipError, refresh: refreshWip } = useLaunchpadWip();
const { allPrs, snoozedPrs, repos: prRepos, loading: prsLoading, error: prsError, refresh: refreshPrs } = useLaunchpadPrs();
// Inbox — "À traiter": derives the action-grouped subset of allPrs (review
// requested of me, changes requested / failing CI / approved on my own PRs).
const { tiers: inboxTiers, nowCount, totalCount: inboxTotal, loadUser: loadInboxUser } = useLaunchpadInbox(allPrs);
// Local action cards (commit / push / publish / sync) derived from cross-repo
// WIP — the other pluggable source of the inbox-journal alongside PR buckets.
const { cards: localCards, totalCount: localTotal } = useRepoActionCards(wip);
/** Total inbox items = local action cards + PR buckets (drives badge + empty state). */
const inboxCount = computed(() => localTotal.value + inboxTotal.value);

/** i18n label for an inbox tier header. */
function inboxTierLabel(tier: InboxTier): string {
  return t(`launchpad.tier.${tier}`);
}
/** i18n label for an inbox action button. */
function inboxActionLabel(action: InboxAction): string {
  return t(`launchpad.action.${action}`);
}

// Ephemeral collapsed-tier state — no persistence in Phase 1.
// Use a new Set on each toggle so Vue detects the reference change and re-renders.
const collapsedTiers = ref<Set<InboxTier>>(new Set());
function toggleTierCollapse(tier: InboxTier): void {
  const next = new Set(collapsedTiers.value);
  if (next.has(tier)) next.delete(tier);
  else next.add(tier);
  collapsedTiers.value = next;
}
/** i18n label for a local action card (count-aware). */
function localCardLabel(kind: RepoCardKind, count: number): string {
  return t(`launchpad.card.${kind}`, count);
}
/** i18n label for the local action card's CTA button. */
function cardActionLabel(kind: RepoCardKind): string {
  return t(`launchpad.cardAction.${kind}`);
}
/** i18n state-pill label for an inbox case. */
function inboxStateLabel(c: InboxCase): string {
  return t(`launchpad.case.${c}`);
}
/**
 * Accent colour name for an inbox case — drives the card's left border, the
 * state-pill dot, and its text colour. One of: success | accent | danger |
 * warning | info | muted.
 */
const CASE_ACCENT: Record<InboxCase, string> = {
  merge: "success",
  review: "accent",
  conflicts: "danger",
  ci: "danger",
  changes: "warning",
  waiting: "muted",
  ciRunning: "info",
  blocked: "warning",
};
function inboxAccent(c: InboxCase): string {
  return CASE_ACCENT[c];
}
/** Compact, locale-aware relative time (e.g. "12 min", "3 h", "2 j"). */
function relativeTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return t("launchpad.timeMin", min);
  const hr = Math.round(min / 60);
  if (hr < 24) return t("launchpad.timeHour", hr);
  const day = Math.round(hr / 24);
  if (day < 7) return t("launchpad.timeDay", day);
  return t("launchpad.timeWeek", Math.round(day / 7));
}
const { allIssues, snoozedIssues, repos: issueRepos, loading: issuesLoading, error: issuesError, activeFilter: issueFilter, totalCount: issuesTotal, refresh: refreshIssues } = useLaunchpadIssues();
const { pin, unpin, snooze, unsnooze, isPinned, isSnoozed, snoozedUntil } = useLaunchpadPins();
const {
  teamActivity,
  loading: teamLoading,
  error: teamError,
  refresh: refreshTeam,
} = useLaunchpadTeam();

type Tab = "inbox" | "wip" | "prs" | "issues" | "team";

// Persist active tab across openings (v2.9 §1.3). Source of truth is
// `settings.launchpadActiveTab` — read once at boot so the user lands back on
// the tab they were on last session, then write through `setTab()` on every
// change. A computed getter/setter keeps the template binding ergonomic.
const activeTab = computed<Tab>({
  get: () => settings.value.launchpadActiveTab,
  set: (val) => {
    settings.value.launchpadActiveTab = val;
    persistAppSettings(settings.value);
  },
});

// ── ⋮ menu state ──────────────────────────────────────────────────────────────
const openMenuUrl = ref<string | null>(null);
const openSnoozeFor = ref<string | null>(null);

// ── Snoozed bandeau visibility ─────────────────────────────────────────────────
const showSnoozedPrs = ref(false);
const showSnoozedIssues = ref(false);

// ── Team expanded state ────────────────────────────────────────────────────────
const expandedTeamMembers = ref<Set<string>>(new Set());

function initExpandedMembers(members: readonly TeamMemberActivity[]): void {
  expandedTeamMembers.value = new Set(
    members.filter((m) => m.overlappingPrs.length > 0).map((m) => m.login)
  );
}

function toggleTeamMember(login: string): void {
  const next = new Set(expandedTeamMembers.value);
  if (next.has(login)) next.delete(login);
  else next.add(login);
  expandedTeamMembers.value = next;
}

const membersWithOverlap = computed(() =>
  teamActivity.value.filter((m) => m.overlappingPrs.length > 0)
);
const membersWithoutOverlap = computed(() =>
  teamActivity.value.filter((m) => m.overlappingPrs.length === 0)
);

function loadTeam(): void {
  refreshTeam(scopedRepos.value)
    .then(() => {
      teamLoaded.value = true;
      initExpandedMembers(teamActivity.value);
    })
    .catch(() => {
      // Mark as loaded anyway so the placeholder doesn't reappear over an
      // error state — `teamError` carries the message. The user can re-try
      // via the Refresh button.
      teamLoaded.value = true;
    });
}

function setTab(tab: Tab) {
  activeTab.value = tab;
  // Lazy fetch on first visit to the Team tab. After this, the Refresh
  // button re-fetches but `teamLoaded` stays true so the placeholder is
  // gone for good.
  if (tab === "team" && !teamLoaded.value && teamTabEnabled.value) {
    loadTeam();
  }
}

function handleRefresh() {
  if (activeTab.value === "wip") refreshWip(scopedRepos.value);
  else if (activeTab.value === "prs") refreshPrs(scopedRepos.value);
  else if (activeTab.value === "issues") refreshIssues(scopedRepos.value);
  else if (activeTab.value === "team") {
    loadTeam();
  }
}

// ── Refresh all (v2.9 §1.4) ──────────────────────────────────────────────
// Fires WIP / PRs / Issues / Team refreshes in parallel via `Promise.all`.
// Distinct from `handleRefresh` (active-tab-only) which stays cheap for users
// who just want to refresh what they're looking at — useful on slow networks
// or when the Team tab triggers an expensive cross-repo `gh pr view --json
// files` fan-out. The Team refresh is skipped when the tab is disabled so we
// don't pay for a fetch the user has opted out of.
const loadingAll = ref(false);
async function handleRefreshAll() {
  if (loadingAll.value) return;
  loadingAll.value = true;
  try {
    const tasks: Promise<unknown>[] = [
      refreshWip(scopedRepos.value),
      refreshPrs(scopedRepos.value),
      refreshIssues(scopedRepos.value),
    ];
    if (teamTabEnabled.value) {
      tasks.push(
        refreshTeam(scopedRepos.value)
          .then(() => {
            teamLoaded.value = true;
            initExpandedMembers(teamActivity.value);
          })
          .catch(() => {
            // Error captured in `teamError` reactive — see loadTeam().
            teamLoaded.value = true;
          }),
      );
    }
    await Promise.all(tasks);
  } finally {
    loadingAll.value = false;
  }
}

function setIssueFilter(filter: IssueFilter) {
  // The three filters are already cached by useLaunchpadIssues.refresh(), so
  // switching sub-filter is a pure view change — no refetch needed.
  issueFilter.value = filter;
}

const isLoading = () => wipLoading.value || prsLoading.value || issuesLoading.value || teamLoading.value;

// ── Menu helpers ──────────────────────────────────────────────────────────────
function toggleMenu(url: string): void {
  if (openMenuUrl.value === url) {
    openMenuUrl.value = null;
    openSnoozeFor.value = null;
  } else {
    openMenuUrl.value = url;
    openSnoozeFor.value = null;
  }
}

function closeMenu(): void {
  openMenuUrl.value = null;
  openSnoozeFor.value = null;
  scopeMenuOpen.value = false;
}

function pinAndClose(url: string, type: "pr" | "issue"): void {
  pin(url, type);
  closeMenu();
}

function unpinAndClose(url: string): void {
  unpin(url);
  closeMenu();
}

function snoozeAndClose(url: string, type: "pr" | "issue", days: 1 | 3 | 7 | 14): void {
  snooze(url, type, days);
  closeMenu();
}

function unsnoozeAndClose(url: string): void {
  unsnooze(url);
  closeMenu();
}

function formatSnoozedUntil(url: string): string {
  const d = snoozedUntil(url);
  if (!d) return "";
  return new Date(d).toLocaleDateString();
}

onMounted(() => {
  // Eager boot for WIP / PRs / Issues — these power the tab badges and
  // are bounded fast calls (~1-2s, parallel-friendly). Team is NOT fetched
  // here because it triggers one `gh pr view --json files` per colleague PR
  // (concurrentMap cap 5, but still N round-trips); on a 50-PR workspace
  // that's ~10s of fetch the user pays for at boot whether they ever open
  // the Team tab or not. Lazy-loaded via `setTab("team")` instead.
  refreshWip(scopedRepos.value);
  refreshPrs(scopedRepos.value);
  refreshIssues(scopedRepos.value);
  // Resolve the forge identity once so the Inbox can classify PRs by action.
  void loadInboxUser();
  // If the user persisted "team" as their last active tab (v2.9 §1.3),
  // honor the lazy-load contract by fetching it now — otherwise the
  // restored panel would render an empty placeholder until they switch
  // tabs and back.
  if (activeTab.value === "team" && teamTabEnabled.value && !teamLoaded.value) {
    loadTeam();
  }
});

// Re-fetch whenever the scope changes — the user toggled the filter, or opened
// /closed a repo tab (which shifts `scopedRepos`). Team only if already loaded.
watch(scopedRepos, () => {
  refreshWip(scopedRepos.value);
  refreshPrs(scopedRepos.value);
  refreshIssues(scopedRepos.value);
  if (teamLoaded.value && teamTabEnabled.value) loadTeam();
});
</script>

<template>
  <div class="launchpad-view" @click="closeMenu()">
    <div class="launchpad-view__frame" @click.stop="closeMenu()">
    <div class="launchpad-view__header">
      <h2 class="launchpad-view__title">{{ t("launchpad.title") }}</h2>

      <!-- Scope selector — narrows the Launchpad to a subset of the open repos. -->
      <div class="launchpad-view__scope" @click.stop>
        <button
          class="launchpad-view__scope-trigger"
          :class="{ 'launchpad-view__scope-trigger--filtered': !scopeIsAll }"
          :title="t('launchpad.scopeTooltip')"
          :aria-expanded="scopeMenuOpen"
          @click="scopeMenuOpen = !scopeMenuOpen"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 3h12l-4.5 5.5V13L6.5 11V8.5L2 3z" stroke-linejoin="round"/>
          </svg>
          <span>{{ scopeLabel }}</span>
          <span class="launchpad-view__scope-caret" aria-hidden="true">▾</span>
        </button>
        <div v-if="scopeMenuOpen" class="launchpad-view__scope-menu">
          <button
            class="launchpad-view__scope-item"
            :class="{ 'launchpad-view__scope-item--active': scopeIsAll }"
            @click="scopeSetAll()"
          >
            <span class="launchpad-view__scope-check">{{ scopeIsAll ? "✓" : "" }}</span>
            {{ t("launchpad.scopeAll") }}
          </button>
          <div class="launchpad-view__scope-sep" aria-hidden="true"></div>
          <button
            v-for="repo in props.repos"
            :key="repo.path"
            class="launchpad-view__scope-item"
            @click="scopeToggle(repo.path)"
          >
            <span class="launchpad-view__scope-check">{{ scopeIsSelected(repo.path) ? "✓" : "" }}</span>
            {{ repo.name }}
          </button>
        </div>
      </div>

      <button
        class="launchpad-view__refresh"
        :disabled="isLoading() || loadingAll"
        @click.stop="handleRefresh"
      >
        {{ isLoading() ? t("launchpad.loading") : t("launchpad.refresh") }}
      </button>
      <button
        class="launchpad-view__refresh launchpad-view__refresh--all"
        :title="t('launchpad.refreshAllTooltip')"
        :disabled="isLoading() || loadingAll"
        @click.stop="handleRefreshAll"
      >
        <!-- Inline SVG (double-arrow loop) — avoids pulling an icon font and
             keeps the loading-spin animation purely CSS. -->
        <svg
          class="launchpad-view__refresh-icon"
          :class="{ 'launchpad-view__refresh-icon--spin': loadingAll }"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
        <span>{{ t("launchpad.refreshAll") }}</span>
      </button>
    </div>

    <!-- Tab bar -->
    <div class="launchpad-view__tabs">
      <button
        class="launchpad-view__tab"
        :class="{ 'launchpad-view__tab--active': activeTab === 'inbox' }"
        @click="setTab('inbox')"
      >
        {{ t("launchpad.inboxTab") }}
        <span v-if="inboxCount > 0" class="launchpad-view__tab-badge">
          {{ inboxCount }}
        </span>
      </button>
      <button
        class="launchpad-view__tab"
        :class="{ 'launchpad-view__tab--active': activeTab === 'wip' }"
        @click="setTab('wip')"
      >
        {{ t("launchpad.wipTab") }}
      </button>
      <button
        class="launchpad-view__tab"
        :class="{ 'launchpad-view__tab--active': activeTab === 'prs' }"
        @click="setTab('prs')"
      >
        {{ t("launchpad.prsTab") }}
        <span v-if="allPrs.length > 0" class="launchpad-view__tab-badge">
          {{ allPrs.length }}
        </span>
      </button>
      <button
        class="launchpad-view__tab"
        :class="{ 'launchpad-view__tab--active': activeTab === 'issues' }"
        @click="setTab('issues')"
      >
        {{ t("launchpad.issuesTab") }}
        <span v-if="issuesTotal > 0" class="launchpad-view__tab-badge">
          {{ issuesTotal }}
        </span>
      </button>
      <button
        v-if="teamTabEnabled"
        class="launchpad-view__tab"
        :class="{ 'launchpad-view__tab--active': activeTab === 'team' }"
        @click="setTab('team')"
      >
        {{ t("launchpad.teamTab") }}
      </button>
    </div>

    <!-- Inbox tab — triaged action inbox: local cards + 3 urgency tiers -->
    <div v-if="activeTab === 'inbox'" class="launchpad-view__panel">
      <span
        v-if="prsLoading && allPrs.length > 0"
        class="launchpad-view__refresh-spinner"
        :aria-label="t('launchpad.loading')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
        </svg>
      </span>
      <div v-if="prsError" class="launchpad-view__error">
        {{ t("launchpad.errorFetch", prsError) }}
      </div>
      <div v-else-if="prsLoading && allPrs.length === 0" class="launchpad-view__loading-block">
        <span class="launchpad-view__spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
          </svg>
        </span>
        <span class="launchpad-view__loading-label">{{ t("launchpad.loading") }}</span>
      </div>
      <p v-else-if="inboxCount === 0" class="launchpad-view__empty">
        {{ t("launchpad.inboxEmpty") }}
      </p>
      <template v-else>
        <!-- Summary line: total items · items needing immediate action -->
        <p class="launchpad-view__inbox-summary">
          {{ t("launchpad.inboxSummary", inboxCount, nowCount) }}
        </p>

        <!-- Local action cards (commit / push / publish / sync) — prominent band above tiers. -->
        <div v-if="localCards.length > 0" class="launchpad-view__local-band">
          <div
            v-for="card in localCards"
            :key="card.id"
            class="launchpad-view__local-card"
          >
            <span class="launchpad-view__local-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="5" cy="3" r="1.6" />
                <circle cx="5" cy="13" r="1.6" />
                <circle cx="11" cy="6" r="1.6" />
                <path d="M5 4.6v6.8M5 5C5 7.6 11 7.4 11 5.4" />
              </svg>
            </span>
            <div class="launchpad-view__local-text">
              <span class="launchpad-view__local-title">{{ localCardLabel(card.kind, card.count) }}</span>
              <span class="launchpad-view__local-sub">{{ card.repoName }}</span>
            </div>
            <button
              type="button"
              class="launchpad-view__pr-action launchpad-view__pr-action--merge"
              @click="emit('open-repo-changes', card.repoPath)"
            >
              {{ cardActionLabel(card.kind) }}
            </button>
          </div>
        </div>

        <!-- 3 urgency tiers: now / waiting / later -->
        <div
          v-for="group in inboxTiers"
          :key="group.tier"
          class="launchpad-view__inbox-section"
        >
          <button
            type="button"
            class="launchpad-view__inbox-header"
            :class="`launchpad-view__inbox-header--${group.tier}`"
            :aria-expanded="!collapsedTiers.has(group.tier)"
            @click.stop="toggleTierCollapse(group.tier)"
          >
            <span class="launchpad-view__tier-icon" aria-hidden="true">
              <svg v-if="group.tier === 'now'" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z"/></svg>
              <svg v-else-if="group.tier === 'waiting'" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M6 2c0 5 12 5 12 0M6 22c0-5 12-5 12 0"/></svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
            </span>
            <span class="launchpad-view__inbox-label">{{ inboxTierLabel(group.tier) }}</span>
            <span class="launchpad-view__inbox-count">{{ group.items.length }}</span>
            <span
              class="launchpad-view__tier-chevron"
              :class="{ 'launchpad-view__tier-chevron--collapsed': collapsedTiers.has(group.tier) }"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </button>
          <ul v-if="!collapsedTiers.has(group.tier)" class="launchpad-view__inbox-list">
            <li
              v-for="item in group.items"
              :key="`${item.pr.repoPath}/${item.pr.number}`"
              class="launchpad-view__inbox-card"
              :class="`launchpad-view__inbox-card--${inboxAccent(item.classification.case)}`"
            >
              <span
                class="launchpad-view__inbox-unread"
                :class="{ 'launchpad-view__inbox-unread--on': group.tier === 'now' }"
                aria-hidden="true"
              ></span>
              <span class="launchpad-view__inbox-type" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="4" cy="4" r="1.6" />
                  <circle cx="4" cy="12" r="1.6" />
                  <circle cx="12" cy="8" r="1.6" />
                  <path d="M4 5.6v4.8M12 9.6V11a1.5 1.5 0 0 1-1.5 1.5H8M12 6.4 12 5" />
                </svg>
              </span>
              <span class="launchpad-view__inbox-avatar" :style="avatarStyle(item.pr.author)">
                {{ avatarInitials(item.pr.author) }}
              </span>
              <div class="launchpad-view__inbox-body">
                <div class="launchpad-view__inbox-line1">
                  <button
                    type="button"
                    class="launchpad-view__pr-link launchpad-view__inbox-title"
                    @click="emit('open-pr', item.pr)"
                  >{{ item.pr.title }}</button>
                  <span
                    v-if="item.pr.checksRollup === 'SUCCESS'"
                    class="launchpad-view__chip launchpad-view__chip--ci-ok"
                  >✓ CI</span>
                  <span
                    v-else-if="item.pr.checksRollup === 'FAILURE'"
                    class="launchpad-view__chip launchpad-view__chip--ci-fail"
                  >✕ CI</span>
                  <span
                    v-else-if="item.pr.checksRollup === 'PENDING'"
                    class="launchpad-view__chip launchpad-view__chip--ci-run"
                  >CI</span>
                  <span
                    v-if="item.pr.reviewDecision === 'APPROVED'"
                    class="launchpad-view__chip launchpad-view__chip--approved"
                  >{{ t("launchpad.prApproved") }}</span>
                </div>
                <div class="launchpad-view__inbox-line2">
                  <span class="launchpad-view__pr-repo">{{ item.pr.repoName }}</span>
                  <span class="launchpad-view__inbox-num">#{{ item.pr.number }}</span>
                  <span
                    class="launchpad-view__inbox-state"
                    :class="`launchpad-view__inbox-state--${inboxAccent(item.classification.case)}`"
                  >
                    <span class="launchpad-view__inbox-state-dot" aria-hidden="true"></span>
                    {{ inboxStateLabel(item.classification.case) }}
                  </span>
                  <span class="launchpad-view__inbox-time">{{ relativeTime(item.pr.updatedAt) }}</span>
                  <span
                    v-if="item.pr.additions > 0 || item.pr.deletions > 0"
                    class="launchpad-view__inbox-diff"
                  >
                    <span class="launchpad-view__inbox-diff-add">+{{ item.pr.additions }}</span>
                    <span class="launchpad-view__inbox-diff-del">−{{ item.pr.deletions }}</span>
                  </span>
                  <span
                    v-for="label in item.pr.labels"
                    :key="label"
                    class="launchpad-view__pr-label"
                  >{{ label }}</span>
                </div>
              </div>
              <button
                type="button"
                class="launchpad-view__pr-action"
                :class="`launchpad-view__pr-action--${item.classification.action}`"
                :title="inboxActionLabel(item.classification.action)"
                @click="emit('open-pr', item.pr)"
              >
                {{ inboxActionLabel(item.classification.action) }}
              </button>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <!-- WIP tab -->
    <div v-if="activeTab === 'wip'" class="launchpad-view__panel">
      <span
        v-if="wipLoading && wip.length > 0"
        class="launchpad-view__refresh-spinner"
        :aria-label="t('launchpad.loading')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
        </svg>
      </span>
      <div v-if="wipError" class="launchpad-view__error">
        {{ t("launchpad.errorFetch", wipError) }}
      </div>
      <div v-else-if="wipLoading && wip.length === 0" class="launchpad-view__loading-block">
        <span class="launchpad-view__spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
          </svg>
        </span>
        <span class="launchpad-view__loading-label">{{ t("launchpad.loading") }}</span>
      </div>
      <p v-else-if="!wipLoading && wip.length === 0" class="launchpad-view__empty">
        {{ t("launchpad.noRepos") }}
      </p>
      <ul v-else class="launchpad-view__repo-list">
        <li
          v-for="item in wip"
          :key="item.path"
          class="launchpad-view__repo-item"
        >
          <span class="launchpad-view__repo-name">{{ item.name }}</span>
          <span class="launchpad-view__repo-branch">{{ item.branch }}</span>
          <span v-if="item.hasNoUpstream" class="launchpad-view__no-upstream">
            {{ t("launchpad.noUpstream") }}
          </span>
          <template v-else>
            <span v-if="item.ahead > 0" class="launchpad-view__ahead">↑{{ item.ahead }}</span>
            <span v-if="item.behind > 0" class="launchpad-view__behind">↓{{ item.behind }}</span>
          </template>
          <template v-if="item.stagedCount === 0 && item.unstagedCount === 0 && item.untrackedCount === 0">
            <span class="launchpad-view__clean">{{ t("launchpad.clean") }}</span>
          </template>
          <template v-else>
            <span v-if="item.stagedCount > 0" class="launchpad-view__staged">
              {{ t("launchpad.staged", item.stagedCount) }}
            </span>
            <span v-if="item.unstagedCount > 0" class="launchpad-view__unstaged">
              {{ t("launchpad.unstaged", item.unstagedCount) }}
            </span>
            <span v-if="item.untrackedCount > 0" class="launchpad-view__untracked">
              {{ t("launchpad.untracked", item.untrackedCount) }}
            </span>
          </template>
          <span v-if="item.lastCommitAt" class="launchpad-view__last-commit">
            {{ t("launchpad.lastCommit", item.lastCommitAt) }}
          </span>
          <span v-if="item.error" class="launchpad-view__repo-error">{{ item.error }}</span>
        </li>
      </ul>
    </div>

    <!-- PRs tab -->
    <div v-if="activeTab === 'prs'" class="launchpad-view__panel">
      <span
        v-if="prsLoading && (allPrs.length > 0 || snoozedPrs.length > 0)"
        class="launchpad-view__refresh-spinner"
        :aria-label="t('launchpad.loading')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
        </svg>
      </span>
      <div v-if="prsError" class="launchpad-view__error">
        {{ t("launchpad.errorFetch", prsError) }}
      </div>
      <div v-else-if="prsLoading && allPrs.length === 0 && snoozedPrs.length === 0" class="launchpad-view__loading-block">
        <span class="launchpad-view__spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
          </svg>
        </span>
        <span class="launchpad-view__loading-label">{{ t("launchpad.loading") }}</span>
      </div>
      <p v-else-if="!prsLoading && allPrs.length === 0 && snoozedPrs.length === 0" class="launchpad-view__empty">
        {{ t("launchpad.noPrs") }}
      </p>
      <ul v-else class="launchpad-view__pr-list">
        <li
          v-for="pr in allPrs"
          :key="`${pr.repoPath}/${pr.number}`"
          class="launchpad-view__pr-item"
        >
          <!-- Pin badge — always visible on pinned items -->
          <span v-if="isPinned(pr.url)" class="launchpad-view__pin-badge" :aria-label="t('launchpad.pinBadge')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .708c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
            </svg>
          </span>
          <span class="launchpad-view__pr-repo">{{ pr.repoName }}</span>
          <span class="launchpad-view__pr-title">
            <button type="button" class="launchpad-view__pr-link" @click="emit('open-pr', pr)">
              #{{ pr.number }} {{ pr.title }}
            </button>
          </span>
          <span v-if="pr.draft" class="launchpad-view__pr-badge launchpad-view__pr-badge--draft">
            {{ t("launchpad.prDraft") }}
          </span>
          <span
            v-if="pr.reviewDecision === 'APPROVED'"
            class="launchpad-view__pr-badge launchpad-view__pr-badge--approved"
          >
            {{ t("launchpad.prApproved") }}
          </span>
          <span
            v-else-if="pr.reviewDecision === 'CHANGES_REQUESTED'"
            class="launchpad-view__pr-badge launchpad-view__pr-badge--changes"
          >
            {{ t("launchpad.prChangesRequested") }}
          </span>
          <span
            v-else-if="pr.reviewDecision === 'REVIEW_REQUIRED'"
            class="launchpad-view__pr-badge launchpad-view__pr-badge--review"
          >
            {{ t("launchpad.prReviewRequired") }}
          </span>
          <span
            v-if="pr.checksRollup === 'SUCCESS'"
            class="launchpad-view__pr-badge launchpad-view__pr-badge--ci-success"
          >
            {{ t("launchpad.prCiSuccess") }}
          </span>
          <span
            v-else-if="pr.checksRollup === 'FAILURE'"
            class="launchpad-view__pr-badge launchpad-view__pr-badge--ci-failure"
          >
            {{ t("launchpad.prCiFailure") }}
          </span>
          <span
            v-else-if="pr.checksRollup === 'PENDING'"
            class="launchpad-view__pr-badge launchpad-view__pr-badge--ci-pending"
          >
            {{ t("launchpad.prCiPending") }}
          </span>
          <span class="launchpad-view__pr-labels">
            <span
              v-for="label in pr.labels"
              :key="label"
              class="launchpad-view__pr-label"
            >{{ label }}</span>
          </span>
          <!-- ⋮ action menu -->
          <div class="launchpad-view__item-menu" @click.stop>
            <button
              class="launchpad-view__menu-btn"
              :class="{ 'launchpad-view__menu-btn--open': openMenuUrl === pr.url }"
              :aria-label="t('launchpad.prMenuLabel', pr.number)"
              @click="toggleMenu(pr.url)"
            >⋮</button>
            <div v-if="openMenuUrl === pr.url" class="launchpad-view__menu-dropdown">
              <button v-if="!isPinned(pr.url)" class="launchpad-view__menu-item" @click="pinAndClose(pr.url, 'pr')">
                <span class="launchpad-view__menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .708c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
                  </svg>
                </span>
                {{ t("launchpad.pin") }}
              </button>
              <button v-else class="launchpad-view__menu-item" @click="unpinAndClose(pr.url)">
                <span class="launchpad-view__menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .708c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
                  </svg>
                </span>
                {{ t("launchpad.unpin") }}
              </button>
              <template v-if="!isSnoozed(pr.url)">
                <button class="launchpad-view__menu-item" @click="openSnoozeFor = pr.url">
                  <span class="launchpad-view__menu-icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                      <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
                    </svg>
                  </span>
                  {{ t("launchpad.snooze") }}
                </button>
                <div v-if="openSnoozeFor === pr.url" class="launchpad-view__snooze-options">
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(pr.url, 'pr', 1)">{{ t("launchpad.snooze1d") }}</button>
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(pr.url, 'pr', 3)">{{ t("launchpad.snooze3d") }}</button>
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(pr.url, 'pr', 7)">{{ t("launchpad.snooze1w") }}</button>
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(pr.url, 'pr', 14)">{{ t("launchpad.snooze2w") }}</button>
                </div>
              </template>
              <button v-else class="launchpad-view__menu-item" @click="unsnoozeAndClose(pr.url)">
                <span class="launchpad-view__menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
                  </svg>
                </span>
                {{ t("launchpad.unsnooze") }}
              </button>
            </div>
          </div>
          <!-- Secondary row: assignees & reviewers (§2.1) -->
          <div
            v-if="(pr.assignees && pr.assignees.length > 0) || (pr.reviewRequested && pr.reviewRequested.length > 0)"
            class="launchpad-view__pr-people"
          >
            <span
              v-if="pr.assignees && pr.assignees.length > 0"
              class="launchpad-view__pr-people-group"
            >
              <span class="launchpad-view__pr-people-label">{{ t("launchpad.assignedShort") }}:</span>
              <span
                v-for="login in pr.assignees.slice(0, 3)"
                :key="`a-${login}`"
                class="launchpad-view__pr-chip launchpad-view__pr-chip--assignee"
              >{{ login }}</span>
              <span
                v-if="pr.assignees.length > 3"
                class="launchpad-view__pr-chip launchpad-view__pr-chip--more"
              >+{{ pr.assignees.length - 3 }}</span>
            </span>
            <span
              v-if="pr.reviewRequested && pr.reviewRequested.length > 0"
              class="launchpad-view__pr-people-group"
            >
              <span class="launchpad-view__pr-people-label">{{ t("launchpad.reviewersShort") }}:</span>
              <span
                v-for="login in pr.reviewRequested.slice(0, 3)"
                :key="`r-${login}`"
                class="launchpad-view__pr-chip launchpad-view__pr-chip--reviewer"
              >{{ login }}</span>
              <span
                v-if="pr.reviewRequested.length > 3"
                class="launchpad-view__pr-chip launchpad-view__pr-chip--more"
              >+{{ pr.reviewRequested.length - 3 }}</span>
            </span>
          </div>
        </li>
      </ul>
      <!-- Per-repo errors -->
      <template v-for="repo in prRepos" :key="repo.repoPath">
        <p v-if="repo.error" class="launchpad-view__repo-error">
          {{ repo.repoName }}: {{ repo.error }}
        </p>
      </template>
      <!-- Snoozed PRs bandeau -->
      <div
        v-if="snoozedPrs.length > 0"
        class="launchpad-view__snoozed-bandeau"
        role="button"
        tabindex="0"
        @click="showSnoozedPrs = !showSnoozedPrs"
        @keydown.enter="showSnoozedPrs = !showSnoozedPrs"
        @keydown.space.prevent="showSnoozedPrs = !showSnoozedPrs"
      >
        <span class="launchpad-view__bandeau-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
          </svg>
        </span>
        {{ t("launchpad.snoozedCount", snoozedPrs.length) }}
        <span v-if="!showSnoozedPrs" class="launchpad-view__snoozed-show-label">{{ t("launchpad.showSnoozed") }} ▼</span>
        <span v-else class="launchpad-view__snoozed-show-label">▲</span>
      </div>
      <ul v-if="showSnoozedPrs && snoozedPrs.length > 0" class="launchpad-view__snoozed-list">
        <li v-for="pr in snoozedPrs" :key="pr.url" class="launchpad-view__snoozed-item">
          <span class="launchpad-view__pr-repo">{{ pr.repoName }}</span>
          <span class="launchpad-view__snoozed-title">{{ pr.title }}</span>
          <span class="launchpad-view__snoozed-until">{{ t("launchpad.snoozedUntil", formatSnoozedUntil(pr.url)) }}</span>
          <button class="launchpad-view__snooze-cancel" @click="unsnooze(pr.url)">
            {{ t("launchpad.unsnooze") }}
          </button>
        </li>
      </ul>
    </div>

    <!-- Issues tab -->
    <div v-if="activeTab === 'issues'" class="launchpad-view__panel">
      <!-- Filter buttons -->
      <div class="launchpad-view__issue-filters">
        <button
          class="launchpad-view__filter-btn"
          :class="{ 'launchpad-view__filter-btn--active': issueFilter === 'assigned' }"
          @click="setIssueFilter('assigned')"
        >
          {{ t("launchpad.issueFilterAssigned") }}
        </button>
        <button
          class="launchpad-view__filter-btn"
          :class="{ 'launchpad-view__filter-btn--active': issueFilter === 'mentioned' }"
          @click="setIssueFilter('mentioned')"
        >
          {{ t("launchpad.issueFilterMentioned") }}
        </button>
        <button
          class="launchpad-view__filter-btn"
          :class="{ 'launchpad-view__filter-btn--active': issueFilter === 'created' }"
          @click="setIssueFilter('created')"
        >
          {{ t("launchpad.issueFilterCreated") }}
        </button>
      </div>

      <span
        v-if="issuesLoading && (allIssues.length > 0 || snoozedIssues.length > 0)"
        class="launchpad-view__refresh-spinner"
        :aria-label="t('launchpad.loading')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
        </svg>
      </span>
      <div v-if="issuesError" class="launchpad-view__error">
        {{ t("launchpad.errorFetch", issuesError) }}
      </div>
      <div v-else-if="issuesLoading && allIssues.length === 0 && snoozedIssues.length === 0" class="launchpad-view__loading-block">
        <span class="launchpad-view__spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
          </svg>
        </span>
        <span class="launchpad-view__loading-label">{{ t("launchpad.loading") }}</span>
      </div>
      <p v-else-if="!issuesLoading && allIssues.length === 0 && snoozedIssues.length === 0" class="launchpad-view__empty">
        {{ t("launchpad.noIssues") }}
      </p>
      <ul v-else class="launchpad-view__issue-list">
        <li
          v-for="issue in allIssues"
          :key="`${issue.repoPath}/${issue.number}`"
          class="launchpad-view__issue-item"
        >
          <!-- Pin badge — always visible on pinned items -->
          <span v-if="isPinned(issue.url)" class="launchpad-view__pin-badge" :aria-label="t('launchpad.pinBadge')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .708c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
            </svg>
          </span>
          <span class="launchpad-view__pr-repo">{{ issue.repoName }}</span>
          <span class="launchpad-view__issue-title">
            <button type="button" class="launchpad-view__pr-link" @click="emit('open-issue', issue)">
              #{{ issue.number }} {{ issue.title }}
            </button>
          </span>
          <span v-if="issue.milestone" class="launchpad-view__issue-milestone">
            {{ t("launchpad.issueMilestone", issue.milestone) }}
          </span>
          <span class="launchpad-view__pr-labels">
            <span
              v-for="label in issue.labels"
              :key="label"
              class="launchpad-view__pr-label"
            >{{ label }}</span>
          </span>
          <!-- ⋮ action menu -->
          <div class="launchpad-view__item-menu" @click.stop>
            <button
              class="launchpad-view__menu-btn"
              :class="{ 'launchpad-view__menu-btn--open': openMenuUrl === issue.url }"
              :aria-label="t('launchpad.issueMenuLabel', issue.number)"
              @click="toggleMenu(issue.url)"
            >⋮</button>
            <div v-if="openMenuUrl === issue.url" class="launchpad-view__menu-dropdown">
              <button v-if="!isPinned(issue.url)" class="launchpad-view__menu-item" @click="pinAndClose(issue.url, 'issue')">
                <span class="launchpad-view__menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .708c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
                  </svg>
                </span>
                {{ t("launchpad.pin") }}
              </button>
              <button v-else class="launchpad-view__menu-item" @click="unpinAndClose(issue.url)">
                <span class="launchpad-view__menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .708c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
                  </svg>
                </span>
                {{ t("launchpad.unpin") }}
              </button>
              <template v-if="!isSnoozed(issue.url)">
                <button class="launchpad-view__menu-item" @click="openSnoozeFor = issue.url">
                  <span class="launchpad-view__menu-icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                      <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
                    </svg>
                  </span>
                  {{ t("launchpad.snooze") }}
                </button>
                <div v-if="openSnoozeFor === issue.url" class="launchpad-view__snooze-options">
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(issue.url, 'issue', 1)">{{ t("launchpad.snooze1d") }}</button>
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(issue.url, 'issue', 3)">{{ t("launchpad.snooze3d") }}</button>
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(issue.url, 'issue', 7)">{{ t("launchpad.snooze1w") }}</button>
                  <button class="launchpad-view__menu-item launchpad-view__menu-item--sub" @click="snoozeAndClose(issue.url, 'issue', 14)">{{ t("launchpad.snooze2w") }}</button>
                </div>
              </template>
              <button v-else class="launchpad-view__menu-item" @click="unsnoozeAndClose(issue.url)">
                <span class="launchpad-view__menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
                    </svg>
                </span>
                {{ t("launchpad.unsnooze") }}
              </button>
            </div>
          </div>
        </li>
      </ul>
      <!-- Per-repo errors -->
      <template v-for="repo in issueRepos" :key="repo.repoPath">
        <p v-if="repo.error" class="launchpad-view__repo-error">
          {{ repo.repoName }}: {{ repo.error }}
        </p>
      </template>
      <!-- Snoozed Issues bandeau -->
      <div
        v-if="snoozedIssues.length > 0"
        class="launchpad-view__snoozed-bandeau"
        role="button"
        tabindex="0"
        @click="showSnoozedIssues = !showSnoozedIssues"
        @keydown.enter="showSnoozedIssues = !showSnoozedIssues"
        @keydown.space.prevent="showSnoozedIssues = !showSnoozedIssues"
      >
        <span class="launchpad-view__bandeau-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
          </svg>
        </span>
        {{ t("launchpad.snoozedCount", snoozedIssues.length) }}
        <span v-if="!showSnoozedIssues" class="launchpad-view__snoozed-show-label">{{ t("launchpad.showSnoozed") }} ▼</span>
        <span v-else class="launchpad-view__snoozed-show-label">▲</span>
      </div>
      <ul v-if="showSnoozedIssues && snoozedIssues.length > 0" class="launchpad-view__snoozed-list">
        <li v-for="issue in snoozedIssues" :key="issue.url" class="launchpad-view__snoozed-item">
          <span class="launchpad-view__pr-repo">{{ issue.repoName }}</span>
          <span class="launchpad-view__snoozed-title">{{ issue.title }}</span>
          <span class="launchpad-view__snoozed-until">{{ t("launchpad.snoozedUntil", formatSnoozedUntil(issue.url)) }}</span>
          <button class="launchpad-view__snooze-cancel" @click="unsnooze(issue.url)">
            {{ t("launchpad.unsnooze") }}
          </button>
        </li>
      </ul>
    </div>

    <!-- ── Team panel ─────────────────────────────────────────── -->
    <div v-if="activeTab === 'team' && teamTabEnabled" class="launchpad-view__panel">
      <!-- Not-loaded placeholder — shown if the user opens the tab and the
           lazy fetch hasn't run yet. Normally setTab("team") kicks loadTeam()
           so we go straight to the loading block; this branch is the safety
           net for race conditions or external callers that flip activeTab. -->
      <div
        v-if="!teamLoaded && !teamLoading && !teamError"
        class="launchpad-view__team-placeholder"
      >
        <p class="launchpad-view__empty">{{ t("launchpad.teamNotLoaded") }}</p>
        <button
          type="button"
          class="launchpad-view__refresh"
          @click.stop="loadTeam"
        >
          {{ t("launchpad.teamLoadButton") }}
        </button>
      </div>
      <!-- In-flight refresh spinner — only after first load when we already
           have prior data (teamActivity > 0). Hidden during the initial fetch
           which renders the loading block below. -->
      <span
        v-if="teamLoaded && teamLoading && teamActivity.length > 0"
        class="launchpad-view__refresh-spinner"
        :aria-label="t('launchpad.loading')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
        </svg>
      </span>
      <!-- Loading (initial / empty cache) -->
      <div v-if="teamLoading && teamActivity.length === 0" class="launchpad-view__loading-block">
        <span class="launchpad-view__spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
          </svg>
        </span>
        <span class="launchpad-view__loading-label">{{ t("launchpad.loading") }}</span>
      </div>

      <!-- Error -->
      <div v-else-if="teamError" class="launchpad-view__error">
        {{ t("launchpad.errorFetch", teamError) }}
      </div>

      <!-- Empty state — only after a successful load, so we don't show
           "no activity" while the placeholder is also showing. -->
      <div v-else-if="teamLoaded && teamActivity.length === 0" class="launchpad-view__empty">
        {{ t("launchpad.noTeamActivity") }}
      </div>

      <!-- Content -->
      <template v-else-if="teamLoaded">
        <!-- Overlaps section -->
        <div
          v-if="membersWithOverlap.length > 0"
          class="launchpad-view__team-section"
        >
          <div class="launchpad-view__team-section-header launchpad-view__team-section-header--overlap">
            <span class="launchpad-view__warning-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
              </svg>
            </span>
            {{
              t(
                "launchpad.teamOverlaps",
                membersWithOverlap.length
              )
            }}
          </div>
          <div
            v-for="member in membersWithOverlap"
            :key="member.login"
            class="launchpad-view__team-member launchpad-view__team-member--overlap"
          >
            <div
              class="launchpad-view__team-member-header"
              @click="toggleTeamMember(member.login)"
              role="button"
              tabindex="0"
              :aria-expanded="expandedTeamMembers.has(member.login)"
              @keydown.enter="toggleTeamMember(member.login)"
              @keydown.space.prevent="toggleTeamMember(member.login)"
            >
              <span
                class="launchpad-view__team-avatar"
                :style="avatarStyle(member.login)"
                aria-hidden="true"
              >{{ avatarInitials(member.login) }}</span>
              <span
                class="launchpad-view__team-login"
                :style="{ color: avatarStyle(member.login).color }"
              >{{ member.login }}</span>
              <span class="launchpad-view__team-pr-count">
                {{ t("launchpad.teamPrCount", member.prs.length) }}
              </span>
              <span class="launchpad-view__team-chevron">
                {{ expandedTeamMembers.has(member.login) ? "▾" : "▸" }}
              </span>
            </div>
            <div v-if="expandedTeamMembers.has(member.login)" class="launchpad-view__team-prs">
              <div
                v-for="pr in member.prs"
                :key="pr.url"
                class="launchpad-view__team-pr-row"
              >
                <span class="launchpad-view__repo-badge">{{ pr.repoName }}</span>
                <button type="button" class="launchpad-view__team-pr-link" @click="emit('open-pr', pr)">
                  #{{ pr.number }} {{ pr.title }}
                </button>
                <template
                  v-for="overlap in ([member.overlappingPrs.find((op) => op.url === pr.url)].filter(Boolean) as OverlappingPr[])"
                  :key="overlap.url"
                >
                  <div class="launchpad-view__overlap-badge">
                    <span class="launchpad-view__warning-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                      </svg>
                    </span>
                    <span>{{ t("launchpad.teamOverlapFiles", overlap.overlappingFiles.length) }}</span>
                    <span>{{
                      overlap.myContext === "wip"
                        ? t("launchpad.teamOverlapViaWip")
                        : t("launchpad.teamOverlapViaBranch")
                    }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- Team section (no overlap) -->
        <div
          v-if="membersWithoutOverlap.length > 0"
          class="launchpad-view__team-section"
        >
          <div class="launchpad-view__team-section-header">
            {{ t("launchpad.teamMembers") }}
          </div>
          <div
            v-for="member in membersWithoutOverlap"
            :key="member.login"
            class="launchpad-view__team-member"
          >
            <div
              class="launchpad-view__team-member-header"
              @click="toggleTeamMember(member.login)"
              role="button"
              tabindex="0"
              :aria-expanded="expandedTeamMembers.has(member.login)"
              @keydown.enter="toggleTeamMember(member.login)"
              @keydown.space.prevent="toggleTeamMember(member.login)"
            >
              <span
                class="launchpad-view__team-avatar"
                :style="avatarStyle(member.login)"
                aria-hidden="true"
              >{{ avatarInitials(member.login) }}</span>
              <span
                class="launchpad-view__team-login"
                :style="{ color: avatarStyle(member.login).color }"
              >{{ member.login }}</span>
              <span class="launchpad-view__team-pr-count">
                {{ t("launchpad.teamPrCount", member.prs.length) }}
              </span>
              <span class="launchpad-view__team-chevron">
                {{ expandedTeamMembers.has(member.login) ? "▾" : "▸" }}
              </span>
            </div>
            <div v-if="expandedTeamMembers.has(member.login)" class="launchpad-view__team-prs">
              <div
                v-for="pr in member.prs"
                :key="pr.url"
                class="launchpad-view__team-pr-row"
              >
                <span class="launchpad-view__repo-badge">{{ pr.repoName }}</span>
                <button type="button" class="launchpad-view__team-pr-link" @click="emit('open-pr', pr)">
                  #{{ pr.number }} {{ pr.title }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
    </div>
  </div>
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────────
 * LaunchpadView — design pass v2.9
 *
 * Every value flows through the global design tokens defined in
 * assets/main.css. Fallbacks are intentionally omitted: the tokens are
 * always defined in :root / [data-theme="*"], so a hex fallback can only
 * mismatch the theme (root cause of the v2.8 "off-color modal" reports).
 *
 * Components mirror existing patterns:
 *   - StashManager.sm-item → hover/border, --color-bg surface
 *   - BaseModal             → overlay, header, modal-style chrome
 *   - PullRequestPanel      → pr-item rows
 * ───────────────────────────────────────────────────────────────────── */

/* ── Main-content layout (replaces the old fixed overlay) ── */
/* LaunchpadView is now a first-class viewMode rendered inside <main>.
   It fills the available height and scrolls internally, matching the
   pattern of DashboardView / PrDetailView. */
.launchpad-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

/* ── Inner frame — scroll container ───────────────────── */
.launchpad-view__frame {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center; /* centre the capped-width content column (mockup layout) */
  gap: var(--space-5);
  padding: var(--space-6) var(--space-7);
  overflow-y: auto;
  min-height: 0;
}

/* Centered content column — caps line length on wide windows, mirrors the mockup. */
.launchpad-view__header,
.launchpad-view__tabs,
.launchpad-view__panel {
  width: 100%;
  max-width: 960px;
}

/* ── Header ────────────────────────────────────────────── */
.launchpad-view__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.launchpad-view__title {
  flex: 1;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
  margin: 0;
}

/* ── Scope selector ────────────────────────────────────── */
.launchpad-view__scope {
  position: relative;
}

.launchpad-view__scope-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.launchpad-view__scope-trigger:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-strong);
}
.launchpad-view__scope-trigger--filtered {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: var(--color-accent);
}
.launchpad-view__scope-caret { font-size: 9px; opacity: 0.7; }

.launchpad-view__scope-menu {
  position: absolute;
  top: calc(100% + var(--space-2));
  left: 0;
  z-index: 50;
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-2);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover, var(--shadow-md));
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.launchpad-view__scope-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.launchpad-view__scope-item:hover { background: var(--color-bg-tertiary); }
.launchpad-view__scope-item--active { color: var(--color-accent); }
.launchpad-view__scope-check {
  width: 14px;
  flex-shrink: 0;
  color: var(--color-accent);
  font-weight: var(--font-weight-semibold);
}
.launchpad-view__scope-sep {
  height: 1px;
  background: var(--color-border);
  margin: var(--space-1) 0;
}

.launchpad-view__refresh {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast);
}

.launchpad-view__refresh:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-strong);
}

.launchpad-view__refresh:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.launchpad-view__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Refresh-all variant (v2.9 §1.4) — same shell, spin-on-loading icon. */
.launchpad-view__refresh--all {
  /* inherits chrome from .launchpad-view__refresh */
}

.launchpad-view__refresh-icon {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}

.launchpad-view__refresh-icon--spin {
  animation: launchpad-spin 0.9s linear infinite;
  transform-origin: 50% 50%;
}

/* ── Error banner ──────────────────────────────────────── */
.launchpad-view__error {
  padding: var(--space-3) var(--space-4);
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}

/* ── Tab bar ───────────────────────────────────────────── */
.launchpad-view__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

/* Pill-chip filters (mockup style) — rounded, bordered, active = filled accent. */
.launchpad-view__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-5);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  transition: color var(--transition-fast), border-color var(--transition-fast),
    background var(--transition-fast);
}

.launchpad-view__tab:hover {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}

.launchpad-view__tab:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-pill);
}

.launchpad-view__tab--active {
  color: var(--color-accent-text);
  background: var(--color-accent);
  border-color: var(--color-accent);
  font-weight: var(--font-weight-semibold);
}

.launchpad-view__tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.launchpad-view__tab--active .launchpad-view__tab-badge {
  background: rgba(255, 255, 255, 0.25);
  color: var(--color-accent-text);
}

/* ── Panel ─────────────────────────────────────────────── */
.launchpad-view__panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: relative;
}

/* ── Empty state ───────────────────────────────────────── */
.launchpad-view__empty {
  color: var(--color-text-muted);
  font-size: var(--font-size-md);
  text-align: center;
  padding: var(--space-9) var(--space-6);
  margin: 0;
}

/* ── WIP list ──────────────────────────────────────────── */
.launchpad-view__repo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.launchpad-view__repo-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-md);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.launchpad-view__repo-item:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-tertiary);
}

.launchpad-view__repo-name {
  font-weight: var(--font-weight-semibold);
  min-width: 120px;
  color: var(--color-text);
}

.launchpad-view__repo-branch {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.launchpad-view__ahead { color: var(--color-success); font-variant-numeric: tabular-nums; }
.launchpad-view__behind { color: var(--color-warning); font-variant-numeric: tabular-nums; }
.launchpad-view__staged { color: var(--color-accent); font-size: var(--font-size-sm); }
.launchpad-view__unstaged { color: var(--color-warning); font-size: var(--font-size-sm); }
.launchpad-view__untracked { color: var(--color-text-muted); font-size: var(--font-size-sm); }
.launchpad-view__clean { color: var(--color-success); font-size: var(--font-size-sm); }
.launchpad-view__no-upstream {
  color: var(--color-text-muted);
  font-style: italic;
  font-size: var(--font-size-sm);
}
.launchpad-view__last-commit {
  color: var(--color-text-subtle);
  font-size: var(--font-size-sm);
  margin-left: auto;
}
.launchpad-view__repo-error {
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}

/* ── Inbox (triaged action inbox) ──────────────────────── */
.launchpad-view__inbox-summary {
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

/* Local action-card band (commit / push / publish / sync) */
.launchpad-view__local-band {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.launchpad-view__local-card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}

.launchpad-view__local-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.launchpad-view__local-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.launchpad-view__local-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.launchpad-view__local-sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.launchpad-view__local-card .launchpad-view__pr-action {
  margin-left: auto;
}

/* Tier section + collapsible header */
.launchpad-view__inbox-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.launchpad-view__inbox-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) 0;
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.launchpad-view__tier-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.launchpad-view__inbox-header--now .launchpad-view__tier-icon { color: var(--color-accent); }
.launchpad-view__inbox-header--waiting .launchpad-view__tier-icon { color: var(--color-warning); }
.launchpad-view__inbox-header--later .launchpad-view__tier-icon { color: var(--color-text-subtle); }

.launchpad-view__inbox-label {
  flex-shrink: 0;
}

.launchpad-view__inbox-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.launchpad-view__tier-chevron {
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  color: var(--color-text-subtle);
  transition: transform var(--transition-fast);
}
.launchpad-view__tier-chevron--collapsed {
  transform: rotate(-90deg);
}

/* Inbox card list */
.launchpad-view__inbox-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.launchpad-view__inbox-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  transition: border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}
.launchpad-view__inbox-card:hover {
  background: var(--color-bg-tertiary);
  box-shadow: var(--shadow-sm);
}
.launchpad-view__inbox-card--success { border-left-color: var(--color-success); }
.launchpad-view__inbox-card--accent  { border-left-color: var(--color-accent); }
.launchpad-view__inbox-card--danger  { border-left-color: var(--color-danger); }
.launchpad-view__inbox-card--warning { border-left-color: var(--color-warning); }
.launchpad-view__inbox-card--info    { border-left-color: var(--color-info); }
.launchpad-view__inbox-card--muted   { border-left-color: var(--color-text-subtle); }

.launchpad-view__inbox-unread {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: var(--radius-pill);
  border: 1.5px solid var(--color-text-subtle);
  background: transparent;
}
.launchpad-view__inbox-unread--on {
  border-color: var(--color-accent);
  background: var(--color-accent);
}

.launchpad-view__inbox-type {
  display: inline-flex;
  align-items: center;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.launchpad-view__inbox-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.02em;
}

.launchpad-view__inbox-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.launchpad-view__inbox-line1 {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.launchpad-view__inbox-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.launchpad-view__inbox-line2 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.launchpad-view__inbox-num {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* Inline CI / review chips */
.launchpad-view__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  line-height: 1.4;
  white-space: nowrap;
  flex-shrink: 0;
}
.launchpad-view__chip--ci-ok,
.launchpad-view__chip--approved { background: var(--color-success-soft); color: var(--color-success); }
.launchpad-view__chip--ci-fail  { background: var(--color-danger-soft); color: var(--color-danger); }
.launchpad-view__chip--ci-run   { background: var(--color-info-soft); color: var(--color-info); }

/* State pill (leading dot, colour by case) */
.launchpad-view__inbox-state {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}
.launchpad-view__inbox-state-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: currentColor;
}
.launchpad-view__inbox-state--success { color: var(--color-success); }
.launchpad-view__inbox-state--accent  { color: var(--color-accent); }
.launchpad-view__inbox-state--danger  { color: var(--color-danger); }
.launchpad-view__inbox-state--warning { color: var(--color-warning); }
.launchpad-view__inbox-state--info    { color: var(--color-info); }
.launchpad-view__inbox-state--muted   { color: var(--color-text-muted); }

.launchpad-view__inbox-time {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.launchpad-view__inbox-diff {
  display: inline-flex;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
.launchpad-view__inbox-diff-add { color: var(--color-success); }
.launchpad-view__inbox-diff-del { color: var(--color-danger); }

/* Primary action button — hierarchy by urgency */
.launchpad-view__pr-action {
  margin-left: auto;
  flex-shrink: 0;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  cursor: pointer;
  transition: filter var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}
.launchpad-view__pr-action:hover { filter: brightness(1.06); }
.launchpad-view__pr-action:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}
/* Solid — high-priority actions */
.launchpad-view__pr-action--merge { background: var(--color-success); color: #fff; }
.launchpad-view__pr-action--review { background: var(--color-accent); color: var(--color-accent-text); }
.launchpad-view__pr-action--resolve { background: var(--color-danger); color: #fff; }
/* Soft — opportunistic */
.launchpad-view__pr-action--autoMerge { background: var(--color-accent-soft); color: var(--color-accent); }
/* Outlined — medium-priority */
.launchpad-view__pr-action--reply,
.launchpad-view__pr-action--seeFailure {
  background: transparent;
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.launchpad-view__pr-action--reply:hover,
.launchpad-view__pr-action--seeFailure:hover {
  background: var(--color-bg-tertiary);
  filter: none;
}
/* Ghost — passive (waiting tier) */
.launchpad-view__pr-action--follow,
.launchpad-view__pr-action--nudge {
  background: transparent;
  color: var(--color-text-muted);
}
.launchpad-view__pr-action--follow:hover,
.launchpad-view__pr-action--nudge:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  filter: none;
}

/* ── PR list ───────────────────────────────────────────── */
.launchpad-view__pr-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.launchpad-view__pr-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-md);
  position: relative;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.launchpad-view__pr-item:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-tertiary);
}

.launchpad-view__pr-repo {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.launchpad-view__pr-title {
  flex: 1;
  min-width: 200px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
}

.launchpad-view__pr-title a {
  color: inherit;
  text-decoration: none;
}

.launchpad-view__pr-title a:hover {
  color: var(--color-accent);
  text-decoration: underline;
}

.launchpad-view__pr-title a:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

/* Internal-nav trigger (opens PrDetailView) — styled to read as a link, not a button. */
.launchpad-view__pr-link {
  padding: 0;
  background: none;
  border: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.launchpad-view__pr-link:hover {
  color: var(--color-accent);
  text-decoration: underline;
}
.launchpad-view__pr-link:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

/* ── Badges (PR review / CI) — token-driven, mirror .badge primitives ── */
.launchpad-view__pr-badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 1.2;
  white-space: nowrap;
}

.launchpad-view__pr-badge--draft {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}
.launchpad-view__pr-badge--approved,
.launchpad-view__pr-badge--ci-success {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.launchpad-view__pr-badge--changes,
.launchpad-view__pr-badge--ci-failure {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.launchpad-view__pr-badge--review,
.launchpad-view__pr-badge--ci-pending {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.launchpad-view__pr-labels {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.launchpad-view__pr-label {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}

/* ── Pin badge ─────────────────────────────────────────── */
.launchpad-view__pin-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-accent);
  line-height: 1;
}

/* Icon slot for menu items (pin / snooze / unsnooze entries). */
.launchpad-view__menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

/* Icon slot for the snoozed bandeau. */
.launchpad-view__bandeau-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

/* Icon slot for warning markers (team overlaps). */
.launchpad-view__warning-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-warning);
}

/* ── ⋮ row menu ────────────────────────────────────────── */
.launchpad-view__item-menu {
  margin-left: auto;
  flex-shrink: 0;
  position: relative;
}

.launchpad-view__menu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  opacity: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: var(--font-size-lg);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  line-height: 1;
  transition: opacity var(--transition-fast), background var(--transition-fast),
    color var(--transition-fast);
}

.launchpad-view__pr-item:hover .launchpad-view__menu-btn,
.launchpad-view__issue-item:hover .launchpad-view__menu-btn,
.launchpad-view__menu-btn--open,
.launchpad-view__menu-btn:focus,
.launchpad-view__menu-btn:focus-visible {
  opacity: 1;
}

.launchpad-view__menu-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.launchpad-view__menu-btn:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.launchpad-view__menu-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + var(--space-2));
  z-index: 100;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
  min-width: 180px;
  padding: var(--space-2) 0;
  animation: launchpad-pop var(--transition-fast) ease-out;
}

@keyframes launchpad-pop {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.launchpad-view__menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-3) var(--space-5);
  background: transparent;
  border: none;
  text-align: left;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  color: var(--color-text);
  white-space: nowrap;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.launchpad-view__menu-item:hover {
  background: var(--color-bg-tertiary);
}

.launchpad-view__menu-item:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

/* Sub items (snooze durations) have no leading icon — keep them visually
   indented past where the icon column would sit on the parent rows. */
.launchpad-view__menu-item--sub {
  padding-left: calc(var(--space-5) + 14px + var(--space-2));
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.launchpad-view__snooze-options {
  border-top: 1px solid var(--color-border);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
}

/* ── Snoozed bandeau ───────────────────────────────────── */
.launchpad-view__snoozed-bandeau {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  user-select: none;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast);
}

.launchpad-view__snoozed-bandeau:hover {
  background: var(--color-bg);
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.launchpad-view__snoozed-bandeau:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.launchpad-view__snoozed-show-label {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--color-text-subtle);
}

.launchpad-view__snoozed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.launchpad-view__snoozed-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
  opacity: 0.8;
  transition: opacity var(--transition-fast);
}

.launchpad-view__snoozed-item:hover {
  opacity: 1;
}

.launchpad-view__snoozed-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

.launchpad-view__snoozed-until {
  font-size: var(--font-size-xs);
  color: var(--color-text-subtle);
  white-space: nowrap;
}

.launchpad-view__snooze-cancel {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  cursor: pointer;
  color: var(--color-text);
  flex-shrink: 0;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast);
}

.launchpad-view__snooze-cancel:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.launchpad-view__snooze-cancel:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

/* ── Issue filters ─────────────────────────────────────── */
.launchpad-view__issue-filters {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.launchpad-view__filter-btn {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  cursor: pointer;
  color: var(--color-text-muted);
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);
}

.launchpad-view__filter-btn:hover {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}

.launchpad-view__filter-btn:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.launchpad-view__filter-btn--active {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}

.launchpad-view__filter-btn--active:hover {
  background: var(--color-accent-hover);
  color: var(--color-accent-text);
  border-color: var(--color-accent-hover);
}

/* ── Issue list ────────────────────────────────────────── */
.launchpad-view__issue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.launchpad-view__issue-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-md);
  position: relative;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.launchpad-view__issue-item:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-tertiary);
}

.launchpad-view__issue-title {
  flex: 1;
  min-width: 200px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
}

.launchpad-view__issue-title a {
  color: inherit;
  text-decoration: none;
}

.launchpad-view__issue-title a:hover {
  color: var(--color-accent);
  text-decoration: underline;
}

.launchpad-view__issue-title a:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

.launchpad-view__issue-milestone {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

/* ── Team panel ────────────────────────────────────────── */
.launchpad-view__team-section {
  margin-bottom: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.launchpad-view__team-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.launchpad-view__team-section-header--overlap {
  color: var(--color-warning);
}

.launchpad-view__team-member {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg-secondary);
  transition: border-color var(--transition-fast);
}

.launchpad-view__team-member:hover {
  border-color: var(--color-border-strong);
}

.launchpad-view__team-member--overlap {
  border-color: var(--color-warning);
  background: var(--color-warning-soft);
}

.launchpad-view__team-member--overlap:hover {
  border-color: var(--color-warning);
}

.launchpad-view__team-member-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  user-select: none;
  transition: background var(--transition-fast);
}

.launchpad-view__team-member-header:hover {
  background: var(--color-bg-tertiary);
}

.launchpad-view__team-member--overlap .launchpad-view__team-member-header:hover {
  background: transparent;
}

.launchpad-view__team-member-header:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

.launchpad-view__team-avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-pill);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  flex-shrink: 0;
  border: 1.5px solid currentColor;
}

.launchpad-view__team-login {
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-md);
}

.launchpad-view__team-pr-count {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.launchpad-view__team-chevron {
  margin-left: auto;
  color: var(--color-text-subtle);
  font-size: var(--font-size-xs);
}

.launchpad-view__team-prs {
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.launchpad-view__team-pr-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  transition: border-color var(--transition-fast);
}

.launchpad-view__team-pr-row:hover {
  border-color: var(--color-border-strong);
}

.launchpad-view__repo-badge {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.launchpad-view__overlap-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-warning);
  padding: var(--space-1) var(--space-3);
  background: var(--color-warning-soft);
  border-radius: var(--radius-sm);
  margin-top: var(--space-1);
  flex-basis: 100%;
}

.launchpad-view__team-pr-link {
  color: var(--color-text);
  text-decoration: none;
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-sm);
  /* Button reset — renders as a link but navigates in-app (emits open-pr). */
  padding: 0;
  background: none;
  border: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.launchpad-view__team-pr-link:hover {
  color: var(--color-accent);
  text-decoration: underline;
}

.launchpad-view__team-pr-link:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

/* ── Loading / spinner (§2.2) ──────────────────────────── */
@keyframes launchpad-spin {
  to { transform: rotate(360deg); }
}

.launchpad-view__loading-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-9) 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-md);
}

/* Team tab lazy-load placeholder (§2.3) */
.launchpad-view__team-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-10) var(--space-6);
  text-align: center;
  background: var(--color-bg-secondary);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
}

.launchpad-view__team-placeholder .launchpad-view__empty {
  padding: 0;
  margin: 0;
}

.launchpad-view__spinner {
  display: inline-flex;
  color: var(--color-accent);
  animation: launchpad-spin 0.9s linear infinite;
}

.launchpad-view__loading-label {
  font-size: var(--font-size-md);
}

.launchpad-view__refresh-spinner {
  position: absolute;
  top: 0;
  right: var(--space-2);
  display: inline-flex;
  color: var(--color-accent);
  animation: launchpad-spin 0.9s linear infinite;
  z-index: 1;
  pointer-events: none;
}

/* ── PR people row (§2.1) ──────────────────────────────── */
.launchpad-view__pr-people {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px dashed var(--color-border);
  font-size: var(--font-size-xs);
}

.launchpad-view__pr-people-group {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.launchpad-view__pr-people-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: var(--font-weight-semibold);
}

.launchpad-view__pr-chip {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

.launchpad-view__pr-chip--assignee {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.launchpad-view__pr-chip--reviewer {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.launchpad-view__pr-chip--more {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-style: italic;
}
</style>
