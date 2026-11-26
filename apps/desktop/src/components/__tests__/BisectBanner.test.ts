// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createApp, nextTick, h, ref, type App } from "vue";

vi.mock("../../utils/backend", () => ({
  gitBisectStatus: vi.fn(),
  gitBisectMark: vi.fn(),
  gitBisectReset: vi.fn(),
}));

import { gitBisectStatus, gitBisectMark, gitBisectReset, type BisectStatus } from "../../utils/backend";
import BisectBanner from "../BisectBanner.vue";

const H = (c: string) => c.repeat(40);

const status = (over: Partial<BisectStatus> = {}): BisectStatus => ({
  active: true,
  current: H("a"),
  start: "main",
  bad: H("b"),
  good: [H("1"), H("2")],
  skipped: [],
  remaining: 37,
  steps: 5,
  candidates: [],
  terms: ["bad", "good"],
  commits: [{ hash: H("a"), subject: "Fix parser edge case", author: "Jane", date: "2026-11-20T10:00:00Z" }],
  pendingCheckout: false,
  ...over,
});

let app: App | null = null;
let host: HTMLElement;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mount(props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const events: { changed: number; open: string[] } = { changed: 0, open: [] };
  app = createApp({
    render: () =>
      h(BisectBanner, {
        cwd: "/repo",
        refreshKey: 0,
        hasTrackedChanges: false,
        onChanged: () => events.changed++,
        onOpenCommit: (hash: string) => events.open.push(hash),
        ...props,
      }),
  });
  app.mount(host);
  await flush();
  return events;
}

const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  vi.mocked(gitBisectStatus).mockReset();
  vi.mocked(gitBisectMark).mockReset();
  vi.mocked(gitBisectReset).mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

