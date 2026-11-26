// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createApp, nextTick, h, type App } from "vue";

vi.mock("../../utils/backend", () => ({
  gitBisectStatus: vi.fn(),
  gitBisectMark: vi.fn(),
  gitBisectReset: vi.fn(),
}));

import { gitBisectStatus, gitBisectMark, gitBisectReset, type BisectStatus } from "../../utils/backend";
import BisectBanner from "../BisectBanner.vue";

const H = (c: string) => c.repeat(40);

const status = (over: Partial<BisectStatus> = {}): BisectStatus => ({
  current: H("a"),
  start: "main",
  bad: H("b"),
  good: [H("1"), H("2")],
  skipped: [],
  remaining: 37,
  steps: 5,
  candidates: [],
  terms: ["bad", "good"],
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
        describeCommit: (hash: string) => (hash === H("a") ? "Fix parser edge case" : null),
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
    expect(text).toContain("37 commits left, about 5 steps");
    expect(text).toContain("2 good · 1 bad · 0 skipped");
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
    expect(host.textContent).toContain("18 commits left, about 4 steps");
  });

  it("shows a mark error inline", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status());
    vi.mocked(gitBisectMark).mockRejectedValue(new Error("Your local changes would be overwritten"));
    await mount();
    button("Skip")!.click();
    await flush();
    expect(host.textContent).toContain("Your local changes would be overwritten");
    expect(button("Skip")!.disabled).toBe(false);
  });

  it("names the first bad commit and opens it", async () => {
    vi.mocked(gitBisectStatus).mockResolvedValue(status({ candidates: [H("a")] }));
    const events = await mount();
    expect(host.textContent).toContain("First bad commit: aaaaaaa");
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
});
