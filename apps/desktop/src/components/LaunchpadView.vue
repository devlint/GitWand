<script setup lang="ts">
import { ref, onMounted, computed, watch, toRef, inject } from "vue";
import { saveSettings as persistAppSettings } from "../composables/useSettings";
import { avatarStyle, avatarInitials } from "../composables/useAvatar";
import { useLaunchpadWip } from "../composables/useLaunchpadWip";
import { useLaunchpadPrs } from "../composables/useLaunchpadPrs";
import { useLaunchpadInbox, type InboxAction, type InboxCase } from "../composables/useLaunchpadInbox";
import { useLaunchpadIssues } from "../composables/useLaunchpadIssues";
import { useLaunchpadScope } from "../composables/useLaunchpadScope";
import { useRepoActionCards, type RepoCardKind } from "../composables/useRepoActionCards";
import { useLaunchpadTeam } from "../composables/useLaunchpadTeam";
import type { TeamMemberActivity, OverlappingPr } from "../composables/useLaunchpadTeam";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";
import { OPEN_SETTINGS_KEY } from "../composables/branchPickerBridge";
import type { ForgeName } from "../composables/forge/types";
import type { WorkspaceRepo } from "../utils/backend";
import type { PrWithRepo } from "../composables/useLaunchpadPrs";
import type { IssueWithRepo } from "../composables/useLaunchpadIssues";

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

const { wip, loading: wipLoading, refresh: refreshWip } = useLaunchpadWip();
const { allPrs, needsConnection: prNeedsConnection, loading: prsLoading, error: prsError, refresh: refreshPrs } = useLaunchpadPrs();
// Issues — declared early so allIssues can be passed into useLaunchpadInbox below.
const { allIssues, loading: issuesLoading, refresh: refreshIssues } = useLaunchpadIssues();
// Inbox — unified fixed-section inbox: mine / assigned / review / issues / deps.
const { nowCount, totalCount: inboxTotal, loadUser: loadInboxUser, sections } = useLaunchpadInbox(allPrs, allIssues);

// Local action cards (commit / push / publish / sync) derived from cross-repo
// WIP — prepended as the "repos" section above the PR/issue sections.
const { cards: localCards, totalCount: localTotal } = useRepoActionCards(wip);
/** Total inbox items = local action cards + PR/issue sections (drives badge + empty state). */
const inboxCount = computed(() => localTotal.value + inboxTotal.value);

/** i18n label for an inbox action button. */
function inboxActionLabel(action: InboxAction): string {
  return t(`launchpad.action.${action}`);
}

