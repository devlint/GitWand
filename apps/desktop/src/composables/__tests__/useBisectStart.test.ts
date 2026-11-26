import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/backend", () => ({
  gitBisectStart: vi.fn(),
  gitBisectStatus: vi.fn(),
  gitRepoState: vi.fn(),
}));

import { gitBisectStart, gitBisectStatus, type GitLogEntry } from "../../utils/backend";
import { useBisectStart } from "../useBisectStart";

const entry = (hashFull: string, parents: string[], refs = ""): GitLogEntry =>
  ({ hash: hashFull.slice(0, 7), hashFull, parents, refs }) as unknown as GitLogEntry;

const H = (c: string) => c.repeat(40);

function setup(log: GitLogEntry[]) {
  const notify = vi.fn();
  const b = useBisectStart({ cwd: () => "/repo", log: () => log, notify, onStarted: async () => {} });
  return { b, notify };
}

describe("useBisectStart", () => {
  const log = [
    entry(H("c"), [H("b")], "HEAD -> main"),
    entry(H("b"), [H("a")]),
    entry(H("a"), []),
    entry(H("s"), [H("a")], "side"),
  ];

  it("asks to bisect from an ancestor of HEAD to HEAD", () => {
    const { b, notify } = setup(log);
    b.askFromHere(log[2]);
    expect(notify).not.toHaveBeenCalled();
    expect(b.confirm.value).toEqual({ good: H("a"), bad: H("c"), ordered: true, keepOrder: true });
    b.cancel();
    expect(b.confirm.value).toBeNull();
  });

  it("explains, without asking, a commit that is not in HEAD's history", () => {
    const { b, notify } = setup(log);
    b.askFromHere(log[3]);
    expect(notify).toHaveBeenCalledOnce();
    expect(b.confirm.value).toBeNull();
  });

  it("explains a log without HEAD", () => {
    const { b, notify } = setup(log.slice(1));
    b.askFromHere(log[2]);
    expect(notify).toHaveBeenCalledOnce();
    expect(b.confirm.value).toBeNull();
  });
  it("orders two ends by ancestry, whatever the row order", () => {
    const { b } = setup(log);
    b.ask(H("c"), H("a"));
    expect(b.confirm.value).toEqual({ good: H("a"), bad: H("c"), ordered: true });
  });

  it("refuses two ends on separate branches before asking", () => {
    const { b, notify } = setup(log);
    b.ask(H("s"), H("c"));
    expect(notify).toHaveBeenCalledOnce();
    expect(b.confirm.value).toBeNull();
  });

  it("leaves the ends unnamed when the loaded log cannot order them", () => {
    const partial = [entry(H("c"), [H("b")], "HEAD -> main"), entry(H("b"), [H("z")]), entry(H("y"), [H("x")])];
    const { b, notify } = setup(partial);
    b.ask(H("y"), H("c"));
    expect(notify).not.toHaveBeenCalled();
    expect(b.confirm.value).toEqual({ good: H("y"), bad: H("c"), ordered: false });
  });
  it("keeps the clicked commit as the good end when the loaded log cannot tell", () => {
    // HEAD (b) is older than the clicked commit (n), which descends from it;
    // the log is cut before any root, so it cannot rule n out.
    const cut = [entry(H("n"), [H("b")]), entry(H("b"), [H("z")], "HEAD -> old")];
    const { b, notify } = setup(cut);
    b.askFromHere(cut[0]);
    expect(notify).not.toHaveBeenCalled();
    expect(b.confirm.value).toEqual({ good: H("n"), bad: H("b"), ordered: true, keepOrder: true });
  });
  it("hands over to the banner when git started the bisect but the read after it failed", async () => {
    vi.mocked(gitBisectStart).mockRejectedValue(new Error("rev-list failed"));
    vi.mocked(gitBisectStatus).mockResolvedValue({ active: true } as never);
    const notify = vi.fn();
    const onStarted = vi.fn(async () => {});
    const b = useBisectStart({ cwd: () => "/repo", log: () => log, notify, onStarted });
    b.ask(H("a"), H("c"));
    await b.start();
    expect(b.confirm.value).toBeNull();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a start that git refused", async () => {
    vi.mocked(gitBisectStart).mockRejectedValue(new Error("bisect:dirty: Commit or stash"));
    vi.mocked(gitBisectStatus).mockResolvedValue({ active: false } as never);
    const notify = vi.fn();
    const b = useBisectStart({ cwd: () => "/repo", log: () => log, notify, onStarted: async () => {} });
    b.ask(H("a"), H("c"));
    await b.start();
    expect(b.confirm.value).not.toBeNull();
    expect(notify).toHaveBeenCalledOnce();
  });
});
