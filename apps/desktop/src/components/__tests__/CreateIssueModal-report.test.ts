// @vitest-environment jsdom
/**
 * CreateIssueModal — report mode (#301, part 3): the answer field, the
 * "Send to GitWand" switch and its guardrails.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp, nextTick, ref, type App } from "vue";
import type { ConflictHunk } from "@gitwand/core";
import CreateIssueModal from "../CreateIssueModal.vue";
import { CREATE_ISSUE_KEY, useCreateIssue } from "../../composables/useCreateIssue";
import type { ForgeProvider } from "../../composables/forge/types";
import type { IssueTargets } from "../../utils/backend";
import type { ResolutionReport } from "../../utils/resolutionReport";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const REPORT: ResolutionReport = {
  kind: "engine",
  path: "src/x.ts",
  hunk: {
    baseLines: ["a"],
    oursLines: ["b"],
    theirsLines: ["c"],
    startLine: 3,
    type: "non_overlapping",
    confidence: { score: 90, label: "high", dimensions: {}, boosters: [], penalties: [] },
    explanation: "e",
    trace: { steps: [], selected: "non_overlapping", summary: "s", hasBase: true },
  } as unknown as ConflictHunk,
  resolvedLines: ["bc"],
};

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

async function mount(opts: { targets?: IssueTargets; writable?: boolean; confirm?: boolean; targetsError?: string } = {}) {
  const provider = {
    name: "github",
    issueTargets: vi.fn(async () => {
      if (opts.targetsError) throw new Error(opts.targetsError);
      return opts.targets ?? { targets: [ORIGIN], defaultRepo: "me/app" };
    }),
    listLabels: vi.fn(async () => [{ name: "bug", color: "f00", description: null }]),
    listMilestones: vi.fn(async () => []),
    listAssignees: vi.fn(async () => []),
    createIssue: vi.fn(async () => ({ number: 1, url: "u" })),
  } as unknown as ForgeProvider;
  const askConfirm = vi.fn(async () => opts.confirm ?? true);
  const form = useCreateIssue({
    cwd: ref("/repo"),
    provider: ref(provider),
    onCreated: vi.fn(),
    report: {
      createGitwandIssue: vi.fn(async () => ({ number: 2, url: "g" })),
      gitwandWritable: async () => opts.writable ?? true,
      env: () => ({ version: "3.13.2", platform: "macOS" }),
      secretsOptions: async () => ({ extraPatterns: [], entropyThreshold: 4 }),
      scanDebounceMs: 0,
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(CreateIssueModal);
  app.provide(CREATE_ISSUE_KEY, form);
  app.provide("askConfirm", askConfirm);
  app.mount(host);
  await form.openFromResolution(REPORT);
  await flush();
  return { form, askConfirm };
}

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel);
const createButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "createIssue.create");
const sw = () => $<HTMLInputElement>('[data-testid="ci-gitwand"]')!;
async function flip() {
  sw().click();
  await flush();
}

describe("CreateIssueModal — report mode", () => {
  it("shows the answer field and the switch, off, with the repository's pickers", async () => {
    await mount();
    expect($('[data-testid="ci-answer"]')).not.toBeNull();
    expect(sw().checked).toBe(false);
    expect(document.body.textContent).toContain("createIssue.labels");
    expect(document.body.textContent).not.toContain("createIssue.report.publicWarning");
  });

  it("on GitWand: the warning, the confirmation, no pickers, Create held until confirmed", async () => {
    const { form } = await mount();
    await flip();
    expect(form.toGitwand.value).toBe(true);
    expect(document.body.textContent).toContain("createIssue.report.publicWarning");
    expect(document.body.textContent).not.toContain("createIssue.labels");
    const confirm = $<HTMLInputElement>('[data-testid="ci-confirm-public"]')!;
    expect(createButton()?.disabled).toBe(true);
    confirm.click();
    await flush();
    expect(createButton()?.disabled).toBe(false);
  });

  it("lists a blocking secret with its line and holds Create", async () => {
    const { form } = await mount();
    await flip();
    $<HTMLInputElement>('[data-testid="ci-confirm-public"]')!.click();
    form.body.value = `a\nb\ntoken ${TOKEN}`;
    form.answer.value = `x ${TOKEN}`;
    await flush();
    const alert = $('[data-testid="ci-secrets"]');
    expect(alert?.textContent).toContain("createIssue.report.secretBlocking:3,github_pat_classic");
    expect(alert?.textContent).toContain("createIssue.report.secretBlockingAnswer:github_pat_classic");
    expect(createButton()?.disabled).toBe(true);
  });

  it("names a secret in the title as such", async () => {
    const { form } = await mount();
    await flip();
    form.title.value = `Leak ${TOKEN}`;
    await flush();
    expect($('[data-testid="ci-secrets"]')?.textContent).toContain("createIssue.report.secretBlockingTitle:github_pat_classic");
  });

  it("shows at most five warnings and counts the rest", async () => {
    const { form } = await mount();
    const hash = (i: number) => `"integrity": "sha512-Zm9vYmFyYmF6cXV4cXV1eA9xT3kL0pQ8rW2vY5zN1mH6jC4bD7eF0gA3iK9oU1sR8tE2wQ5yP4lM6nV3xB0cZ7${i}",`;
    form.answer.value = Array.from({ length: 12 }, (_, i) => hash(i)).join("\n");
    await flush();
    const box = $('[data-testid="ci-secrets"]')!;
    expect(box.querySelectorAll("p.ci-secret-warning")).toHaveLength(5);
    expect(box.textContent).toContain("createIssue.report.secretWarningMore:7");
  });

  it("never folds a known pattern into the high-entropy count", async () => {
    const { form } = await mount();
    const hash = (i: number) => `"integrity": "sha512-Zm9vYmFyYmF6cXV4cXV1eA9xT3kL0pQ8rW2vY5zN1mH6jC4bD7eF0gA3iK9oU1sR8tE2wQ5yP4lM6nV3xB0cZ7${i}",`;
    form.body.value = [...Array.from({ length: 12 }, (_, i) => hash(i)), "key AKIAIOSFODNN7EXAMPLE"].join("\n");
    await flush();
    expect($('[data-testid="ci-secrets"]')!.textContent).toContain("createIssue.report.secretWarning:13,aws_access_key_id");
  });

  it("names the public repository in the warning from the constant", async () => {
    await mount();
    await flip();
    expect(document.body.textContent).toContain("createIssue.report.publicWarning:devlint/GitWand");
  });

  it("disables the switch with its reason when GitWand cannot be written to", async () => {
    await mount({ writable: false });
    expect(sw().disabled).toBe(true);
    expect(document.body.textContent).toContain("createIssue.report.gitwandUnavailable");
  });

  it("the sign-in hint is not an error while the report goes to the repository", async () => {
    await mount({ writable: false });
    const hint = [...document.querySelectorAll("p")].find((p) => p.textContent?.includes("createIssue.report.gitwandUnavailable"))!;
    expect(hint.classList.contains("ci-status--error")).toBe(false);
  });

  it("says when the text is too long for GitHub", async () => {
    const { form } = await mount();
    form.body.value = "x".repeat(70_000);
    await flush();
    expect(document.body.textContent).toContain("createIssue.tooLong");
    expect(createButton()?.disabled).toBe(true);
  });

  it("is checked and locked when the repository cannot take the issue", async () => {
    await mount({ targets: { targets: [], defaultRepo: null } });
    expect(sw().checked).toBe(true);
    expect(sw().disabled).toBe(true);
    expect(document.body.textContent).toContain("createIssue.report.repoUnavailable");
  });

  it("still offers GitWand when the targets cannot be read, saying why", async () => {
    await mount({ targetsError: "gh: not signed in to ghe.acme" });
    expect(sw().checked).toBe(true);
    expect(document.body.textContent).toContain("gh: not signed in to ghe.acme");
    expect(document.body.textContent).not.toContain("createIssue.targetsFailed");
  });

  it("a switch confirmed after the form changed does nothing", async () => {
    const { form, askConfirm } = await mount();
    let answer!: (ok: boolean) => void;
    askConfirm.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
    form.body.value += "\nmine";
    await flush();
    sw().click();
    await flush();
    form.close();
    await form.openFromResolution(REPORT);
    await flush();
    answer(true);
    await flush();
    expect(form.toGitwand.value).toBe(false);
  });

  it("asks before replacing an edited description, and keeps it on cancel", async () => {
    const { form, askConfirm } = await mount({ confirm: false });
    form.body.value += "\nmine";
    await flush();
    await flip();
    expect(askConfirm).toHaveBeenCalled();
    expect(form.toGitwand.value).toBe(false);
    expect(form.body.value).toContain("mine");
    expect(sw().checked).toBe(false);
  });

  it("asks before replacing an edited title too", async () => {
    const { form, askConfirm } = await mount({ confirm: false });
    form.title.value = "My own title";
    await flush();
    await flip();
    expect(askConfirm).toHaveBeenCalled();
    expect(form.title.value).toBe("My own title");
  });

  it("caps the answer field", async () => {
    await mount();
    expect($<HTMLTextAreaElement>('[data-testid="ci-answer"]')!.maxLength).toBe(10000);
  });

  it("previews the answer on top of the description", async () => {
    const { form } = await mount();
    form.answer.value = "keep both";
    await flush();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "createIssue.tabPreview")!.click();
    await flush();
    expect($('[data-testid="ci-preview"]')?.textContent).toContain("keep both");
  });
});
