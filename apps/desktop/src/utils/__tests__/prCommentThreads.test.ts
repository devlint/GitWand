import { describe, it, expect } from "vitest";
import { nestReplies, withThreadState } from "../prCommentThreads";

function c(id: number, inReplyTo: number | null = null, path = "src/a.ts") {
  return { id, path, in_reply_to_id: inReplyTo };
}

const shape = (list: ReturnType<typeof nestReplies<ReturnType<typeof c>>>) =>
  list.map((e) => [e.id, e.replies.map((r) => r.id)]);

describe("nestReplies", () => {
  it("nests a reply under the review comment it answers", () => {
    expect(shape(nestReplies([c(1), c(2), c(3, 1)]))).toEqual([[1, [3]], [2, []]]);
  });

  it("resolves a reply-to-a-reply chain to the thread root", () => {
    expect(shape(nestReplies([c(1), c(2, 1), c(3, 2)]))).toEqual([[1, [2, 3]]]);
  });

  it("keeps a reply whose root is missing at top level", () => {
    expect(shape(nestReplies([c(5, 99), c(6)]))).toEqual([[5, []], [6, []]]);
  });

  it("never nests issue comments, even on an id collision", () => {
    // Issue comment 1 shares its id with nothing nestable; issue comments have no path.
    const issue = c(1, null, "");
    const reply = c(2, 1);
    expect(shape(nestReplies([issue, reply]))).toEqual([[1, []], [2, []]]);
  });

  it("keeps input order for roots and replies", () => {
    expect(shape(nestReplies([c(1), c(2), c(3, 2), c(4, 1), c(5, 2)]))).toEqual([
      [1, [4]],
      [2, [3, 5]],
    ]);
  });
});

describe("withThreadState", () => {
  const thread = { thread_id: "T1", root_comment_id: 1, resolved: true };

  it("stamps the root and its replies with the thread id and state", () => {
    const out = withThreadState([c(1), c(2, 1), c(3, 2), c(4)], [thread]);
    expect(out.map((x) => [x.id, (x as any).thread_id, (x as any).resolved])).toEqual([
      [1, "T1", true],
      [2, "T1", true],
      [3, "T1", true],
      [4, undefined, undefined],
    ]);
  });

  it("returns the comments untouched when no thread is known", () => {
    const list = [c(1)];
    expect(withThreadState(list, [])).toBe(list);
  });
});
