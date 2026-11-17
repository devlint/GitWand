// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp, nextTick, ref, type App } from "vue";
import CreateIssueModal from "../CreateIssueModal.vue";
import { CREATE_ISSUE_KEY, useCreateIssue } from "../../composables/useCreateIssue";
import type { ForgeProvider } from "../../composables/forge/types";
import type { IssueTargets } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const PARENT_OFF = { repo: "org/app", htmlUrl: "https://github.com/org/app", hasIssues: false, isOrigin: false, canTriage: false };

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

async function mount(
  targets: IssueTargets = { targets: [ORIGIN], defaultRepo: "me/app" },
  askConfirm: (o: { title: string; message: string }) => Promise<boolean> = async () => true,
  createIssue: () => Promise<{ number: number; url: string }> = async () => ({ number: 1, url: "u" }),
) {
  const provider = {
    name: "github",
    issueTargets: vi.fn(async () => targets),
    listLabels: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    listAssignees: vi.fn(async () => []),
    createIssue: vi.fn(createIssue),
  } as unknown as ForgeProvider;
  const form = useCreateIssue({ cwd: ref("/repo"), provider: ref(provider), onCreated: vi.fn() });
  const host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(CreateIssueModal);
  app.provide(CREATE_ISSUE_KEY, form);
  app.provide("askConfirm", askConfirm);
  app.mount(host);
  await form.open();
  await flush();
  return { form, provider };
}

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel);
const createButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "createIssue.create");

describe("CreateIssueModal", () => {
  it("disables Create while the title is empty", async () => {
    const { form } = await mount();
    expect(createButton()?.disabled).toBe(true);
    form.title.value = "Bug";
    await nextTick();
    expect(createButton()?.disabled).toBe(false);
  });

  it("sanitises the Markdown preview", async () => {
    const { form } = await mount();
    form.body.value = '<img src=x onerror="alert(1)"> **hi**';
    const previewTab = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "createIssue.tabPreview",
    )!;
    previewTab.click();
    await nextTick();
    const html = $<HTMLElement>("[data-testid=ci-preview]")!.innerHTML;
    expect(html).toContain("<strong>hi</strong>");
    expect(html).not.toContain("onerror");
  });

  it("submits on ⌘Enter", async () => {
    const { form, provider } = await mount();
    form.title.value = "Bug";
    await nextTick();
    $<HTMLInputElement>("#ci-title")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await flush();
    expect(provider.createIssue).toHaveBeenCalledTimes(1);
  });

  it("renders the preview only on its tab, and caps the title at GitHub's limit", async () => {
    await mount();
    expect(document.querySelector("[data-testid=ci-preview]")).toBeNull();
    expect(document.querySelector<HTMLInputElement>("#ci-title")!.maxLength).toBe(256);
  });

  it("shows no target selector when there is one target", async () => {
    await mount();
    expect(document.querySelectorAll("input[name=ci-target]")).toHaveLength(0);
  });

  it("offers both targets on a fork and disables the one without issues", async () => {
    await mount({ targets: [ORIGIN, PARENT_OFF], defaultRepo: "me/app" });
    const radios = [...document.querySelectorAll<HTMLInputElement>("input[name=ci-target]")];
    expect(radios.map((r) => [r.value, r.disabled])).toEqual([["me/app", false], ["org/app", true]]);
    expect(document.body.textContent).toContain("createIssue.issuesOff");
  });

  it("asks before discarding typed text (in-app confirm), and closes a clean form directly", async () => {
    const ask = vi.fn(async () => false);
    const native = vi.spyOn(window, "confirm");
    const { form } = await mount(undefined, ask);
    const cancel = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "createIssue.cancel")!.click();
    form.title.value = "typed";
    await nextTick();
    cancel();
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
    expect(form.isOpen.value).toBe(true);
    form.title.value = "";
    await nextTick();
    cancel();
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(form.isOpen.value).toBe(false);
  });

  it("locks the target choice while the issue is being created", async () => {
    let finish!: (v: { number: number; url: string }) => void;
    const { form } = await mount(
      { targets: [ORIGIN, { ...PARENT_OFF, hasIssues: true }], defaultRepo: "me/app" },
      undefined,
      () => new Promise((r) => { finish = r; }),
    );
    form.title.value = "t";
    void form.submit();
    await nextTick();
    const radios = [...document.querySelectorAll<HTMLInputElement>("input[name=ci-target]")];
    expect(radios.every((r) => r.disabled)).toBe(true);
    finish({ number: 1, url: "u" });
  });

  it("keeps editing shortcuts (⌘Z, ⌘⇧I) inside the form away from the app", async () => {
    await mount();
    const appKeys = vi.fn();
    window.addEventListener("keydown", appKeys);
    const body = document.querySelector<HTMLTextAreaElement>(".ci-textarea")!;
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "I", metaKey: true, shiftKey: true, bubbles: true }));
    window.removeEventListener("keydown", appKeys);
    expect(appKeys).not.toHaveBeenCalled();
  });

  it("explains that issues are off and shows no form when no target has them", async () => {
    await mount({ targets: [{ ...ORIGIN, hasIssues: false }], defaultRepo: null });
    expect(document.body.textContent).toContain("createIssue.noTarget");
    expect($("#ci-title")).toBeNull();
    expect(createButton()).toBeUndefined();
  });
});
