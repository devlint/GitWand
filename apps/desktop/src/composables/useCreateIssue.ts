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
  open(prefill?: IssuePrefill): Promise<void>;
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

  // Bumped by every open, target switch and close: an answer that comes back
  // under an older value belongs to a form that is no longer on screen.
  let generation = 0;
  let availabilitySeq = 0;

  const dirty = computed(() => title.value !== initial.value.title || body.value !== initial.value.body);
  const canSubmit = computed(
    () => isOpen.value && !!repo.value && title.value.trim() !== "" && !submitting.value,
  );
  const originHtmlUrl = computed(() => targets.value.find((t) => t.isOrigin)?.htmlUrl || null);

  async function readTargets(): Promise<IssueTarget[] | null> {
    const p = deps.provider.value;
    const cwd = deps.cwd.value;
    if (!p?.issueTargets || !cwd) return [];
    try {
      const t = await p.issueTargets(cwd);
      return t.targets;
    } catch {
      return null;
    }
  }

  async function refreshAvailability(): Promise<void> {
    const seq = ++availabilitySeq;
    const t = await readTargets();
    if (seq !== availabilitySeq) return;
    targets.value = t ?? [];
    available.value = (t?.length ?? 0) > 0;
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
    const cwd = deps.cwd.value;
    if (!p || !cwd) return;
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

  async function open(prefill?: IssuePrefill): Promise<void> {
    reset();
    const gen = generation;
    initial.value = { title: prefill?.title ?? "", body: prefill?.body ?? "" };
    title.value = initial.value.title;
    body.value = initial.value.body;
    isOpen.value = true;
    loading.value = true;
    const t = await readTargets();
    if (gen !== generation) return;
    loading.value = false;
    targets.value = t ?? [];
    available.value = targets.value.length > 0;
    targetsFailed.value = t === null;
    if (t === null) return;
    const first = targets.value.find((x) => x.hasIssues);
    repo.value = first?.repo ?? null;
    if (repo.value) loadPickers(repo.value);
  }

  function setRepo(next: string) {
    if (next === repo.value) return;
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
    const cwd = deps.cwd.value;
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
    open,
    close,
    setRepo,
    submit,
  };
}
