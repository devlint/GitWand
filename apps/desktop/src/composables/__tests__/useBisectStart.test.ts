import { describe, it, expect, vi } from "vitest";
import type { GitLogEntry } from "../../utils/backend";
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
    expect(b.confirm.value).toEqual({ good: H("a"), bad: H("c") });
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
});
