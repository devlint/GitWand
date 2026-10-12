import { describe, it, expect } from "vitest";
import { nestReplies } from "../prCommentThreads";

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
