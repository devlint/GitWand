/**
 * The "New issue" form (#301): where the issue goes, its fields, the label /
 * assignee / milestone pickers and the submit. One instance, created by
 * `App.vue` and provided under `CREATE_ISSUE_KEY`; every entry point (toolbar,
 * ⌘K, ⌘⇧I, a commit's menu) only calls `open(prefill?)`.
 */

import { computed, ref, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { ForgeProvider } from "./forge/types";
import type {
  CreatedIssue,
  IssueTarget,
  RepoLabel,
  RepoMilestone,
  ReviewerCandidate,
} from "../utils/backend";
import type { IssuePrefill } from "../utils/issuePrefill";

export interface CreateIssueApi {
  isOpen: Ref<boolean>;
  /** The current repository has somewhere to file an issue (GitHub `origin`). */
  available: Ref<boolean>;
  /** Targets are being read when the form opens. */
  loading: Ref<boolean>;
  /** Reading the targets failed: nothing can be filed until the form reopens. */
  targetsFailed: Ref<boolean>;
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
  /** Title or body differ from what the form was opened with. */
  dirty: ComputedRef<boolean>;
  canSubmit: ComputedRef<boolean>;
  /** `origin`'s page, for commit links (GitHub Enterprise included). */
  originHtmlUrl: ComputedRef<string | null>;
  refreshAvailability(): Promise<void>;
  /** Drop the targets of the repository being left, before the next one is read. */
  forgetTargets(): void;
  /**
   * Open the form. A prefill given as a promise (a commit's, which needs a
   * git check first) lands when ready: the form shows at once.
   */
  open(prefill?: IssuePrefill | Promise<IssuePrefill>): Promise<void>;
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
}): CreateIssueApi {
  const isOpen = ref(false);
  const available = ref(false);
  const loading = ref(false);
  const targetsFailed = ref(false);
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
  const initial = ref<IssuePrefill>({ title: "", body: "" });
  // The repository the open form files on: an app tab switch while it is open
  // must not send the issue (or its picker reads) somewhere else.
  let formCwd: string | null = null;

  // Bumped by every open, target switch and close: an answer that comes back
  // under an older value belongs to a form that is no longer on screen.
  let generation = 0;
  let availabilitySeq = 0;

  const dirty = computed(() => title.value !== initial.value.title || body.value !== initial.value.body);
  const canSubmit = computed(
    () => isOpen.value && !!repo.value && title.value.trim() !== "" && !submitting.value,
  );
  const originHtmlUrl = computed(() => targets.value.find((t) => t.isOrigin)?.htmlUrl || null);

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
    targets.value = t;
    available.value = t.length > 0;
  }

  function forgetTargets() {
    availabilitySeq++;
    if (!isOpen.value) targets.value = [];
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
    formCwd = deps.cwd.value;
    isOpen.value = true;
    loading.value = true;
    const [t, filled] = await Promise.all([
      readTargets(formCwd, true),
      Promise.resolve(prefill).catch(() => undefined),
    ]);
    if (gen !== generation) return;
    initial.value = { title: filled?.title ?? "", body: filled?.body ?? "" };
    title.value = initial.value.title;
    body.value = initial.value.body;
    loading.value = false;
    targetsFailed.value = t === null;
    if (t === null) return;
    targets.value = t;
    available.value = t.length > 0;
    const first = targets.value.find((x) => x.hasIssues);
    repo.value = first?.repo ?? null;
    if (repo.value) loadPickers(repo.value);
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
    forgetTargets,
    open,
    close,
    setRepo,
    submit,
  };
}
