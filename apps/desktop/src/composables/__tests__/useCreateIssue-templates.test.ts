/**
 * useCreateIssue — issue templates (#301, part 5).
 */
import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import { useCreateIssue } from "../useCreateIssue";
import type { ForgeProvider } from "../forge/types";

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const PARENT = { repo: "up/app", htmlUrl: "https://github.com/up/app", hasIssues: true, isOrigin: false, canTriage: true };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const BUG = "---\nname: Bug\nabout: It broke\ntitle: '[Bug] '\nlabels: bug, nope\nassignees: alice, ghost\n---\n## Steps\n";

function setup(files: Record<string, { path: string; content: string }[] | (() => Promise<{ path: string; content: string }[]>)> = {}) {
  const provider = {
    name: "github",
    issueAvailable: vi.fn(async () => true),
    issueTargets: vi.fn(async () => ({ targets: [ORIGIN, PARENT], defaultRepo: "me/app" })),
    listLabels: vi.fn(async () => [{ name: "bug", color: "f00", description: null }]),
    listMilestones: vi.fn(async () => []),
    listAssignees: vi.fn(async () => [{ login: "alice", name: null, avatarUrl: null }]),
    createIssue: vi.fn(),
  } as unknown as ForgeProvider;
  const issueTemplates = vi.fn(async (_cwd: string, repo: string) => {
    const f = files[repo] ?? [];
    return typeof f === "function" ? f() : f;
  });
  const form = useCreateIssue({ cwd: ref("/repo"), provider: ref(provider), onCreated: vi.fn(), issueTemplates });
  return { form, issueTemplates };
}

describe("useCreateIssue — issue templates", () => {
  it("loads the default target's templates in a blank form, and again on a target switch", async () => {
    const { form, issueTemplates } = setup({ "me/app": [{ path: "a.md", content: BUG }], "up/app": [] });
    await form.open();
    await flush();
    expect(form.blankForm.value).toBe(true);
    expect(form.templateSet.value?.templates.map((t) => t.name)).toEqual(["Bug"]);
    form.setRepo("up/app");
    await flush();
    expect(issueTemplates).toHaveBeenLastCalledWith("/repo", "up/app");
    expect(form.templateSet.value?.templates).toEqual([]);
  });

  it("drops a late answer for the target left", async () => {
    let late!: (v: { path: string; content: string }[]) => void;
    const { form } = setup({ "me/app": () => new Promise((r) => { late = r; }), "up/app": [] });
    await form.open();
    form.setRepo("up/app");
    await flush();
    late([{ path: "a.md", content: BUG }]);
    await flush();
    expect(form.templateSet.value?.templates).toEqual([]);
  });

  it("a prefilled form reads no templates", async () => {
    const { form, issueTemplates } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.open({ title: "t", body: "b" });
    await flush();
    expect(form.blankForm.value).toBe(false);
    expect(issueTemplates).not.toHaveBeenCalled();
  });

  it("applying a template fills title and body, labels and assignees the target offers", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    expect(form.templateId.value).toBe("a.md");
    expect(form.title.value).toBe("[Bug] ");
    expect(form.body.value).toBe("## Steps\n");
    expect(form.labels.value).toEqual(["bug"]);
    expect(form.assignees.value).toEqual(["alice"]);
    expect(form.bodyEdited.value).toBe(false);
  });

  it("Blank issue clears what a template filled", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    form.applyTemplate(null);
    expect(form.templateId.value).toBeNull();
    expect([form.title.value, form.body.value]).toEqual(["", ""]);
    expect(form.labels.value).toEqual([]);
    expect(form.assignees.value).toEqual([]);
  });

  it("a failed read leaves no templates and no error", async () => {
    const { form } = setup({ "me/app": () => Promise.reject(new Error("offline")) });
    await form.open();
    await flush();
    expect(form.templateSet.value).toBeNull();
    expect(form.error.value).toBeNull();
  });
});
