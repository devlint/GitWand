/**
 * useCreateIssue — issue templates (#301, part 5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { useCreateIssue, clearTemplateCache } from "../useCreateIssue";
import type { ConflictHunk } from "@gitwand/core";
import type { ForgeProvider } from "../forge/types";

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const PARENT = { repo: "up/app", htmlUrl: "https://github.com/up/app", hasIssues: true, isOrigin: false, canTriage: true };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const BUG = "---\nname: Bug\nabout: It broke\ntitle: '[Bug] '\nlabels: bug, nope\nassignees: alice, ghost\n---\n## Steps\n";

beforeEach(() => clearTemplateCache());

function setup(files: Record<string, { path: string; content: string }[] | (() => Promise<{ path: string; content: string }[]>)> = {}, incomplete = new Set<string>()) {
  const provider = {
    name: "github",
    issueAvailable: vi.fn(async () => true),
    issueTargets: vi.fn(async () => ({ targets: [ORIGIN, PARENT], defaultRepo: "me/app" })),
    listLabels: vi.fn(async () => [{ name: "bug", color: "f00", description: null }]),
    listMilestones: vi.fn(async () => []),
    listAssignees: vi.fn(async () => [{ login: "alice", name: null, avatarUrl: null }, { login: "bob", name: null, avatarUrl: null }]),
    createIssue: vi.fn(),
  } as unknown as ForgeProvider;
  const issueTemplates = vi.fn(async (_cwd: string, repo: string) => {
    const f = files[repo] ?? [];
    return { files: typeof f === "function" ? await f() : f, complete: !incomplete.has(repo) };
  });
  const form = useCreateIssue({
    cwd: ref("/repo"),
    provider: ref(provider),
    onCreated: vi.fn(),
    issueTemplates,
    report: {
      createGitwandIssue: vi.fn(),
      gitwandWritable: async () => true,
      env: () => ({ version: "1", platform: "macOS" }),
      secretsOptions: async () => ({ extraPatterns: [], entropyThreshold: 4 }),
      scanDebounceMs: 0,
    },
  });
  return { form, issueTemplates, provider };
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

describe("useCreateIssue — templates, review follow-ups", () => {
  it("a resolution report never offers templates", async () => {
    const { form, issueTemplates } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.openFromResolution({
      kind: "engine",
      path: "a.ts",
      hunk: { baseLines: ["a"], oursLines: ["b"], theirsLines: ["c"], startLine: 1, type: "non_overlapping", confidence: { score: 90, label: "high", dimensions: {}, boosters: [], penalties: [] }, explanation: "e", trace: { steps: [], selected: "non_overlapping", summary: "s", hasBase: true } } as unknown as ConflictHunk,
      resolvedLines: ["bc"],
    });
    await flush();
    expect(form.blankForm.value).toBe(false);
    expect(issueTemplates).not.toHaveBeenCalled();
  });

  it("hand-picked labels and assignees stay; a template adds its own and takes them back", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.open();
    await flush();
    form.labels.value = ["ui"];
    form.assignees.value = ["bob"];
    form.applyTemplate("a.md");
    expect(form.labels.value).toEqual(["ui", "bug"]);
    expect(form.assignees.value).toEqual(["bob", "alice"]);
    form.applyTemplate(null);
    expect(form.labels.value).toEqual(["ui"]);
    expect(form.assignees.value).toEqual(["bob"]);
  });

  it("a template picked before the pickers loaded gets its labels once they arrive", async () => {
    let labelsArrive!: (v: unknown) => void;
    const { form, provider } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    (provider.listLabels as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { labelsArrive = r; }));
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    expect(form.labels.value).toEqual([]);
    labelsArrive([{ name: "bug", color: "f00", description: null }]);
    await flush();
    expect(form.labels.value).toEqual(["bug"]);
  });

  it("templates are kept a few minutes per target: a second blank form reads none", async () => {
    const { form, issueTemplates } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.open();
    await flush();
    form.close();
    await form.open();
    await flush();
    expect(issueTemplates).toHaveBeenCalledTimes(1);
    expect(form.templateSet.value?.templates).toHaveLength(1);
  });
});

describe("useCreateIssue — templates, first pass follow-ups", () => {
  it("a template label removed by hand is not added back when other options arrive", async () => {
    let peopleArrive!: (v: unknown) => void;
    const { form, provider } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    (provider.listAssignees as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => { peopleArrive = r; }));
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    expect(form.labels.value).toEqual(["bug"]);
    form.labels.value = [];
    peopleArrive([{ login: "alice", name: null, avatarUrl: null }]);
    await flush();
    expect(form.labels.value).toEqual([]);
    expect(form.assignees.value).toEqual(["alice"]);
  });

  it("switching target forgets what the template wanted", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: BUG }], "up/app": [] });
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    form.setRepo("up/app");
    await flush();
    expect(form.labels.value).toEqual([]);
    expect(form.assignees.value).toEqual([]);
  });

  it("a label picked by hand before the template stays when the template goes", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: BUG }] });
    await form.open();
    await flush();
    form.labels.value = ["bug"];
    form.applyTemplate("a.md");
    form.applyTemplate(null);
    expect(form.labels.value).toEqual(["bug"]);
  });

  it("a cache hit is not loading, even with another target's read in flight", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: BUG }], "up/app": () => new Promise(() => {}) });
    await form.open();
    await flush();
    form.setRepo("up/app");
    expect(form.templatesLoading.value).toBe(true);
    form.setRepo("me/app");
    expect(form.templatesLoading.value).toBe(false);
  });

  it("a template merely picked gives way (it is one click to pick again)", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: "---\nname: Plain\n---\nbody" }] });
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    // `dirty` is what makeRoom() and the close confirmation go by.
    expect(form.dirty.value).toBe(false);
  });

  it("an incomplete set (a file could not be read) is not kept", async () => {
    const { form, issueTemplates } = setup({ "me/app": [{ path: "a.md", content: BUG }] }, new Set(["me/app"]));
    await form.open();
    await flush();
    expect(form.templateSet.value?.templates).toHaveLength(1);
    form.close();
    await form.open();
    await flush();
    expect(issueTemplates).toHaveBeenCalledTimes(2);
  });

  it("matches labels and logins without case, keeping the repository's spelling", async () => {
    const { form } = setup({ "me/app": [{ path: "a.md", content: "---\nname: X\nlabels: BUG\nassignees: Alice\n---\nb" }] });
    await form.open();
    await flush();
    form.applyTemplate("a.md");
    expect(form.labels.value).toEqual(["bug"]);
    expect(form.assignees.value).toEqual(["alice"]);
  });
});