// Ephemeral collapsed-section state (keyed by section.key).
// Use a new Set on each toggle so Vue detects the reference change and re-renders.
const collapsedSections = ref<Set<string>>(new Set());
function toggleSectionCollapse(sectionKey: string): void {
  const next = new Set(collapsedSections.value);
  if (next.has(sectionKey)) next.delete(sectionKey);
  else next.add(sectionKey);
  collapsedSections.value = next;
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
  assigned: "info",
  issue: "accent",
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
const {
  teamActivity,
  loading: teamLoading,
  error: teamError,
  refresh: refreshTeam,
} = useLaunchpadTeam();

// Phase 2: the tab model collapses to "inbox" (unified list) | "team" (secondary).
// Legacy values from Phase 1 ("wip"|"prs"|"issues") are migrated to "inbox" at read time.
type ActiveTab = "inbox" | "team";

// Persist active tab across openings. Legacy values migrate to "inbox".
const activeTab = computed<ActiveTab>({
  get: () => {
    const raw = settings.value.launchpadActiveTab;
    // Migrate legacy tab values to "inbox"
    return (raw === "team") ? "team" : "inbox";
  },
  set: (val) => {
    settings.value.launchpadActiveTab = val;
    persistAppSettings(settings.value);
  },
});

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

function setTab(tab: ActiveTab) {
  activeTab.value = tab;
  // Lazy fetch on first visit to the Team tab. After this, the Refresh
  // button re-fetches but `teamLoaded` stays true so the placeholder is
  // gone for good.
  if (tab === "team" && !teamLoaded.value && teamTabEnabled.value) {
    loadTeam();
  }
}

function handleRefresh() {
  if (activeTab.value === "team") {
    loadTeam();
  } else {
    // Unified inbox: refresh all data sources.
    refreshWip(scopedRepos.value);
    refreshPrs(scopedRepos.value);
    refreshIssues(scopedRepos.value);
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

const isLoading = () => wipLoading.value || prsLoading.value || issuesLoading.value || teamLoading.value;

function closeMenu(): void {
  scopeMenuOpen.value = false;
}

// ── Forge connect banner helpers ──────────────────────────────────────────
const openSettings = inject(OPEN_SETTINGS_KEY, undefined);

function forgeLabel(forge: ForgeName): string {
  return t(`forgeConnect.${forge}` as Parameters<typeof t>[0]);
}

function openSettingsAccounts(): void {
  openSettings?.("accounts");
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

    <!-- Surface bar: unified inbox pill + Team secondary pill -->
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
      <!-- Team: secondary surface, lazy-loaded, preserved lazy-load contract -->
      <button
        v-if="teamTabEnabled"
        class="launchpad-view__tab launchpad-view__tab--team"
        :class="{ 'launchpad-view__tab--active': activeTab === 'team' }"
        @click="setTab('team')"
      >
        {{ t("launchpad.teamTab") }}
      </button>
    </div>

    <!-- Inbox tab — fixed-section scrolling inbox: repos + mine + assigned + review + issues + deps -->
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
      <!-- Per-forge "connect your account" banners (multi-forge Today) — independent of loading state -->
      <div
        v-for="forge in prNeedsConnection"
        :key="forge"
        class="launchpad-view__forge-banner"
        @click="openSettingsAccounts()"
      >
        <span>{{ t("forgeConnect.banner", forgeLabel(forge)) }}</span>
        <button
          type="button"
          class="launchpad-view__forge-banner-action"
          @click.stop="openSettingsAccounts()"
        >{{ t("forgeConnect.action") }}</button>
      </div>
      <div v-if="prsError" class="launchpad-view__error">
        {{ t("launchpad.errorFetch", prsError ?? "") }}
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

        <!-- Section 1: Repo status — local action cards (commit / push / publish / sync). ALWAYS FIRST. -->
        <div v-if="localCards.length > 0" class="launchpad-view__inbox-section" data-section="repos">
          <button
            type="button"
            class="launchpad-view__inbox-header"
            :aria-expanded="!collapsedSections.has('repos')"
            @click.stop="toggleSectionCollapse('repos')"
          >
            <span class="launchpad-view__inbox-label">{{ t("launchpad.section.repos") }}</span>
            <span class="launchpad-view__inbox-count">{{ localCards.length }}</span>
            <span
              class="launchpad-view__tier-chevron"
              :class="{ 'launchpad-view__tier-chevron--collapsed': collapsedSections.has('repos') }"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </button>
          <div v-if="!collapsedSections.has('repos')" class="launchpad-view__local-band">
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
        </div>

        <!-- Sections 2-6: mine / assigned / review / issues / deps (non-empty only, fixed order) -->
        <div
          v-for="section in sections"
          :key="section.key"
          class="launchpad-view__inbox-section"
          :data-section="section.key"
        >
          <button
            type="button"
            class="launchpad-view__inbox-header"
            :aria-expanded="!collapsedSections.has(section.key)"
            @click.stop="toggleSectionCollapse(section.key)"
          >
            <span class="launchpad-view__inbox-label">{{ t(section.titleKey) }}</span>
            <span class="launchpad-view__inbox-count">{{ section.count }}</span>
            <span
              class="launchpad-view__tier-chevron"
              :class="{ 'launchpad-view__tier-chevron--collapsed': collapsedSections.has(section.key) }"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </button>
          <ul v-if="!collapsedSections.has(section.key)" class="launchpad-view__inbox-list">
            <li
              v-for="item in section.items"
              :key="item.pr ? `pr:${item.pr.repoPath}/${item.pr.number}` : `issue:${item.issue?.repoPath}/${item.issue?.number}`"
              class="launchpad-view__inbox-card"
              :class="`launchpad-view__inbox-card--${inboxAccent(item.classification.case)}`"
            >
              <span
                class="launchpad-view__inbox-unread"
                :class="{ 'launchpad-view__inbox-unread--on': item.classification.tier === 'now' }"
                aria-hidden="true"
              ></span>
              <!-- PR item -->
              <template v-if="item.pr">
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
              </template>
              <!-- Issue item -->
              <template v-else-if="item.issue">
                <span class="launchpad-view__inbox-type" aria-hidden="true">
                  <!-- Issue icon (circle with dot) -->
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="8" cy="8" r="6" />
                    <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <span class="launchpad-view__inbox-avatar" :style="avatarStyle(item.issue.author)">
                  {{ avatarInitials(item.issue.author) }}
                </span>
                <div class="launchpad-view__inbox-body">
                  <div class="launchpad-view__inbox-line1">
                    <button
                      type="button"
                      class="launchpad-view__pr-link launchpad-view__inbox-title"
                      @click="emit('open-issue', item.issue)"
                    >{{ item.issue.title }}</button>
                  </div>
                  <div class="launchpad-view__inbox-line2">
                    <span class="launchpad-view__pr-repo">{{ item.issue.repoName }}</span>
                    <span class="launchpad-view__inbox-num">#{{ item.issue.number }}</span>
                    <span class="launchpad-view__inbox-time">{{ relativeTime(item.issue.updatedAt) }}</span>
                  </div>
                </div>
                <button
                  type="button"
                  class="launchpad-view__pr-action launchpad-view__pr-action--view"
                  :title="inboxActionLabel(item.classification.action)"
                  @click="emit('open-issue', item.issue)"
                >
                  {{ inboxActionLabel(item.classification.action) }}
                </button>
              </template>
            </li>
          </ul>
        </div>
      </template>
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
        {{ t("launchpad.errorFetch", teamError ?? "") }}
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

.launchpad-view__pr-repo {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  white-space: nowrap;
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
  border-radius: var(--radius-md);
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

/* ── Forge connect banner ──────────────────────────────── */
.launchpad-view__forge-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin: 6px 0;
  border: 1px solid var(--gw-border-soft, #2a2a3a);
  border-radius: 8px;
  background: var(--gw-bg-elev, rgba(255,255,255,0.03));
  font-size: 13px;
  cursor: pointer;
}
.launchpad-view__forge-banner:hover {
  background: var(--color-bg-secondary);
}
.launchpad-view__forge-banner-action {
  white-space: nowrap;
  flex-shrink: 0;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-strong);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}
.launchpad-view__forge-banner-action:hover {
  background: var(--color-bg-tertiary);
}


</style>
