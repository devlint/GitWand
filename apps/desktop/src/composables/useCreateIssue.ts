/**
 * The "New issue" form (#301): where the issue goes, its fields, the label /
 * assignee / milestone pickers and the submit. One instance, created by
 * `App.vue` and provided under `CREATE_ISSUE_KEY`; every entry point (toolbar,
 * ⌘K, ⌘⇧I) calls `open(prefill?)`, a commit's menu `openFromCommit(entry)`.
 */

import { computed, ref, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { ForgeProvider } from "./forge/types";
import { gitExec } from "../utils/backend";
import type {
  CreatedIssue,
  GitLogEntry,
  IssueTarget,
  RepoLabel,
  RepoMilestone,
  ReviewerCandidate,
} from "../utils/backend";
import { commitIssuePrefill, commitUrlFor, type IssuePrefill } from "../utils/issuePrefill";

/** True when a remote-tracking branch of `origin` contains `sha`. */
async function gitCommitOnOrigin(cwd: string, sha: string): Promise<boolean> {
  const r = await gitExec(cwd, ["for-each-ref", "--contains", sha, "--count=1", "--format=%(refname)", "refs/remotes/origin/"]);
  return r.exitCode === 0 && r.stdout.trim() !== "";
}

/** The "New issue" shortcut as shown to the user. */
export function newIssueShortcutLabel(mac: boolean): string {
  return mac ? "⌘⇧I" : "Ctrl+Alt+I";
}

/** A text field, an editable element or the terminal: where keys type. */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { closest?: (s: string) => Element | null }) | null;
  if (!el || typeof el !== "object") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true ||
    !!el.closest?.(".xterm")
  );
}

/**
 * The "New issue" shortcut: ⌘⇧I on macOS; Ctrl+Alt+I elsewhere, where
 * Ctrl+Shift+I belongs to the WebView's inspector. Off macOS Ctrl+Alt is
 * also AltGr, which types characters on many layouts: never taken from AltGr
 * nor where the user is typing.
 */
export function isNewIssueShortcut(e: KeyboardEvent, mac: boolean): boolean {
  if (e.key !== "I" && e.key !== "i") return false;
  if (mac) return e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey;
  if (e.getModifierState?.("AltGraph") || isTypingTarget(e.target)) return false;
  return e.ctrlKey && e.altKey && !e.metaKey;
}

/** A failed availability check is retried on window focus at most this often. */
const FOCUS_RETRY_MS = 60_000;

export interface CreateIssueApi {
  isOpen: Ref<boolean>;
  /** The current repository has somewhere to file an issue (GitHub `origin`). */
  available: Ref<boolean>;
  /** Targets are being read when the form opens. */
  loading: Ref<boolean>;
  /** Reading the targets failed: nothing can be filed until the form reopens. */
  targetsFailed: Ref<boolean>;
  /** The open form's targets (those of the repository it was opened for). */
  targets: Ref<IssueTarget[]>;
  /** The selected target, `null` when none has issues turned on. */
  repo: Ref<string | null>;
  title: Ref<string>;
  body: Ref<string>;
  labels: Ref<string[]>;
  assignees: Ref<string[]>;
  milestone: Ref<number | null>;
  labelOptions: Ref<RepoLabel[]>;
  assigneeOptions: Ref<ReviewerCandidate[]>;
  milestoneOptions: Ref<RepoMilestone[]>;
  submitting: Ref<boolean>;
  error: Ref<string | null>;
  /** Something was typed or picked since the form opened. */
  dirty: ComputedRef<boolean>;
  canSubmit: ComputedRef<boolean>;
  /** The current repository's `origin` page, for commit links (GitHub Enterprise included). */
  originHtmlUrl: ComputedRef<string | null>;
  refreshAvailability(): Promise<void>;
  /** On window focus: retry a failed or negative check, at most once a minute. */
  refreshOnFocus(): Promise<void>;
  /** Drop the targets of the repository being left, before the next one is read. */
  forgetTargets(): void;
  /**
   * Open the form. A prefill given as a promise (a commit's, which needs a
   * git check first) lands when ready: the form shows at once.
   */
  open(prefill?: IssuePrefill | Promise<IssuePrefill>): Promise<void>;
  /**
   * "Create issue from commit": the form opens at once, prefilled from
   * `entry`; the commit is linked only once `origin` has it (the link goes to
   * origin's page, so a commit only elsewhere would answer 404).
   */
  openFromCommit(entry: GitLogEntry): Promise<void>;
  close(): void;
  setRepo(repo: string): void;
  submit(): Promise<void>;
}

