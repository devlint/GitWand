/**
 * The "New issue" form (#301): where the issue goes, its fields, the label /
 * assignee / milestone pickers and the submit. One instance, created by
 * `App.vue` and provided under `CREATE_ISSUE_KEY`; every entry point (toolbar,
 * ⌘K, ⌘⇧I) calls `open(prefill?)`, a commit's menu `openFromCommit(entry)`.
 */

import { computed, onUnmounted, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { ForgeProvider } from "./forge/types";
import { gitExec, ghCreateGitwandIssue, ghGitwandWritable, type IssueTemplateFiles } from "../utils/backend";
import { loadTemplateSet, type IssueTemplateSet } from "../utils/issueTemplates";
import { DEFAULT_ENTROPY_THRESHOLD, type SecretFinding, type SecretPattern } from "@gitwand/core";
import { platformName } from "../utils/platform";
import { gitwandReportPrefill, repoReportPrefill, withAnswer, type ResolutionReport } from "../utils/resolutionReport";
import { scanReportBody, type ReportScan } from "../utils/reportGuard";
import { isEditableTarget } from "../utils/editableTarget";
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
  commitIssuePrefill,
  commitUrlFor,
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

/** A field typed in keeps the shortcut's keys, unless it asks for them with
 *  `data-issue-shortcut` (the PR comment box while it holds a range). */
function leavesShortcutToField(t: EventTarget | null): boolean {
  const el = t as { closest?: (s: string) => Element | null } | null;
  return isEditableTarget(t) && !el?.closest?.("[data-issue-shortcut]");
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
  if (e.getModifierState?.("AltGraph") || leavesShortcutToField(e.target)) return false;
  return e.ctrlKey && e.altKey && !e.metaKey;
}

export interface CreateIssueApi {
  isOpen: Ref<boolean>;
  /** The current repository's `origin` is on GitHub (a local check, no request). */
  available: Ref<boolean>;
  /** A resolution report can be sent: the repository takes issues, or
   *  GitWand's repository can be written to (shows the Report buttons). */
  reportAvailable: Ref<boolean>;
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
  open(prefill?: IssuePrefill | ((originHtmlUrl: string | null) => Promise<IssuePrefill>)): Promise<boolean>;
  /**
   * "Create issue from commit": the form opens at once, prefilled from
   * `entry`; the commit is linked only once `origin` has it (the link goes to
   * origin's page, so a commit only elsewhere would answer 404).
   */
  openFromCommit(entry: GitLogEntry): Promise<void>;
  /** The selection a diff view currently shows, if any (⌘⇧I uses it). */
  activeSelection: Ref<DiffSelection | null>;
  /** A view publishes (or, with `null`, withdraws) its selection; the most
   *  recent one still live becomes `activeSelection`. */
  publishSelection(id: symbol, sel: DiffSelection | null, key?: unknown): void;
  /**
   * "Create issue from these lines": the form opens prefilled with a
   * permalink (when GitHub has the lines), the lines and their origin.
   */
  openFromSelection(sel: DiffSelection): Promise<boolean>;
  /** ⌘⇧I / palette: from the active selection when there is one. */
  openFromShortcut(): Promise<void>;
  close(): void;
  setRepo(repo: string): void;
  submit(): Promise<void>;

  // ─── Report mode ("Report bad resolution", #301 part 3) ───────────────
  /** The resolution being reported, `null` for any other issue. */
  report: Ref<ResolutionReport | null>;
  /** "What should it have been?": its own field, kept across switches. */
  answer: Ref<string>;
  /** The report goes to GitWand's repository instead of the current one. */
  toGitwand: Ref<boolean>;
  /** The current repository cannot take the issue: GitWand only. */
  gitwandLocked: Ref<boolean>;
  /** A report can be written to GitWand (`null` while checking). */
  gitwandWritable: Ref<boolean | null>;
  /** "I reviewed the code, it can be public" (GitWand only). */
  confirmedPublic: Ref<boolean>;
  /** The secrets scan of what would be sent. */
  findings: Ref<ReportScan>;
  /** Title or description differ from those generated for the current target. */
  bodyEdited: ComputedRef<boolean>;
  /** The text is over GitHub's body limit: Create is held. */
  tooLong: ComputedRef<boolean>;
  /** What is sent: the answer on top of the description. */
  finalBody: ComputedRef<string>;
  openFromResolution(r: ResolutionReport): Promise<void>;
  /** Changes every time the form is opened or closed: a question asked about
   *  one form must not be applied to the next. */
  openId: Readonly<Ref<number>>;
  /** Retarget the report; regenerates title and description (the caller
   *  confirms first when `bodyEdited`). */
  setGitwand(on: boolean): void;
  /** The form was opened blank (no commit, lines or report): it offers templates. */
  blankForm: Ref<boolean>;
  /** The target's issue templates, null until read (or when the read failed). */
  templateSet: Ref<IssueTemplateSet | null>;
  templatesLoading: Ref<boolean>;
  /** The template applied, null for "Blank issue". */
  templateId: Ref<string | null>;
  /** The repository the templates come from (the owner's `.github` one, maybe). */
  templateSource: Ref<string | null>;
  /** The text was filled by a template of the target left. */
  templateLeftover: Ref<boolean>;
  /** The applied template's labels and people that will not be set (no triage rights, or not offered by the target). */
  templatePicksUnset: ComputedRef<string[]>;
  /** The owner's `.github` repository, when the templates come from it. */
  templateFromOwner: ComputedRef<string | null>;
  /** A template chosen in the picker, `confirm` asked first when it would replace edits. */
  chooseTemplate(wanted: string | null, confirm: (kind: "replace" | "clear") => Promise<boolean>): Promise<void>;
}

/** How long a target's templates are kept (each read is up to 20 requests). */
const TEMPLATE_CACHE_MS = 5 * 60_000;
const templateCache = new Map<string, { at: number; set: IssueTemplateSet; source: string }>();
/** Template reads under way, per target, shared by every form that asks. */
const templateInflight = new Map<string, Promise<{ set: IssueTemplateSet; complete: boolean; source: string }>>();
/** Keep a target's templates, at most `TEMPLATE_CACHE_MAX` targets (the oldest goes). */
const TEMPLATE_CACHE_MAX = 50;
function rememberTemplates(key: string, entry: { at: number; set: IssueTemplateSet; source: string }) {
  templateCache.delete(key);
  templateCache.set(key, entry);
  for (const [k, e] of templateCache) {
    if (templateCache.size <= TEMPLATE_CACHE_MAX && Date.now() - e.at < TEMPLATE_CACHE_MS) break;
    templateCache.delete(k);
  }
}

/** Forget the cached templates (tests). */
export function clearTemplateCache(): void {
  templateCache.clear();
  templateInflight.clear();
}

/** GitWand's own repository, where resolver reports go (mirrors Rust `GITWAND_REPO`). */
export const GITWAND_REPO = "devlint/GitWand";

/** GitHub's limit on an issue body. */
export const ISSUE_BODY_MAX = 65_536;

/** What report mode needs from outside (tests replace it). */
export interface ReportDeps {
  createGitwandIssue?: (input: { title: string; body: string }) => Promise<CreatedIssue>;
  gitwandWritable?: () => Promise<boolean>;
  env?: () => { version: string; platform: string };
  /** The repository's extra secret patterns and entropy threshold. */
  secretsOptions?: (cwd: string | null) => Promise<{ extraPatterns: SecretPattern[]; entropyThreshold: number; ignore?: string[] }>;
  scanDebounceMs?: number;
}

function defaultEnv(): { version: string; platform: string } {
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
  return { version, platform: platformName() };
}

/** The scan's options until the repository's arrive (and without the app's
 *  scanner config, in tests): the built-in patterns, entropy at 4.0. */
const DEFAULT_SECRETS_OPTIONS: Readonly<{ extraPatterns: SecretPattern[]; entropyThreshold: number; ignore?: string[] }> = {
  extraPatterns: [],
  entropyThreshold: DEFAULT_ENTROPY_THRESHOLD,
};

async function defaultSecretsOptions(_cwd: string | null) {
  return DEFAULT_SECRETS_OPTIONS;
}

export const CREATE_ISSUE_KEY: InjectionKey<CreateIssueApi> = Symbol("createIssue");

/**
 * The selections diff views publish, of which `target` shows the most
 * recently changed one still live: when it goes away (cleared, view gone) the
 * next most recent takes over. Returns the publish function (`null` removes
 * the caller's).
 */
export function createSelectionRegistry(target: Ref<DiffSelection | null>) {
  let seq = 0;
  const live = new Map<symbol, { sel: DiffSelection; at: number; key: unknown }>();
  /** `key` names the pick behind `sel`: a selection rebuilt for the same
   *  pick (a refresh) keeps its rank; without a key every update ranks. */
  return (id: symbol, sel: DiffSelection | null, key?: unknown): void => {
    const prev = live.get(id);
    if (sel) {
      const same = key !== undefined && prev !== undefined && prev.key === key;
      live.set(id, { sel, at: same ? prev.at : ++seq, key });
    } else live.delete(id);
    let best: { sel: DiffSelection; at: number } | null = null;
    for (const entry of live.values()) if (!best || entry.at > best.at) best = entry;
    target.value = best?.sel ?? null;
  };
}

/**
 * Publish a diff view's selection (what ⌘⇧I files) while issues can be
 * created; withdrawn when it goes away, availability drops or the view
 * unmounts. Call from a component's setup.
 */
export function useSelectionPublisher(
  api: CreateIssueApi | null,
  source: () => DiffSelection | null,
  /** The pick behind the selection (its range): rebuilt for the same pick,
   *  the selection keeps its rank among the views'. */
  pick?: () => unknown,
): void {
  if (!api) return;
  const id = Symbol("selection");
  // Published again only when the selection or its pick changed, not on
  // every recompute of whatever the source reads.
  let last: { sel: DiffSelection | null; key: unknown } = { sel: null, key: undefined };
  watch(
    () => [api.available.value ? source() : null, pick?.()] as const,
    ([sel, key]) => {
      if (sel === last.sel && key === last.key) return;
      last = { sel, key };
      api.publishSelection(id, sel, key);
    },
  );
  onUnmounted(() => api.publishSelection(id, null));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useCreateIssue(deps: {
  cwd: Readonly<Ref<string | null>>;
  provider: Readonly<Ref<ForgeProvider | null>>;
  /**
   * `toGitwand`: a public resolver report (never added to the user's commit).
   * `repo`: where the issue was filed, for an issue whose URL says nothing.
   * `cwd`: the folder the form was opened for (the active tab may have changed).
   */
  onCreated: (issue: CreatedIssue, ctx: { toGitwand: boolean; repo: string; cwd: string }) => void;
  /** Whether `origin` has the commit (tests replace the git check). */
  commitOnOrigin?: (cwd: string, sha: string) => Promise<boolean>;
  report?: ReportDeps;
  /** A target's raw template files (tests replace the GitHub read). */
  issueTemplates?: (
    cwd: string,
    repo: string,
  ) => Promise<Omit<IssueTemplateFiles, "files"> & { files: { path: string; content: string; single?: boolean }[] }>;
}): CreateIssueApi {
  /** The forge's template read (none on a forge without templates: no request). */
  const readTemplates = deps.issueTemplates ?? ((cwd: string, r: string) => deps.provider.value?.issueTemplates?.(cwd, r) ?? null);
  const rdeps = deps.report ?? {};
  const createGitwandIssue = rdeps.createGitwandIssue ?? ghCreateGitwandIssue;
  const checkGitwandWritable = rdeps.gitwandWritable ?? ghGitwandWritable;
  const reportEnv = rdeps.env ?? defaultEnv;
  const secretsOptions = rdeps.secretsOptions ?? defaultSecretsOptions;
  const scanDebounceMs = rdeps.scanDebounceMs ?? 300;
  const commitOnOrigin = deps.commitOnOrigin ?? gitCommitOnOrigin;
  const isOpen = ref(false);
  const available = ref(false);
  const reportAvailable = ref(false);
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
  /** Whether the target's label and people lists have answered (or failed). */
  const listsAnswered = ref({ labels: false, assignees: false });
  const blankForm = ref(false);
  const templateSet = ref<IssueTemplateSet | null>(null);
  const templatesLoading = ref(false);
  const templateId = ref<string | null>(null);
  /** The repository the templates were read from (the owner's `.github` one, maybe). */
  const templateSource = ref<string | null>(null);
  /** The text comes from a template of the target left: no template is chosen, yet it is not blank. */
  const templateLeftover = ref(false);
  /** The template the leftover text came from, to restore on the way back to its repository. */
  type LeftoverFrom = { repo: string; id: string; title: string; body: string; picks: { labels: string[]; assignees: string[] } };
  let leftoverFrom: LeftoverFrom | null = null;
  /** The applied template's own labels and people (all it names). */
  let appliedPicks = { labels: [] as string[], assignees: [] as string[] };
  /** The applied template was a single-template file put there by itself (not chosen). */
  let templatePrefilled = false;
  /** A choice to restore once the target's templates are known to hold it. */
  let restoreOnLoad: LeftoverFrom | null = null;
  const assigneeOptions = ref<ReviewerCandidate[]>([]);
  const milestoneOptions = ref<RepoMilestone[]>([]);
  const submitting = ref(false);
  const error = ref<string | null>(null);
  const outcomeUnknown = ref(false);
  const initial = ref<IssuePrefill>({ title: "", body: "" });
  const report = shallowRef<ResolutionReport | null>(null);
  const openId = ref(0);
  const answer = ref("");
  const toGitwand = ref(false);
  const gitwandLocked = ref(false);
  const gitwandWritable = ref<boolean | null>(null);
  const confirmedPublic = ref(false);
  const findings = ref<ReportScan>({ blocking: [], warnings: [] });
  // A change not scanned yet: a secret typed a moment ago must not slip out.
  const scanPending = ref(false);
  let secretsOpts: { extraPatterns: SecretPattern[]; entropyThreshold: number; ignore?: string[] } = DEFAULT_SECRETS_OPTIONS;
  // Bumped when the patterns change (they arrive, or the form is reset): part
  // of every scan's cache key.
  let secretsVersion = 0;
  // The last scan of each field, reused while its text and options are unchanged.
  const scanCache = new Map<string, { key: string; result: ReportScan }>();
  // A public report waits for the repository's own patterns.
  const secretsLoaded = ref(false);
  // The repository the report would go to without the switch.
  let repoTarget: string | null = null;
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
  // Whether `reportAvailable` has been answered for the current repository.
  let availabilityChecked = false;

  const finalBody = computed(() => (report.value ? withAnswer(answer.value, body.value, toGitwand.value) : body.value));
  // Title or description no longer what was generated for the current target.
  // GitHub refuses a body over 65,536 characters (422) — after the user has
  // already confirmed a public report: hold Create instead.
  const tooLong = computed(() => finalBody.value.length > ISSUE_BODY_MAX);
  const bodyEdited = computed(() => body.value !== initial.value.body || title.value !== initial.value.title);
  const dirty = computed(
    () =>
      answer.value.trim() !== "" ||
      title.value !== initial.value.title ||
      body.value !== initial.value.body ||
      // A template's own labels and people are not the user's work; those
      // picked by hand, or the template's removed by hand, are.
      picksEditedByHand() ||
      milestone.value !== null,
  );
  const canSubmit = computed(
    () =>
      isOpen.value &&
      !!repo.value &&
      title.value.trim() !== "" &&
      !submitting.value &&
      !outcomeUnknown.value &&
      !tooLong.value &&
      (!toGitwand.value ||
        (confirmedPublic.value &&
          gitwandWritable.value === true &&
          secretsLoaded.value &&
          !scanPending.value &&
          findings.value.blocking.length === 0)),
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
    if (seq !== availabilitySeq) return;
    available.value = ok;
    let writable = false;
    if (!ok) {
      try {
        writable = await checkGitwandWritable();
      } catch {
        writable = false;
      }
    }
    if (seq === availabilitySeq) {
      reportAvailable.value = ok || writable;
      availabilityChecked = true;
    }
  }

  function forgetAvailability() {
    availabilitySeq++;
    availabilityChecked = false;
    available.value = false;
    reportAvailable.value = false;
  }

  function clearPickers() {
    labels.value = [];
    assignees.value = [];
    milestone.value = null;
    labelOptions.value = [];
    assigneeOptions.value = [];
    milestoneOptions.value = [];
    listsAnswered.value = { labels: false, assignees: false };
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
    const answered = (key: "labels" | "assignees") => () => {
      if (current()) listsAnswered.value = { ...listsAnswered.value, [key]: true };
    };
    (p.listLabels?.(cwd, target).then((v) => { if (current()) labelOptions.value = v; }, () => {}) ?? Promise.resolve()).finally(answered("labels"));
    p.listMilestones?.(cwd, target).then((v) => { if (current()) milestoneOptions.value = v; }, () => {});
    (p.listAssignees?.(cwd, target).then((v) => { if (current()) assigneeOptions.value = v; }, () => {}) ?? Promise.resolve()).finally(answered("assignees"));
  }

  /**
   * The target's templates, for a blank form; kept a few minutes per target
   * (each read is up to 20 requests). A late answer for another target is
   * dropped.
   */
  function loadTemplates(target: string) {
    const cwd = formCwd;
    if (!blankForm.value || !cwd) return;
    // Per repository and host (its page URL): another worktree of it reads
    // none; the same owner/repo on another host is another repository.
    const key = (targets.value.find((x) => x.repo === target)?.htmlUrl ?? target).toLowerCase();
    const cached = templateCache.get(key);
    if (cached && Date.now() - cached.at >= TEMPLATE_CACHE_MS) templateCache.delete(key);
    else if (cached) {
      templateSet.value = cached.set;
      templateSource.value = cached.source;
      onTemplateSet();
      templatesLoading.value = false; // another target's read may still be in flight
      return;
    }
    const gen = generation;
    const current = () => gen === generation && repo.value === target;
    // A read already in flight for this target (A → B → A) is reused.
    let read = templateInflight.get(key);
    if (!read) {
      const started = readTemplates(cwd, target);
      if (!started) return; // this forge has no templates
      const parsed = started.then(async (r) => ({ set: await loadTemplateSet(r.files), complete: r.complete, source: r.source }));
      templateInflight.set(key, parsed);
      parsed.then(
        () => templateInflight.delete(key),
        () => templateInflight.delete(key),
      );
      read = parsed;
    }
    templateSet.value = null;
    templateSource.value = null;
    templatesLoading.value = true;
    read
      .then(
        ({ set, complete, source }) => {
          // A set missing a file that failed is shown, not kept: the next
          // form tries again.
          if (complete) rememberTemplates(key, { at: Date.now(), set, source });
          if (current()) {
            templateSet.value = set;
            templateSource.value = source;
            onTemplateSet();
          }
        },
        () => {}, // No templates is a blank form, never an error.
      )
      .finally(() => { if (current()) templatesLoading.value = false; });
  }

  /**
   * The applied template's labels and people: `pending` waits for the target
   * to offer them (its pickers load meanwhile), each granted once (one the
   * user then removes stays removed); `added` is what the template put there
   * itself, all it takes back (one picked by hand before stays).
   */
  type Picks = { labels: string[]; assignees: string[] };
  const noPicks = (): Picks => ({ labels: [], assignees: [] });
  const templatePending = ref<Picks>(noPicks());
  const templateAdded = ref<Picks>(noPicks());

  /**
   * The applied template's labels and people that will not be set, said
   * rather than dropped silently: all it still waits for without triage
   * rights (the lists never load), else those its target's lists, once
   * answered (or failed), do not offer.
   */
  const templatePicksUnset = computed(() => {
    if (templateId.value === null) return [];
    const pending = templatePending.value;
    const canTriage = targets.value.find((x) => x.repo === repo.value)?.canTriage ?? false;
    const named = canTriage
      ? [...(listsAnswered.value.labels ? pending.labels : []), ...(listsAnswered.value.assignees ? pending.assignees : [])]
      : [...pending.labels, ...pending.assignees];
    // Once each, whatever the case the template wrote it in.
    const seen = new Set<string>();
    return named.filter((x) => !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase()));
  });

  function forgetTemplatePicks() {
    templatePending.value = noPicks();
    templateAdded.value = noPicks();
  }

  /** Picks the user made by hand, or a template's they removed by hand. */
  function picksEditedByHand(): boolean {
    const added = templateAdded.value;
    const byHand = labels.value.some((l) => !added.labels.includes(l)) || assignees.value.some((a) => !added.assignees.includes(a));
    return byHand || templatePicksRemoved();
  }

  /** A label or person the template added that the user removed. */
  function templatePicksRemoved(): boolean {
    const added = templateAdded.value;
    return added.labels.some((l) => !labels.value.includes(l)) || added.assignees.some((a) => !assignees.value.includes(a));
  }

  /** Grant what the template wants and the target now offers, each once. */
  function grantTemplateWants() {
    // Without case (GitHub's label names and logins), in the target's spelling.
    const grant = (have: Ref<string[]>, key: "labels" | "assignees", offeredNames: string[]) => {
      const offered = new Map(offeredNames.map((x) => [x.toLowerCase(), x]));
      const pending = templatePending.value[key];
      const now = [...new Set(pending.filter((x) => offered.has(x.toLowerCase())).map((x) => offered.get(x.toLowerCase())!))];
      if (!now.length) return;
      templatePending.value = { ...templatePending.value, [key]: pending.filter((x) => !offered.has(x.toLowerCase())) };
      const fresh = now.filter((x) => !have.value.includes(x));
      templateAdded.value = { ...templateAdded.value, [key]: [...templateAdded.value[key], ...fresh] };
      have.value = [...have.value, ...fresh];
    };
    grant(labels, "labels", labelOptions.value.map((l) => l.name));
    grant(assignees, "assignees", assigneeOptions.value.map((a) => a.login));
  }
  watch([labelOptions, assigneeOptions], () => {
    if (templatePending.value.labels.length || templatePending.value.assignees.length) grantTemplateWants();
  });

  /**
   * GitHub prefills a new issue with a repository's single-template file
   * (`ISSUE_TEMPLATE.md`): so does a blank form still untouched.
   */
  function prefillSingleTemplate() {
    const only = templateSet.value?.templates;
    if (!only || only.length !== 1 || !only[0].single) return;
    if (templateId.value !== null || templateLeftover.value || dirty.value) return;
    applyTemplate(only[0].id);
    templatePrefilled = true;
  }

  /** A template set arrived for the target: restore a pending choice, or prefill. */
  function onTemplateSet() {
    const back = restoreOnLoad;
    restoreOnLoad = null;
    const same = back && templateSet.value?.templates.find((x) => x.id === back.id);
    // The template must still read as it did (it may have changed upstream),
    // and its text be untouched since.
    if (back && same && same.title === back.title && same.body === back.body && title.value === back.title && body.value === back.body) {
      // Back where the template came from, its text untouched: chosen again.
      templateId.value = back.id;
      initial.value = { title: back.title, body: back.body };
      templateLeftover.value = false;
      leftoverFrom = null;
      appliedPicks = back.picks;
      templatePending.value = { labels: [...back.picks.labels], assignees: [...back.picks.assignees] };
      grantTemplateWants();
      return;
    }
    prefillSingleTemplate();
  }

  /** The owner's `.github` repository, when the templates come from it. */
  const templateFromOwner = computed(() => {
    const source = templateSource.value;
    return source && source.toLowerCase() !== (repo.value ?? "").toLowerCase() ? source : null;
  });

  /**
   * A template chosen in the picker: nothing for the same choice (except
   * "Blank issue" over a leftover text, which clears it); `confirm` first
   * when what it would replace was edited. An answer that comes after the
   * form, or its target, changed applies nothing (another target may have a
   * template at the same path).
   */
  async function chooseTemplate(wanted: string | null, confirm: (kind: "replace" | "clear") => Promise<boolean>): Promise<void> {
    if (wanted === templateId.value && !(wanted === null && templateLeftover.value)) return;
    // Another template replaces the title and description only (a label of
    // the template removed by hand would not come back either way).
    if (bodyEdited.value) {
      const asked = openGeneration;
      const target = repo.value;
      const ok = await confirm(wanted === null ? "clear" : "replace");
      if (!ok || !isOpen.value || openGeneration !== asked || repo.value !== target) return;
    }
    applyTemplate(wanted);
  }

  /** Fill the form from a template (null: blank), unasked: `chooseTemplate` asks first. */
  function applyTemplate(id: string | null) {
    const chosen = id === null ? null : templateSet.value?.templates.find((x) => x.id === id) ?? null;
    if (id !== null && !chosen) return;
    templateId.value = chosen ? chosen.id : null;
    title.value = chosen?.title ?? "";
    body.value = chosen?.body ?? "";
    // What the previous template added goes; what was picked by hand stays.
    const added = templateAdded.value;
    labels.value = labels.value.filter((l) => !added.labels.includes(l));
    assignees.value = assignees.value.filter((a) => !added.assignees.includes(a));
    forgetTemplatePicks();
    templateLeftover.value = false;
    leftoverFrom = null;
    templatePrefilled = false;
    restoreOnLoad = null;
    appliedPicks = { labels: [...(chosen?.labels ?? [])], assignees: [...(chosen?.assignees ?? [])] };
    templatePending.value = { labels: [...appliedPicks.labels], assignees: [...appliedPicks.assignees] };
    // Only what the target offers (GitHub refuses unknown labels and people),
    // now or once its pickers arrive.
    grantTemplateWants();
    // The template's text is the new starting point: editing it is what asks.
    initial.value = { title: title.value, body: body.value };
  }

  function reset() {
    generation++;
    openGeneration++;
    openId.value = openGeneration;
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
    report.value = null;
    answer.value = "";
    toGitwand.value = false;
    gitwandLocked.value = false;
    gitwandWritable.value = null;
    confirmedPublic.value = false;
    findings.value = { blocking: [], warnings: [] };
    scanPending.value = false;
    repoTarget = null;
    blankForm.value = false;
    templateSet.value = null;
    templatesLoading.value = false;
    templateId.value = null;
    forgetTemplatePicks();
    templateSource.value = null;
    templateLeftover.value = false;
    leftoverFrom = null;
    appliedPicks = { labels: [], assignees: [] };
    templatePrefilled = false;
    restoreOnLoad = null;
    // The previous repository's extra patterns must not stand in for this
    // one's while its `.gitwandrc` is read.
    secretsOpts = DEFAULT_SECRETS_OPTIONS;
    secretsVersion++;
    scanCache.clear();
    secretsLoaded.value = false;
  }

  async function open(
    prefill?: IssuePrefill | ((originHtmlUrl: string | null) => Promise<IssuePrefill>),
    opts: { templates?: boolean } = {},
  ): Promise<boolean> {
    // Already open (⌘⇧I again, the palette): never wipe what is being typed,
    // nor drop the answer of a create in flight.
    if (isOpen.value) return false;
    reset();
    // Templates are for a blank form; a commit's, lines' or report's keeps its own.
    blankForm.value = prefill === undefined && opts.templates !== false;
    const gen = generation;
    const openGen = openGeneration;
    formCwd = deps.cwd.value;
    isOpen.value = true;
    loading.value = true;
    const t = await readTargets(formCwd);
    if (gen !== generation) return false;
    loading.value = false;
    targetsFailed.value = t === null;
    if (t !== null) {
      targets.value = t.targets;
      // The backend decides the default (the same rule for every caller).
      repo.value = t.defaultRepo;
      if (repo.value) {
        loadPickers(repo.value);
        loadTemplates(repo.value);
      }
    }
    // The form is on screen; the prefill (a commit's, after its git check)
    // lands when ready, unless the user has started typing meanwhile.
    let filled: IssuePrefill | undefined;
    try {
      filled = typeof prefill === "function" ? await prefill(originHtmlUrl.value) : prefill;
    } catch {
      filled = undefined;
    }
    if (openGen !== openGeneration) return false;
    if (!filled) return !prefill;
    if (title.value !== initial.value.title || body.value !== initial.value.body) return false;
    initial.value = { title: filled.title, body: filled.body };
    title.value = filled.title;
    body.value = filled.body;
    return true;
  }

  /**
   * Open the form with a prefill that links `sha` only once `origin` has it
   * (the links go to origin's page; a commit only elsewhere would answer
   * 404). The check starts now, alongside the targets read.
   */
  function openLinkedTo(cwd: string, sha: string, build: (origin: string | null) => IssuePrefill): Promise<boolean> {
    const onOrigin = commitOnOrigin(cwd, sha).catch(() => false);
    return open(async (origin) => build((await onOrigin) ? origin : null));
  }

  /** A form opened but untouched gives way; one being typed in stays. */
  function makeRoom(): boolean {
    if (!isOpen.value) return true;
    if (dirty.value || submitting.value) return false;
    close();
    return true;
  }

  async function openFromCommit(entry: GitLogEntry): Promise<void> {
    const cwd = deps.cwd.value;
    if (!cwd || !available.value || !makeRoom()) return;
    await openLinkedTo(cwd, entry.hashFull, (origin) =>
      commitIssuePrefill(entry, origin ? commitUrlFor(origin, entry.hashFull) : null),
    );
  }

  const activeSelection = shallowRef<DiffSelection | null>(null);
  const publishSelection = createSelectionRegistry(activeSelection);

  /** Resolves `true` when the form holds `sel`'s lines (then `sel.onOpened`
   *  has run, unless its targets could not be read), `false` otherwise: no
   *  GitHub, a form being typed in, typed first, another form meanwhile. */
  async function openFromSelection(sel: DiffSelection): Promise<boolean> {
    const cwd = deps.cwd.value;
    if (!cwd || !available.value || !makeRoom()) return false;
    const src = sel.source;
    let opened: Promise<boolean>;
    if (src.kind === "pr") {
      // The PR's own repository (it may be a fork's parent); its base SHA is
      // unknown, so the old version of its lines gets no permalink.
      const repo = /^(https?:\/\/.+?)\/pull\/\d+(?:[/?#].*)?$/.exec(src.url)?.[1] ?? null;
      opened = open(selectionIssuePrefill(sel, { repoHtmlUrl: repo, newSha: src.headSha, oldSha: null, commitUrl: null }));
    } else {
      // The old version is the first parent, on origin too once the commit is.
      opened = openLinkedTo(cwd, src.hashFull, (origin) =>
        selectionIssuePrefill(sel, {
          repoHtmlUrl: origin,
          newSha: origin ? src.hashFull : null,
          oldSha: origin ? src.parent : null,
          commitUrl: origin ? commitUrlFor(origin, src.hashFull) : null,
        }),
      );
    }
    // Handed over only once its lines are in this very form and the form
    // could read its targets: a prefill dropped (typed first, form closed
    // and another opened) or a failed read (signed out…) must not cost it.
    const landed = await opened;
    if (landed && !targetsFailed.value) sel.onOpened?.();
    return landed;
  }

  /** A field's scan depends on its text, the blocking rule and the patterns. */
  function scanCacheKey(blockAt: string, text: string): string {
    return `${blockAt}\u0000${secretsVersion}\u0000${text}`;
  }

  /** Each field's text is the one last scanned, with the current options. */
  function allScanned(): boolean {
    const blockAt = toGitwand.value ? "medium" : "never";
    const parts: Array<[string, string]> = [["title", title.value], ["answer", answer.value], ["description", body.value]];
    return parts.every(([where, text]) => scanCache.get(where)?.key === scanCacheKey(blockAt, text));
  }

  function scanNow() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    scanPending.value = false;
    if (!report.value) return;
    const opts = { ...secretsOpts, blockAt: toGitwand.value ? ("medium" as const) : ("never" as const) };
    // Each part on its own, so a finding names the field the user can edit
    // and a line number that is that field's own.
    const parts: Array<[SecretFinding["file"], string]> = [
      ["title", title.value],
      ["answer", answer.value],
      ["description", body.value],
    ];
    const next: ReportScan = { blocking: [], warnings: [] };
    for (const [where, text] of parts) {
      // A field unchanged since its last scan (same text, same options) is
      // not scanned again: typing in the answer leaves a 50 KB body alone.
      const key = scanCacheKey(opts.blockAt, text);
      let r = scanCache.get(where)?.key === key ? scanCache.get(where)!.result : null;
      if (!r) {
        r = scanReportBody(text, opts);
        scanCache.set(where, { key, result: r });
      }
      next.blocking.push(...r.blocking.map((f) => ({ ...f, file: where })));
      next.warnings.push(...r.warnings.map((f) => ({ ...f, file: where })));
    }
    findings.value = next;
  }

  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  watch([finalBody, title], () => {
    // Nothing new to scan (a switch or an open just scanned this very text).
    if (!report.value || allScanned()) return;
    scanPending.value = true;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanNow, scanDebounceMs);
  });
  onUnmounted(() => {
    if (scanTimer) clearTimeout(scanTimer);
  });

  /** Title and description for the current target (the answer stays apart). */
  function regenerate() {
    const r = report.value;
    if (!r) return;
    const p = toGitwand.value ? gitwandReportPrefill(r, reportEnv()) : repoReportPrefill(r);
    initial.value = p;
    title.value = p.title;
    body.value = p.body;
  }

  function setGitwand(on: boolean) {
    if (!report.value || submitting.value || outcomeUnknown.value) return;
    if (!on && gitwandLocked.value) return;
    // Leaving the repository: remember the one the user had picked.
    if (on && !toGitwand.value) repoTarget = repo.value;
    generation++;
    // The previous target's failure is not this one's.
    error.value = null;
    toGitwand.value = on;
    // Re-confirm every time the report heads for the public repository.
    confirmedPublic.value = false;
    clearPickers();
    repo.value = on ? GITWAND_REPO : repoTarget;
    if (!on && repo.value) loadPickers(repo.value);
    regenerate();
    scanNow();
  }

  async function openFromResolution(r: ResolutionReport): Promise<void> {
    // Not checked yet for this repository (a click before the first check):
    // check now. Then, nowhere to send it (not a GitHub repository, no
    // github.com sign-in): nothing to open.
    if (!availabilityChecked) await refreshAvailability();
    if (!reportAvailable.value || !makeRoom()) return;
    // False when the form was closed (or reopened) while its targets loaded:
    // the report must not attach to whatever form is on screen now.
    // A report is not a blank form: no templates (one would replace it).
    if (!(await open(undefined, { templates: false }))) return;
    const openGen = openGeneration;
    report.value = r;
    // The repository's targets could not be read: a report can still go to
    // GitWand (github.com only), so the form opens locked there, the read's
    // error kept as the reason.
    targetsFailed.value = false;
    repoTarget = repo.value;
    gitwandLocked.value = !repoTarget;
    toGitwand.value = gitwandLocked.value;
    if (toGitwand.value) {
      clearPickers();
      repo.value = GITWAND_REPO;
    }
    regenerate();
    scanNow();
    const cwd = formCwd;
    checkGitwandWritable().then(
      (ok) => { if (openGen === openGeneration) gitwandWritable.value = ok; },
      () => { if (openGen === openGeneration) gitwandWritable.value = false; },
    );
    secretsOptions(cwd).then(
      (o) => {
        if (openGen !== openGeneration) return;
        secretsOpts = o;
        secretsVersion++;
        secretsLoaded.value = true;
        scanNow();
      },
      () => {
        // Unreadable: the built-in patterns still apply.
        if (openGen === openGeneration) secretsLoaded.value = true;
      },
    );
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
    const from = repo.value;
    repo.value = next;
    // Labels, people and milestones belong to one repository.
    clearPickers();
    loadPickers(next);
    // The text a template filled stays, now the user's (so "Blank issue" asks
    // before clearing it); the choice, and the labels and people it wanted,
    // were about the other target.
    if (templateId.value !== null && templatePrefilled && !bodyEdited.value) {
      // Put there by itself and untouched: it gives way, and the new target
      // may prefill its own.
      title.value = "";
      body.value = "";
      initial.value = { title: "", body: "" };
      templatePrefilled = false;
    } else if (templateId.value !== null && from) {
      // Remembered, to restore on the way back if the text is untouched.
      leftoverFrom = { repo: from, id: templateId.value, title: initial.value.title, body: initial.value.body, picks: appliedPicks };
      initial.value = { title: "", body: "" };
      // The select then says so ("from the other repository"), and "Blank
      // issue" can clear it.
      templateLeftover.value = true;
    }
    templateId.value = null;
    // Its labels and people were the other target's (clearPickers dropped them).
    forgetTemplatePicks();
    // Back where the template came from: restored once that target's set is
    // known to still hold it (it is read again, or taken from the cache).
    restoreOnLoad = leftoverFrom && leftoverFrom.repo === next ? leftoverFrom : null;
    loadTemplates(next);
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
    // A GitWand report needs neither the repository's forge nor its folder.
    if (!canSubmit.value || !repo.value) return;
    if (!toGitwand.value && (!p?.createIssue || !cwd)) return;
    // Set before the first await: a second call in the same tick sees it.
    submitting.value = true;
    error.value = null;
    const gen = generation;
    const sentToGitwand = toGitwand.value;
    const sentTo = repo.value;
    try {
      const created = sentToGitwand
        ? await createGitwandIssue({ title: title.value, body: finalBody.value })
        : await p!.createIssue!(cwd!, {
            repo: repo.value,
            title: title.value,
            body: finalBody.value,
            labels: [...labels.value],
            assignees: [...assignees.value],
            milestone: milestone.value,
          });
      if (gen !== generation) return;
      deps.onCreated(created, { toGitwand: sentToGitwand, repo: sentTo, cwd: cwd ?? "" });
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
    reportAvailable,
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
    publishSelection,
    openFromSelection,
    openFromShortcut,
    close,
    setRepo,
    submit,
    report,
    answer,
    toGitwand,
    gitwandLocked,
    gitwandWritable,
    confirmedPublic,
    findings,
    bodyEdited,
    tooLong,
    finalBody,
    openFromResolution,
    openId,
    setGitwand,
    blankForm,
    templateSet,
    templatesLoading,
    templateId,
    templateSource,
    templateLeftover,
    templatePicksUnset,
    templateFromOwner,
    chooseTemplate,
  };
}
