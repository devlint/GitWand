import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import { useCreateIssue } from "../useCreateIssue";
import type { ForgeProvider } from "../forge/types";
import type { IssueTargets, CreatedIssue, RepoLabel } from "../../utils/backend";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true };
const PARENT = { repo: "org/app", htmlUrl: "https://github.com/org/app", hasIssues: true, isOrigin: false };

function provider(over: Partial<ForgeProvider> = {}, targets: IssueTargets = { targets: [ORIGIN], defaultRepo: "me/app" }) {
  return {
    name: "github",
    issueTargets: vi.fn(async () => targets),
    listLabels: vi.fn(async (_c: string, repo: string) => [{ name: `bug@${repo}`, color: "f00", description: null }]),
    listMilestones: vi.fn(async () => [{ number: 1, title: "v1", dueOn: null }]),
    listAssignees: vi.fn(async () => [{ login: "me", name: null, avatar_url: null }]),
    createIssue: vi.fn(async (): Promise<CreatedIssue> => ({ number: 7, url: "https://github.com/me/app/issues/7" })),
    ...over,
  } as unknown as ForgeProvider;
}

function setup(p: ForgeProvider) {
  const onCreated = vi.fn();
  const api = useCreateIssue({ cwd: ref("/repo"), provider: ref(p), onCreated });
  return { api, onCreated };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useCreateIssue", () => {
  it("is available when the repository has at least one issue target", async () => {
    const { api } = setup(provider());
    await api.refreshAvailability();
    expect(api.available.value).toBe(true);
  });

  it("is not available without targets, nor without the provider method", async () => {
    const a = setup(provider({}, { targets: [], defaultRepo: null }));
    await a.api.refreshAvailability();
    expect(a.api.available.value).toBe(false);
    const b = setup(provider({ issueTargets: undefined }));
    await b.api.refreshAvailability();
    expect(b.api.available.value).toBe(false);
  });

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
});
