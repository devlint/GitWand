import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import { useCreateIssue, isNewIssueShortcut, newIssueShortcutLabel } from "../useCreateIssue";
import type { ForgeProvider } from "../forge/types";
import type { IssueTargets, CreatedIssue, RepoLabel } from "../../utils/backend";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const PARENT = { repo: "org/app", htmlUrl: "https://github.com/org/app", hasIssues: true, isOrigin: false, canTriage: true };

function provider(over: Partial<ForgeProvider> = {}, targets: IssueTargets = { targets: [ORIGIN], defaultRepo: "me/app" }) {
  return {
    name: "github",
    issueAvailable: vi.fn(async () => true),
    issueTargets: vi.fn(async () => targets),
    listLabels: vi.fn(async (_c: string, repo: string) => [{ name: `bug@${repo}`, color: "f00", description: null }]),
    listMilestones: vi.fn(async () => [{ number: 1, title: "v1", dueOn: null }]),
    listAssignees: vi.fn(async () => [{ login: "me", name: null, avatar_url: null }]),
    createIssue: vi.fn(async (): Promise<CreatedIssue> => ({ number: 7, url: "https://github.com/me/app/issues/7" })),
    ...over,
  } as unknown as ForgeProvider;
}

function setup(
  p: ForgeProvider,
  cwd = ref<string | null>("/repo"),
  commitOnOrigin: (cwd: string, sha: string) => Promise<boolean> = async () => false,
) {
  const onCreated = vi.fn();
  const api = useCreateIssue({ cwd, provider: ref(p), onCreated, commitOnOrigin });
  return { api, onCreated, cwd };
}

