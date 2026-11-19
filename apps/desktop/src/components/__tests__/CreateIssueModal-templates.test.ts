// @vitest-environment jsdom
/**
 * CreateIssueModal — the "Template" row of a blank form (#301, part 5).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createApp, nextTick, ref, type App } from "vue";
import CreateIssueModal from "../CreateIssueModal.vue";
import { CREATE_ISSUE_KEY, useCreateIssue, clearTemplateCache } from "../../composables/useCreateIssue";
import type { ForgeProvider } from "../../composables/forge/types";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const BUG = "---\nname: Bug\nabout: It broke\ntitle: '[Bug] '\n---\n## Steps\n";
const CONFIG = "blank_issues_enabled: false\ncontact_links:\n  - name: Discussions\n    url: https://github.com/me/app/discussions\n    about: Ask here\n";

let app: App | null = null;
beforeEach(() => clearTemplateCache());
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); await nextTick(); };

async function mount(files: { path: string; content: string }[] | (() => Promise<{ path: string; content: string }[]>), opts: { confirm?: boolean; prefill?: boolean } = {}) {
  const provider = {
    name: "github",
    issueAvailable: vi.fn(async () => true),
    issueTargets: vi.fn(async () => ({ targets: [ORIGIN], defaultRepo: "me/app" })),
    listLabels: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    listAssignees: vi.fn(async () => []),
    createIssue: vi.fn(),
  } as unknown as ForgeProvider;
  const askConfirm = vi.fn(async () => opts.confirm ?? true);
  const form = useCreateIssue({ cwd: ref("/repo"), provider: ref(provider), onCreated: vi.fn(), issueTemplates: async () => ({ files: typeof files === "function" ? await files() : files, complete: true }) });
  const host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(CreateIssueModal);
  app.provide(CREATE_ISSUE_KEY, form);
  app.provide("askConfirm", askConfirm);
  app.mount(host);
  await form.open(opts.prefill ? { title: "t", body: "b" } : undefined);
  await flush();
  return { form, askConfirm };
}

const select = () => document.querySelector<HTMLSelectElement>('[data-testid="ci-template"]');
async function choose(value: string) {
  const s = select()!;
  s.value = value;
  s.dispatchEvent(new Event("change"));
  await flush();
}

describe("CreateIssueModal — templates", () => {
  it("offers Blank issue first, then each template", async () => {
    await mount([{ path: "a.md", content: BUG }]);
    const opts = [...select()!.options].map((o) => o.textContent?.trim());
    expect(opts).toEqual(["createIssue.template.blank", "Bug"]);
  });

  it("choosing a template fills the form", async () => {
    const { form } = await mount([{ path: "a.md", content: BUG }]);
    await choose("a.md");
    expect(form.title.value).toBe("[Bug] ");
    expect(form.body.value).toBe("## Steps\n");
  });

  it("asks before replacing an edited text, and keeps it on cancel", async () => {
    const { form, askConfirm } = await mount([{ path: "a.md", content: BUG }], { confirm: false });
    form.body.value = "mine";
    await flush();
    await choose("a.md");
    expect(askConfirm).toHaveBeenCalled();
    expect(form.body.value).toBe("mine");
    expect(select()!.value).toBe("");
  });

  it("a target switched during the confirmation applies nothing", async () => {
    const { form, askConfirm } = await mount([{ path: "a.md", content: BUG }]);
    let answer!: (ok: boolean) => void;
    askConfirm.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
    form.body.value = "mine";
    await flush();
    await choose("a.md");
    form.repo.value = "up/app";
    answer(true);
    await flush();
    expect(form.body.value).toBe("mine");
  });

  it("asks with its own title before clearing to a blank issue", async () => {
    const { form, askConfirm } = await mount([{ path: "a.md", content: BUG }]);
    await choose("a.md");
    form.body.value = "edited";
    await flush();
    await choose("");
    expect(askConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ title: "createIssue.template.clearTitle" }));
  });

  it("says the repository expects a template, and lists its contact links", async () => {
    await mount([{ path: "a.md", content: BUG }, { path: ".github/ISSUE_TEMPLATE/config.yml", content: CONFIG }]);
    expect(document.body.textContent).toContain("createIssue.template.expectsTemplate");
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="ci-contact-link"]');
    expect(link?.textContent).toContain("Discussions");
  });

  it("says templates are loading meanwhile", async () => {
    await mount(() => new Promise(() => {}));
    expect(document.body.textContent).toContain("createIssue.template.loading");
  });

  it("no row without templates, nor in a prefilled form", async () => {
    await mount([]);
    expect(select()).toBeNull();
    app!.unmount(); document.body.innerHTML = "";
    await mount([{ path: "a.md", content: BUG }], { prefill: true });
    expect(select()).toBeNull();
  });
});
