/**
 * The "New issue" form (#301): where the issue goes, its fields, the label /
 * assignee / milestone pickers and the submit. One instance, created by
 * `App.vue` and provided under `CREATE_ISSUE_KEY`; every entry point (toolbar,
 * ⌘K, ⌘⇧I) calls `open(prefill?)`, a commit's menu `openFromCommit(entry)`.
 */

import { computed, ref, shallowRef, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { ForgeProvider } from "./forge/types";
import { gitExec } from "../utils/backend";
import type {
  CreatedIssue,
  GitLogEntry,
  IssueTarget,
  IssueTargets,
  RepoLabel,
  RepoMilestone,
  ReviewerCandidate,
} from "../utils/backend";
import {
  blobPermalink,
  commitIssuePrefill,
  commitUrlFor,
  permalinkSpan,
  selectionIssuePrefill,
  type DiffSelection,
  type IssuePrefill,
} from "../utils/issuePrefill";

type GitRun = (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Whether a remote-tracking branch of `origin` contains a commit, run with
 * `exec` (the app's `gitExec`; tests give a real git).
 */
export function commitOnOriginWith(exec: GitRun) {
  return async (cwd: string, sha: string): Promise<boolean> => {
    const r = await exec(cwd, ["for-each-ref", "--contains", sha, "--count=1", "--format=%(refname)", "refs/remotes/origin/"]);
    return r.exitCode === 0 && r.stdout.trim() !== "";
  };
}

const gitCommitOnOrigin = commitOnOriginWith(gitExec);

/** Prefixed by `gh_create_issue` (Rust `MAY_HAVE_BEEN_CREATED`) to an error
 *  after which GitHub may have filed the issue anyway. */
const MAY_HAVE_BEEN_CREATED = "[may-have-been-created] ";

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

export interface CreateIssueApi {
  isOpen: Ref<boolean>;
  /** The current repository's `origin` is on GitHub (a local check, no request). */
  available: Ref<boolean>;
  /** Targets are being read when the form opens. */
  loading: Ref<boolean>;
  /** Reading the targets failed: nothing can be filed until the form reopens. */
  targetsFailed: Ref<boolean>;
  /** Why the targets could not be read (the backend's message: sign in…). */
  targetsError: Ref<string | null>;
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
  /**
   * The create failed after it was sent (a timeout, a dropped connection, a
   * 5xx): GitHub may have filed the issue anyway.
   * Create stays off until the user checks, or chooses to send it again.
   */
  outcomeUnknown: Ref<boolean>;
  /** Send the issue again after an unknown outcome (the user checked GitHub). */
  retryAnyway(): void;
  /** Something was typed or picked since the form opened. */
  dirty: ComputedRef<boolean>;
  canSubmit: ComputedRef<boolean>;
  /** The open form's `origin` page, for commit links (GitHub Enterprise included). */
  originHtmlUrl: ComputedRef<string | null>;
  refreshAvailability(): Promise<void>;
  /** The repository is being left: hide the entry points until the next check. */
  forgetAvailability(): void;
  /**
   * Open the form. A prefill can be built once the targets are read (it is
   * given `origin`'s page, for links); it lands when ready, the form showing
   * at once.
   */
  open(prefill?: IssuePrefill | ((originHtmlUrl: string | null) => Promise<IssuePrefill>)): Promise<void>;
  /**
   * "Create issue from commit": the form opens at once, prefilled from
   * `entry`; the commit is linked only once `origin` has it (the link goes to
   * origin's page, so a commit only elsewhere would answer 404).
   */
  openFromCommit(entry: GitLogEntry): Promise<void>;
  /** The selection a diff view currently shows, if any (⌘⇧I uses it). */
  activeSelection: Ref<DiffSelection | null>;
  /**
   * "Create issue from these lines": the form opens prefilled with a
   * permalink (when GitHub has the lines), the lines and their origin.
   */
  openFromSelection(sel: DiffSelection): Promise<void>;
  /** ⌘⇧I / palette: from the active selection when there is one. */
  openFromShortcut(): Promise<void>;
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
}): CreateIssueApi {
  const commitOnOrigin = deps.commitOnOrigin ?? gitCommitOnOrigin;
  const isOpen = ref(false);
  const available = ref(false);
  const loading = ref(false);
  const targetsFailed = ref(false);
  const targetsError = ref<string | null>(null);
  const targets = ref<IssueTarget[]>([]);
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
  const outcomeUnknown = ref(false);
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
    () =>
      isOpen.value && !!repo.value && title.value.trim() !== "" && !submitting.value && !outcomeUnknown.value,
  );
  const originHtmlUrl = computed(() => targets.value.find((t) => t.isOrigin)?.htmlUrl || null);

  async function readTargets(cwd: string | null): Promise<IssueTargets | null> {
    const p = deps.provider.value;
    if (!p?.issueTargets || !cwd) return { targets: [], defaultRepo: null };
    try {
      return await p.issueTargets(cwd);
    } catch (e) {
      targetsError.value = message(e);
      return null;
    }
  }

  async function refreshAvailability(): Promise<void> {
    const seq = ++availabilitySeq;
    const p = deps.provider.value;
    const cwd = deps.cwd.value;
    let ok = false;
    try {
      ok = !!cwd && !!p?.issueAvailable && (await p.issueAvailable(cwd));
    } catch {
      ok = false;
    }
    if (seq === availabilitySeq) available.value = ok;
  }

  function forgetAvailability() {
    availabilitySeq++;
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
    outcomeUnknown.value = false;
    targetsFailed.value = false;
    targetsError.value = null;
    submitting.value = false;
    // The previous form's targets (maybe another repository's) must not
    // build this one's links if its own read fails.
    targets.value = [];
    initial.value = { title: "", body: "" };
    clearPickers();
  }

  async function open(
    prefill?: IssuePrefill | ((originHtmlUrl: string | null) => Promise<IssuePrefill>),
  ): Promise<void> {
    // Already open (⌘⇧I again, the palette): never wipe what is being typed,
    // nor drop the answer of a create in flight.
    if (isOpen.value) return;
    reset();
    const gen = generation;
    const openGen = openGeneration;
    formCwd = deps.cwd.value;
    isOpen.value = true;
    loading.value = true;
    const t = await readTargets(formCwd);
    if (gen !== generation) return;
    loading.value = false;
    targetsFailed.value = t === null;
    if (t !== null) {
      targets.value = t.targets;
      // The backend decides the default (the same rule for every caller).
      repo.value = t.defaultRepo;
      if (repo.value) loadPickers(repo.value);
    }
    // The form is on screen; the prefill (a commit's, after its git check)
    // lands when ready, unless the user has started typing meanwhile.
    let filled: IssuePrefill | undefined;
    try {
      filled = typeof prefill === "function" ? await prefill(originHtmlUrl.value) : prefill;
    } catch {
      filled = undefined;
    }
    if (openGen !== openGeneration || !filled) return;
    if (title.value !== initial.value.title || body.value !== initial.value.body) return;
    initial.value = { title: filled.title, body: filled.body };
    title.value = filled.title;
    body.value = filled.body;
  }

  async function openFromCommit(entry: GitLogEntry): Promise<void> {
    const cwd = deps.cwd.value;
    if (!cwd || !available.value) return;
    // A form opened but untouched gives way to this commit's.
    if (isOpen.value) {
      if (dirty.value || submitting.value) return;
      close();
    }
    // Started now, alongside the targets read; the link waits for both.
    const onOrigin = commitOnOrigin(cwd, entry.hashFull).catch(() => false);
    await open(async (origin) =>
      commitIssuePrefill(entry, (await onOrigin) && origin ? commitUrlFor(origin, entry.hashFull) : null),
    );
  }

  // Shallow: replaced whole, never mutated, and compared by identity.
  const activeSelection = shallowRef<DiffSelection | null>(null);

  async function openFromSelection(sel: DiffSelection): Promise<void> {
    const cwd = deps.cwd.value;
    if (!cwd || !available.value) return;
    if (isOpen.value) {
      if (dirty.value || submitting.value) return;
      close();
    }
    const span = permalinkSpan(sel.lines);
    const src = sel.source;
    if (src.kind === "pr") {
      // The PR's own repository (it may be a fork's parent); its base SHA is
      // unknown, so deleted lines get no permalink.
      const m = /^(https?:\/\/.+)\/pull\/\d+\/?$/.exec(src.url);
      const permalink =
        m && span && span.side === "new" && src.headSha ? blobPermalink(m[1], src.headSha, sel.path, span) : null;
      await open(selectionIssuePrefill(sel, { permalink, commitUrl: null }));
      return;
    }
    // Started now, alongside the targets read; the links wait for both.
    const onOrigin = commitOnOrigin(cwd, src.hashFull).catch(() => false);
    await open(async (origin) => {
      if (!(await onOrigin) || !origin) return selectionIssuePrefill(sel, { permalink: null, commitUrl: null });
      // Deleted lines live in the first parent, on origin too once the commit is.
      const sha = span?.side === "old" ? src.parent : src.hashFull;
      return selectionIssuePrefill(sel, {
        permalink: span && sha ? blobPermalink(origin, sha, sel.path, span) : null,
        commitUrl: commitUrlFor(origin, src.hashFull),
      });
    });
  }

  async function openFromShortcut(): Promise<void> {
    const sel = activeSelection.value;
    if (sel) await openFromSelection(sel);
    else if (available.value) await open();
  }

  function setRepo(next: string) {
    // The issue being created goes where it was sent; switching now would
    // drop its answer (and the notice that it was created).
    // Nor after a timeout: the warning, and its link to check GitHub, are
    // about the repository the issue may have reached.
    if (submitting.value || outcomeUnknown.value || next === repo.value) return;
    const target = targets.value.find((t) => t.repo === next);
    if (!target?.hasIssues) return;
    generation++;
    repo.value = next;
    // Labels, people and milestones belong to one repository.
    clearPickers();
    loadPickers(next);
  }

  function retryAnyway() {
    outcomeUnknown.value = false;
    error.value = null;
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
      // The backend marks a create that may have reached GitHub (a timeout
      // after sending): a plain retry could file the issue twice.
      outcomeUnknown.value = error.value.startsWith(MAY_HAVE_BEEN_CREATED);
      if (outcomeUnknown.value) error.value = error.value.slice(MAY_HAVE_BEEN_CREATED.length);
    } finally {
      if (gen === generation) submitting.value = false;
    }
  }

  return {
    isOpen,
    available,
    loading,
    targetsFailed,
    targetsError,
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
    outcomeUnknown,
    retryAnyway,
    dirty,
    canSubmit,
    originHtmlUrl,
    refreshAvailability,
    forgetAvailability,
    open,
    openFromCommit,
    activeSelection,
    openFromSelection,
    openFromShortcut,
    close,
    setRepo,
    submit,
  };
}