const COMMIT = {
  hash: "abc1234", hashFull: "abc1234".padEnd(40, "f"), author: "Ada", email: "a@b", date: "",
  message: "fix: x", body: "", parents: [], refs: "",
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useCreateIssue", () => {
  it("open() selects the default target and loads its pickers", async () => {
    const p = provider();
    const { api } = setup(p);
    await api.open();
    await flush();
    expect(api.isOpen.value).toBe(true);
    expect(api.repo.value).toBe("me/app");
    expect(api.labelOptions.value.map((l) => l.name)).toEqual(["bug@me/app"]);
    expect(api.milestoneOptions.value).toHaveLength(1);
    expect(api.assigneeOptions.value).toHaveLength(1);
  });

  it("open(prefill) fills title and body, and is not dirty until edited", async () => {
    const { api } = setup(provider());
    await api.open({ title: "fix: x", body: "Commit …" });
    expect(api.title.value).toBe("fix: x");
    expect(api.body.value).toBe("Commit …");
    expect(api.dirty.value).toBe(false);
    api.body.value += " more";
    expect(api.dirty.value).toBe(true);
  });

  it("drops a late picker answer for the previous target and clears selections on switch", async () => {
    const first = deferred<RepoLabel[]>();
    const p = provider(
      { listLabels: vi.fn((_c: string, repo: string) => (repo === "me/app" ? first.promise : Promise.resolve([{ name: "parent-label", color: "", description: null }]))) },
      { targets: [ORIGIN, PARENT], defaultRepo: "me/app" },
    );
    const { api } = setup(p);
    await api.open();
    api.labels.value = ["bug"];
    api.assignees.value = ["me"];
    api.milestone.value = 1;
    api.setRepo("org/app");
    expect(api.labels.value).toEqual([]);
    expect(api.assignees.value).toEqual([]);
    expect(api.milestone.value).toBeNull();
    await flush();
    first.resolve([{ name: "origin-label", color: "", description: null }]);
    await flush();
    expect(api.labelOptions.value.map((l) => l.name)).toEqual(["parent-label"]);
  });

  it("a failed picker read leaves that list empty and raises no error", async () => {
    const { api } = setup(provider({ listLabels: vi.fn(async () => { throw new Error("403"); }) }));
    await api.open();
    await flush();
    expect(api.labelOptions.value).toEqual([]);
    expect(api.error.value).toBeNull();
  });

  it("cannot submit a blank title, without a target, or while submitting", async () => {
    const { api } = setup(provider());
    await api.open();
    api.title.value = "   ";
    expect(api.canSubmit.value).toBe(false);
    api.title.value = "ok";
    expect(api.canSubmit.value).toBe(true);
    api.repo.value = null;
    expect(api.canSubmit.value).toBe(false);
  });

  it("has no target to submit to when no target has issues", async () => {
    const { api } = setup(provider({}, { targets: [{ ...ORIGIN, hasIssues: false }], defaultRepo: null }));
    await api.open();
    api.title.value = "ok";
    expect(api.repo.value).toBeNull();
    expect(api.canSubmit.value).toBe(false);
  });

  it("creates the issue once when submit is called twice in the same tick", async () => {
    const p = provider();
    const { api } = setup(p);
    await api.open();
    api.title.value = "ok";
    await Promise.all([api.submit(), api.submit()]);
    expect(p.createIssue).toHaveBeenCalledTimes(1);
  });

  it("keeps every field and shows GitHub's message when creation fails", async () => {
    const p = provider({ createIssue: vi.fn(async () => { throw new Error("HTTP 403: Resource not accessible"); }) });
    const { api, onCreated } = setup(p);
    await api.open({ title: "t", body: "b" });
    api.labels.value = ["bug"];
    await api.submit();
    expect(api.error.value).toBe("HTTP 403: Resource not accessible");
    expect(api.isOpen.value).toBe(true);
    expect(api.title.value).toBe("t");
    expect(api.body.value).toBe("b");
    expect(api.labels.value).toEqual(["bug"]);
    expect(api.submitting.value).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("sends the form and closes on success", async () => {
    const p = provider();
    const { api, onCreated } = setup(p);
    await api.open({ title: " t ", body: "b" });
    api.labels.value = ["bug"];
    api.milestone.value = 1;
    await api.submit();
    expect(p.createIssue).toHaveBeenCalledWith("/repo", {
      repo: "me/app", title: " t ", body: "b", labels: ["bug"], assignees: [], milestone: 1,
    });
    expect(onCreated).toHaveBeenCalledWith({ number: 7, url: "https://github.com/me/app/issues/7" });
    expect(api.isOpen.value).toBe(false);
    expect(api.title.value).toBe("");
  });

  it("flags a failed target read instead of offering a form", async () => {
    const { api } = setup(provider({ issueTargets: vi.fn(async () => { throw new Error("offline"); }) }));
    await api.open();
    expect(api.targetsFailed.value).toBe(true);
    expect(api.repo.value).toBeNull();
    api.title.value = "ok";
    expect(api.canSubmit.value).toBe(false);
  });

  it("exposes origin's page for commit links", async () => {
    const { api } = setup(provider({}, { targets: [ORIGIN, PARENT], defaultRepo: "org/app" }));
    await api.open();
    expect(api.originHtmlUrl.value).toBe("https://github.com/me/app");
  });

  it("ignores open() while the form is already open, keeping what was typed", async () => {
    const p = provider();
    const { api } = setup(p);
    await api.open();
    api.title.value = "typed";
    await api.open({ title: "other", body: "" });
    expect(api.title.value).toBe("typed");
    expect(p.issueTargets).toHaveBeenCalledTimes(1);
  });

  it("does not switch target while an issue is being created", async () => {
    const created = deferred<CreatedIssue>();
    const p = provider({ createIssue: vi.fn(() => created.promise) }, { targets: [ORIGIN, PARENT], defaultRepo: "me/app" });
    const { api, onCreated } = setup(p);
    await api.open();
    api.title.value = "t";
    const pending = api.submit();
    api.setRepo("org/app");
    expect(api.repo.value).toBe("me/app");
    created.resolve({ number: 9, url: "u" });
    await pending;
    expect(onCreated).toHaveBeenCalledWith({ number: 9, url: "u" });
    expect(api.isOpen.value).toBe(false);
  });

  it("loads no pickers for a target where the user cannot triage", async () => {
    const p = provider({}, { targets: [{ ...ORIGIN, canTriage: false }], defaultRepo: "me/app" });
    const { api } = setup(p);
    await api.open();
    await flush();
    expect(p.listLabels).not.toHaveBeenCalled();
    expect(p.listAssignees).not.toHaveBeenCalled();
    expect(p.listMilestones).not.toHaveBeenCalled();
  });

  it("files the issue on the repository it was opened for, even after the app switches", async () => {
    const p = provider();
    const { api, cwd } = setup(p);
    await api.open();
    cwd.value = "/other";
    api.title.value = "t";
    await api.submit();
    expect((p.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/repo");
  });

  it("counts picked labels, assignees and milestone as unsaved work", async () => {
    const { api } = setup(provider());
    await api.open();
    expect(api.dirty.value).toBe(false);
    api.labels.value = ["bug"];
    expect(api.dirty.value).toBe(true);
    api.labels.value = [];
    api.milestone.value = 1;
    expect(api.dirty.value).toBe(true);
    api.milestone.value = null;
    api.assignees.value = ["me"];
    expect(api.dirty.value).toBe(true);
  });

  it("openFromCommit links the commit when origin has it", async () => {
    const onOrigin = vi.fn(async () => true);
    const { api } = setup(provider(), undefined, onOrigin);
    await api.refreshAvailability();
    await api.openFromCommit(COMMIT);
    expect(onOrigin).toHaveBeenCalledWith("/repo", COMMIT.hashFull);
    expect(api.body.value).toContain(`(https://github.com/me/app/commit/${COMMIT.hashFull})`);
  });

  it("openFromCommit leaves an unpushed commit unlinked, and a failed check too", async () => {
    const a = setup(provider(), undefined, async () => false);
    await a.api.refreshAvailability();
    await a.api.openFromCommit(COMMIT);
    expect(a.api.body.value).not.toContain("](");
    const b = setup(provider(), undefined, async () => { throw new Error("git"); });
    await b.api.refreshAvailability();
    await b.api.openFromCommit(COMMIT);
    expect(b.api.isOpen.value).toBe(true);
    expect(b.api.body.value).not.toContain("](");
  });

  it("openFromCommit does nothing when the repository cannot take an issue", async () => {
    const { api } = setup(provider({ issueAvailable: vi.fn(async () => false) }));
    await api.refreshAvailability();
    await api.openFromCommit(COMMIT);
    expect(api.isOpen.value).toBe(false);
  });


  it("is available when origin is on GitHub (the local check), not otherwise", async () => {
    const a = setup(provider());
    await a.api.refreshAvailability();
    expect(a.api.available.value).toBe(true);
    const b = setup(provider({ issueAvailable: vi.fn(async () => false) }));
    await b.api.refreshAvailability();
    expect(b.api.available.value).toBe(false);
    const c = setup(provider({ issueAvailable: undefined }));
    await c.api.refreshAvailability();
    expect(c.api.available.value).toBe(false);
  });

  it("reads no target to decide availability", async () => {
    const p = provider();
    const { api } = setup(p);
    await api.refreshAvailability();
    expect(p.issueTargets).not.toHaveBeenCalled();
  });

  it("forgetAvailability hides the entry points, and a late answer for the old repository does not bring them back", async () => {
    const answer = deferred<boolean>();
    const { api } = setup(provider({ issueAvailable: vi.fn(() => answer.promise) }));
    const refreshing = api.refreshAvailability();
    api.forgetAvailability();
    answer.resolve(true);
    await refreshing;
    expect(api.available.value).toBe(false);
  });

  it("shows the form once the targets are read, the prefill landing after", async () => {
    const prefill = deferred<{ title: string; body: string }>();
    const { api } = setup(provider());
    const opening = api.open(() => prefill.promise);
    await flush();
    expect(api.loading.value).toBe(false);
    expect(api.repo.value).toBe("me/app");
    prefill.resolve({ title: "from commit", body: "b" });
    await opening;
    expect(api.title.value).toBe("from commit");
    expect(api.dirty.value).toBe(false);
  });

  it("does not overwrite what the user typed with a late prefill", async () => {
    const prefill = deferred<{ title: string; body: string }>();
    const { api } = setup(provider());
    const opening = api.open(() => prefill.promise);
    await flush();
    api.title.value = "mine";
    prefill.resolve({ title: "from commit", body: "b" });
    await opening;
    expect(api.title.value).toBe("mine");
  });

  it("keeps a late prefill when the user switched target while it loaded", async () => {
    const prefill = deferred<{ title: string; body: string }>();
    const { api } = setup(provider({}, { targets: [ORIGIN, PARENT], defaultRepo: "me/app" }));
    const opening = api.open(() => prefill.promise);
    await flush();
    api.setRepo("org/app");
    prefill.resolve({ title: "from commit", body: "b" });
    await opening;
    expect(api.repo.value).toBe("org/app");
    expect(api.title.value).toBe("from commit");
  });

  it("gives an untouched open form way to a commit's, and keeps a touched one", async () => {
    const { api } = setup(provider(), undefined, async () => true);
    await api.refreshAvailability();
    await api.open();
    await api.openFromCommit(COMMIT);
    expect(api.title.value).toBe("fix: x");
    api.title.value = "edited";
    await api.openFromCommit({ ...COMMIT, message: "other" });
    expect(api.title.value).toBe("edited");
  });
});

describe("isNewIssueShortcut", () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: "I", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;
  it("is ⌘⇧I on macOS", () => {
    expect(isNewIssueShortcut(ev({ metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isNewIssueShortcut(ev({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
  });
  it("leaves Ctrl+Shift+I to the WebView inspector elsewhere, using Ctrl+Alt+I", () => {
    expect(isNewIssueShortcut(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isNewIssueShortcut(ev({ ctrlKey: true, altKey: true, key: "i" }), false)).toBe(true);
  });
});

describe("isNewIssueShortcut — off macOS", () => {
  const ev = (o: Partial<KeyboardEvent> & { altGraph?: boolean; target?: EventTarget | null }) =>
    ({
      key: "i", metaKey: false, ctrlKey: true, shiftKey: false, altKey: true, target: null,
      getModifierState: (k: string) => k === "AltGraph" && !!o.altGraph,
      ...o,
    }) as unknown as KeyboardEvent;
  it("ignores AltGr+I (a character on some layouts)", () => {
    expect(isNewIssueShortcut(ev({ altGraph: true }), false)).toBe(false);
  });
  it("ignores the keystroke inside a text field or the terminal", () => {
    const input = { tagName: "TEXTAREA", isContentEditable: false, closest: () => null } as unknown as EventTarget;
    const term = { tagName: "DIV", isContentEditable: false, closest: (sel: string) => (sel.includes("xterm") ? {} : null) } as unknown as EventTarget;
    expect(isNewIssueShortcut(ev({ target: input }), false)).toBe(false);
    expect(isNewIssueShortcut(ev({ target: term }), false)).toBe(false);
    expect(isNewIssueShortcut(ev({}), false)).toBe(true);
  });
  it("is labelled for the platform", () => {
    expect(newIssueShortcutLabel(true)).toBe("⌘⇧I");
    expect(newIssueShortcutLabel(false)).toBe("Ctrl+Alt+I");
  });
});