describe("BisectBanner", () => {
  it("shows the commit under test, counts and estimate", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("aaaaaaa");
    expect(text).toContain("Fix parser edge case");
    expect(text).toContain("To test: 37 · steps left: ~5");
    expect(text).toContain("Good: 2 · Bad: 1 · Skipped: 0");
  });

  it("asks for both ends", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(
      status({ bad: null, good: [], remaining: null, steps: null }),
    );
    await mount();
    expect(host.textContent).toContain("Mark a bad and a good commit to start narrowing down");
    expect(button("Good")?.disabled).toBe(false);
    expect(button("Bad")?.disabled).toBe(false);
  });

  it("marks and emits changed", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    let resolve!: (s: BisectStatus) => void;
    vi.mocked(gitBisectMark).mockReturnValue(new Promise((r) => (resolve = r)));
    const events = await mount();
    button("Bad")!.click();
    await flush();
    expect(gitBisectMark).toHaveBeenCalledWith("/repo", "bad");
    expect(button("Good")!.disabled).toBe(true);
    resolve(status({ remaining: 18, steps: 4 }));
    await flush();
    expect(events.changed).toBe(1);
    expect(button("Good")!.disabled).toBe(false);
    expect(host.textContent).toContain("To test: 18 · steps left: ~4");
  });

  it("shows a mark error inline, reloads and tells the parent", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    vi.mocked(gitBisectMark).mockRejectedValue(new Error("Your local changes would be overwritten"));
    const events = await mount();
    button("Skip")!.click();
    await flush();
    expect(host.textContent).toContain("Your local changes would be overwritten");
    expect(button("Skip")!.disabled).toBe(false);
    expect(gitBisectStatus).toHaveBeenCalledTimes(2);
    expect(events.changed).toBe(1);
  });

  it("offers Continue when git recorded the mark but could not move on", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status({ pendingCheckout: true }));
    vi.mocked(gitBisectMark).mockResolvedValue(status());
    const events = await mount();
    expect(host.textContent).toContain("Marked. git could not check out the next commit");
    expect(button("Good")).toBeUndefined();
    button("Continue")!.click();
    await flush();
    expect(gitBisectMark).toHaveBeenCalledWith("/repo", "next");
    expect(events.changed).toBe(1);
  });

  it("clears an old error once a reload succeeds", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValueOnce(status());
    vi.mocked(gitBisectMark).mockRejectedValue(new Error("boom"));
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    host = document.createElement("div");
    document.body.appendChild(host);
    const { ref } = await import("vue");
    const key = ref(0);
    app = createApp({
      render: () => h(BisectBanner, { cwd: "/repo", refreshKey: key.value, hasTrackedChanges: false }),
    });
    app.mount(host);
    await flush();
    button("Bad")!.click();
    await flush();
    expect(host.textContent).toContain("boom");
    key.value++;
    await flush();
    expect(host.textContent).not.toContain("boom");
  });

  it("names a bisect's own terms on the buttons", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status({ terms: ["broken", "fixed"] }));
    await mount();
    expect(button("Good (fixed)")).toBeDefined();
    expect(button("Bad (broken)")).toBeDefined();
  });

  it("names the first bad commit and opens it", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status({ candidates: [H("a")] }));
    const events = await mount();
    expect(host.textContent).toContain("First bad commit: aaaaaaa");
    expect(host.textContent).toContain("Fix parser edge case");
    expect(host.textContent).toContain("Jane");
    expect(button("Good")).toBeUndefined();
    button("Open commit")!.click();
    expect(events.open).toEqual([H("a")]);
  });

  it("lists the candidates left by skips", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(
      status({ candidates: [H("c"), H("d"), H("e")] }),
    );
    const events = await mount();
    expect(host.textContent).toContain("The first bad commit is one of these 3:");
    const link = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("ddddddd"),
    )!;
    link.click();
    expect(events.open).toEqual([H("d")]);
  });

  it("ends the bisect", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    vi.mocked(gitBisectReset).mockResolvedValue();
    const events = await mount();
    const end = button("End bisect")!;
    expect(end.title).toBe("Ends the bisect and checks out main again");
    end.click();
    await flush();
    expect(gitBisectReset).toHaveBeenCalledWith("/repo");
    expect(events.changed).toBe(1);
  });

  it("notes that uncommitted changes follow", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    await mount({ hasTrackedChanges: true });
    expect(host.textContent).toContain("Your uncommitted changes will follow you to the next commit.");
  });

  it("reloads when the refresh key changes", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    host = document.createElement("div");
    document.body.appendChild(host);
    const { ref } = await import("vue");
    const key = ref(0);
    app = createApp({
      render: () =>
        h(BisectBanner, { cwd: "/repo", refreshKey: key.value, hasTrackedChanges: false }),
    });
    app.mount(host);
    await flush();
    expect(gitBisectStatus).toHaveBeenCalledTimes(1);
    key.value++;
    await flush();
    expect(gitBisectStatus).toHaveBeenCalledTimes(2);
  });
  it("shows a failed first read with End bisect as a way out", async () => {
    vi.mocked(gitBisectStatus).mockRejectedValue(new Error("bad object refs/bisect/bad"));
    vi.mocked(gitBisectReset).mockResolvedValue(undefined);
    const events = await mount();
    expect(host.querySelector(".bisect-error")?.textContent).toContain("bad object");
    expect(button("Good")).toBeUndefined();
    const end = button("End bisect");
    expect(end).toBeDefined();
    end!.click();
    await flush();
    expect(gitBisectReset).toHaveBeenCalledWith("/repo");
    expect(events.changed).toBe(1);
  });
  it("hides itself when the bisect has ended before the repo state caught up", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status({ active: false, current: null, bad: null, good: [] }));
    await mount();
    expect(host.querySelector(".bisect-banner")).toBeNull();
  });

  it("shows GitWand's refusals in the user's language", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    vi.mocked(gitBisectMark).mockRejectedValue(new Error("bisect:notBisecting: No bisect is in progress."));
    await mount();
    button("Good")!.click();
    await flush();
    expect(host.querySelector(".bisect-error")?.textContent).toBe("No bisect is in progress.");
  });
  it("ignores an action's result once another repo is open", async () => {
    const cwd = ref("/a");
    vi.mocked(gitBisectStatus).mockImplementation(async (c: string) =>
      status(c === "/a" ? {} : { current: H("c"), commits: [] }),
    );
    let finish!: (s: BisectStatus) => void;
    vi.mocked(gitBisectMark).mockReturnValue(new Promise((r) => (finish = r)));
    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp({
      render: () => h(BisectBanner, { cwd: cwd.value, refreshKey: 0, hasTrackedChanges: false }),
    });
    app.mount(host);
    await flush();
    button("Good")!.click();
    cwd.value = "/b";
    await flush();
    finish(status({ current: H("d"), candidates: [H("d")] }));
    await flush();
    expect(host.textContent).toContain(H("c").slice(0, 7));
    expect(host.textContent).not.toContain(H("d").slice(0, 7));
  });
});
