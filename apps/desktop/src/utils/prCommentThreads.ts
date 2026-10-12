/**
 * Groups inline review-comment replies under the comment that opened their
 * thread, so the conversation timeline can show a reply as a sub-message of
 * the review comment it answers instead of as an unrelated top-level entry.
 */

interface ThreadableComment {
  id: number;
  /** Inline review comments carry a path; issue-level comments don't. */
  path: string;
  in_reply_to_id: number | null;
}

export type CommentWithReplies<T> = T & { replies: T[] };

/**
 * Nest every reply under its thread root, keeping input order for both the
 * roots and each root's replies (pass the comments oldest-first).
 *
 * Only inline review comments (non-empty `path`) take part: issue comment ids
 * live in a separate namespace on GitHub and could collide with a review
 * comment id. A reply is resolved up its `in_reply_to_id` chain to the root —
 * GitHub always points at the root, other forges may point at the previous
 * reply. A reply whose root is missing (deleted, not fetched) stays top-level.
 */
export function nestReplies<T extends ThreadableComment>(comments: T[]): CommentWithReplies<T>[] {
  const reviewById = new Map<number, T>();
  for (const c of comments) if (c.path) reviewById.set(c.id, c);

  function rootOf(c: T): T | null {
    const seen = new Set<number>([c.id]);
    let cur = c;
    while (cur.in_reply_to_id != null) {
      const parent = reviewById.get(cur.in_reply_to_id);
      if (!parent || seen.has(parent.id)) return cur === c ? null : cur;
      seen.add(parent.id);
      cur = parent;
    }
    return cur === c ? null : cur;
  }

  const out: CommentWithReplies<T>[] = [];
  const byRootId = new Map<number, CommentWithReplies<T>>();
  const pending: Array<[number, T]> = [];
  for (const c of comments) {
    const root = c.path && c.in_reply_to_id != null ? rootOf(c) : null;
    if (root) {
      pending.push([root.id, c]);
      continue;
    }
    const entry = { ...c, replies: [] as T[] };
    out.push(entry);
    if (c.path) byRootId.set(c.id, entry);
  }
  for (const [rootId, reply] of pending) {
    const root = byRootId.get(rootId);
    if (root) root.replies.push(reply);
    else out.push({ ...reply, replies: [] });
  }
  return out;
}