export const CREATE_ISSUE_KEY: InjectionKey<CreateIssueApi> = Symbol("createIssue");

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useCreateIssue(deps: {
  cwd: Readonly<Ref<string | null>>;
  provider: Readonly<Ref<ForgeProvider | null>>;
  onCreated: (issue: CreatedIssue) => void;
  /** Whether `origin` has the commit (tests replace the git check). */
  commitOnOrigin?: (cwd: string, sha: string) => Promise<boolean>;
  /** Clock, for the focus retry interval (tests replace it). */
  now?: () => number;
}): CreateIssueApi {
  const now = deps.now ?? Date.now;
  let lastFocusCheck = -Infinity;
  const commitOnOrigin = deps.commitOnOrigin ?? gitCommitOnOrigin;
  const isOpen = ref(false);
  const available = ref(false);
  const loading = ref(false);
  const targetsFailed = ref(false);
  const targets = ref<IssueTarget[]>([]);
  // The current repository's targets, for availability and commit links;
  // kept apart from the open form's, which may belong to the previous one.
  const repoTargets = ref<IssueTarget[]>([]);
  const repo = ref<string | null>(null);
  const title = ref("");
  const body = ref("");
  const labels = ref<string[]>([]);
  const assignees = ref<string[]>([]);
  const milestone = ref<number | null>(null);
  const labelOptions = ref<RepoLabel[]>([]);
  const assigneeOptions = ref<ReviewerCandidate[]>([]);
  const milestoneOptions = ref<RepoMilestone[]>([]);
  const submitting = ref(false);
  const error = ref<string | null>(null);
  const initial = ref<IssuePrefill>({ title: "", body: "" });
  // The repository the open form files on: an app tab switch while it is open
  // must not send the issue (or its picker reads) somewhere else.
  let formCwd: string | null = null;

  // Bumped by every open, target switch and close: an answer that comes back
  // under an older value belongs to a form that is no longer on screen.
  let generation = 0;
  // Bumped only when the form is (re)opened or closed: a target switch does
  // not discard the prefill still on its way.
  let openGeneration = 0;
  let availabilitySeq = 0;

  const dirty = computed(
    () =>
      title.value !== initial.value.title ||
      body.value !== initial.value.body ||
      labels.value.length > 0 ||
      assignees.value.length > 0 ||
      milestone.value !== null,
  );
  const canSubmit = computed(
    () => isOpen.value && !!repo.value && title.value.trim() !== "" && !submitting.value,
  );
  const originHtmlUrl = computed(() => repoTargets.value.find((t) => t.isOrigin)?.htmlUrl || null);

  async function readTargets(cwd: string | null, fresh: boolean): Promise<IssueTarget[] | null> {
    const p = deps.provider.value;
    if (!p?.issueTargets || !cwd) return [];
    try {
      const t = await p.issueTargets(cwd, fresh);
      return t.targets;
    } catch {
      return null;
    }
  }

  async function refreshAvailability(): Promise<void> {
    const seq = ++availabilitySeq;
    // The backend's cached answer: this runs on every repository switch.
    const t = await readTargets(deps.cwd.value, false);
    // A failed read keeps the last answer: one network error must not hide
    // the action until the repository is switched.
    if (seq !== availabilitySeq || t === null) return;
    repoTargets.value = t;
    available.value = t.length > 0;
  }

  async function refreshOnFocus(): Promise<void> {
    if (available.value || !deps.cwd.value) return;
    if (now() - lastFocusCheck < FOCUS_RETRY_MS) return;
    lastFocusCheck = now();
    await refreshAvailability();
  }

  function forgetTargets() {
    availabilitySeq++;
    repoTargets.value = [];
    available.value = false;
  }

  function clearPickers() {
    labels.value = [];
    assignees.value = [];
    milestone.value = null;
    labelOptions.value = [];
    assigneeOptions.value = [];
    milestoneOptions.value = [];
  }

  function loadPickers(target: string) {
    const p = deps.provider.value;
    const cwd = formCwd;
    // Without triage rights GitHub drops labels, assignees and milestone
    // silently: not offering them is better than a success that lost them.
    const canTriage = targets.value.find((t) => t.repo === target)?.canTriage ?? false;
    if (!p || !cwd || !canTriage) return;
    const gen = generation;
    const current = () => gen === generation && repo.value === target;
    // Each list is optional: a read GitHub refuses (no triage rights) leaves it empty.
    p.listLabels?.(cwd, target).then((v) => { if (current()) labelOptions.value = v; }, () => {});
    p.listMilestones?.(cwd, target).then((v) => { if (current()) milestoneOptions.value = v; }, () => {});
    p.listAssignees?.(cwd, target).then((v) => { if (current()) assigneeOptions.value = v; }, () => {});
  }

  function reset() {
    generation++;
    openGeneration++;
    repo.value = null;
    title.value = "";
    body.value = "";
    error.value = null;
    targetsFailed.value = false;
    submitting.value = false;
    initial.value = { title: "", body: "" };
    clearPickers();
  }

  async function open(prefill?: IssuePrefill | Promise<IssuePrefill>): Promise<void> {
    // Already open (⌘⇧I again, the palette): never wipe what is being typed,
    // nor drop the answer of a create in flight.
    if (isOpen.value) return;
    reset();
    const gen = generation;
    const openGen = openGeneration;
    formCwd = deps.cwd.value;
    isOpen.value = true;
    loading.value = true;
    // A cached availability read still in flight is older than this one.
    const seq = ++availabilitySeq;
    const pending = Promise.resolve(prefill).catch(() => undefined);
    const t = await readTargets(formCwd, true);
    if (gen !== generation) return;
    loading.value = false;
    targetsFailed.value = t === null;
    if (t !== null) {
      targets.value = t;
      // A fresh answer for the repository still on screen also refreshes its
      // availability.
      if (formCwd === deps.cwd.value && seq === availabilitySeq) {
        repoTargets.value = t;
        available.value = t.length > 0;
      }
      const first = targets.value.find((x) => x.hasIssues);
      repo.value = first?.repo ?? null;
      if (repo.value) loadPickers(repo.value);
    }
    // The form is on screen; the prefill (a commit's, after its git check)
    // lands when ready, unless the user has started typing meanwhile.
    const filled = await pending;
    if (openGen !== openGeneration || !filled) return;
    if (title.value !== initial.value.title || body.value !== initial.value.body) return;
    initial.value = { title: filled.title, body: filled.body };
    title.value = filled.title;
    body.value = filled.body;
  }


  async function openFromCommit(entry: GitLogEntry): Promise<void> {
    const cwd = deps.cwd.value;
    const origin = originHtmlUrl.value;
    if (!cwd || !available.value) return;
    const prefill = (async () => {
      let onOrigin = false;
      try {
        onOrigin = await commitOnOrigin(cwd, entry.hashFull);
      } catch {
        /* unknown → unlinked, never a 404 link */
      }
      return commitIssuePrefill(entry, onOrigin && origin ? commitUrlFor(origin, entry.hashFull) : null);
    })();
    await open(prefill);
  }

  function setRepo(next: string) {
    // The issue being created goes where it was sent; switching now would
    // drop its answer (and the notice that it was created).
    if (submitting.value || next === repo.value) return;
    const target = targets.value.find((t) => t.repo === next);
    if (!target?.hasIssues) return;
    generation++;
    repo.value = next;
    // Labels, people and milestones belong to one repository.
    clearPickers();
    loadPickers(next);
  }

  function close() {
    isOpen.value = false;
    loading.value = false;
    reset();
  }

  async function submit(): Promise<void> {
    const p = deps.provider.value;
    const cwd = formCwd;
    if (!canSubmit.value || !p?.createIssue || !cwd || !repo.value) return;
    // Set before the first await: a second call in the same tick sees it.
    submitting.value = true;
    error.value = null;
    const gen = generation;
    try {
      const created = await p.createIssue(cwd, {
        repo: repo.value,
        title: title.value,
        body: body.value,
        labels: [...labels.value],
        assignees: [...assignees.value],
        milestone: milestone.value,
      });
      if (gen !== generation) return;
      deps.onCreated(created);
      close();
    } catch (e) {
      if (gen !== generation) return;
      error.value = message(e);
    } finally {
      if (gen === generation) submitting.value = false;
    }
  }

  return {
    isOpen,
    available,
    loading,
    targetsFailed,
    targets,
    repo,
    title,
    body,
    labels,
    assignees,
    milestone,
    labelOptions,
    assigneeOptions,
    milestoneOptions,
    submitting,
    error,
    dirty,
    canSubmit,
    originHtmlUrl,
    refreshAvailability,
    refreshOnFocus,
    forgetTargets,
    open,
    openFromCommit,
    close,
    setRepo,
    submit,
  };
}
