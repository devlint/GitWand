// @vitest-environment jsdom
/**
 * Regression for the clone progress bar snapping back to 0% (adversarial
 * review of PR #178, Minor 1): the catch-all "info" progress stage (e.g. the
 * `remote: Total N...` summary line) reports `percent: 0`, and `clonePercent`
 * was assigned unclamped from every event, so the bar visibly jumped back to
 * 0% right before the clone finished. Mirrors the monotonic clamp already
 * used by `useGitRepo.ts`'s `fetchRemote` progress handler.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import CloneModal from "../CloneModal.vue";

type Progress = { stage: string; percent: number; message: string };

let progressCb: ((p: Progress) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;

vi.mock("../../utils/backend", () => ({
  gitClone: vi.fn((_url: string, _dest: string, onProgress: (p: Progress) => void) => {
    progressCb = onProgress;
    return new Promise<string>((_resolve, reject) => {
      pendingReject = reject;
    });
  }),
  pickFolder: vi.fn(async () => "/tmp/parent"),
}));

vi.mock("../../utils/networkGuard", () => ({
  requireOnline: vi.fn(async () => true),
}));

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

let app: App | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  if (container?.parentNode) container.parentNode.removeChild(container);
  app = null;
  container = null;
  progressCb = null;
  pendingReject = null;
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(CloneModal, { onClose: () => {}, onCloned: () => {} });
  app.mount(container);
}

function fillFormAndSubmit() {
  const urlInput = document.body.querySelector<HTMLInputElement>("#cm-url")!;
  urlInput.value = "https://github.com/org/repo.git";
  urlInput.dispatchEvent(new Event("input"));

  const parentInput = document.body.querySelector<HTMLInputElement>("#cm-parent")!;
  parentInput.value = "/tmp/parent";
  parentInput.dispatchEvent(new Event("input"));

  const form = document.body.querySelector("form.cm-form")!;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

function pctText(): string {
  return document.body.querySelector(".cm-progress-pct")?.textContent ?? "";
}

describe("CloneModal — progress bar percent", () => {
  it("never regresses when a later event reports a lower raw percent than a previous one", async () => {
    mount();
    fillFormAndSubmit();
    await nextTick();
    await nextTick();

    expect(progressCb).not.toBeNull();

    // Receiving objects at 80% (weighted onto the 25-90% "receiving" band) ...
    progressCb!({ stage: "receiving", percent: 80, message: "" });
    await nextTick();
    expect(pctText()).toBe("77%"); // 25 + 0.8*65 = 77

    // ... then the catch-all "info" stage fires with percent: 0. Without the
    // clamp, `clonePercent` would be overwritten to 0 and the unweighted
    // default branch would render "0%" here — a visible snap backwards.
    progressCb!({ stage: "info", percent: 0, message: "remote: Total 500" });
    await nextTick();

    const displayed = Number(pctText().replace("%", ""));
    expect(displayed).toBeGreaterThanOrEqual(77);
  });

  it("resets clonePercent to 0 when a new clone starts after a failed one", async () => {
    mount();
    fillFormAndSubmit();
    await nextTick();
    await nextTick();

    progressCb!({ stage: "receiving", percent: 80, message: "" });
    await nextTick();
    expect(pctText()).toBe("77%");

    // First attempt fails — isCloning flips back to false, unblocking the form.
    pendingReject!(new Error("network error"));
    await nextTick();
    await nextTick();

    // A fresh clone attempt must start the bar back at the "init" floor, not
    // continue from the previous attempt's high-water mark.
    fillFormAndSubmit();
    await nextTick();
    await nextTick();

    expect(pctText()).toBe("2%"); // "init" stage floor
  });
});
