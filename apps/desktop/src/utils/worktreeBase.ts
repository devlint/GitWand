/**
 * v3.13 — The line the creation dialogs show under the name (spec §5.2):
 * which base a new worktree starts from, and why ("based on origin/main
 * fetched 2 s ago", "offline: based on origin/main").
 */
import type { LocaleKey } from "../locales";
import type { BaseResolution } from "./backend";

export interface BaseLine {
  key: LocaleKey;
  args: Array<string | number>;
}

export function describeBase(base: BaseResolution, nowMs: number = Date.now()): BaseLine {
  const ref = base.base_ref;
  switch (base.fallback_reason) {
    case "fetch-failed":
      return { key: "worktree.baseOffline", args: [ref] };
    case "no-remote":
      return { key: "worktree.baseNoRemote", args: [ref] };
    case "no-default-branch":
      return { key: "worktree.baseNoDefault", args: [ref] };
  }
  if (base.fetched_at !== null) {
    const ago = Math.max(0, Math.round(nowMs / 1000 - base.fetched_at));
    return { key: "worktree.baseFetched", args: [ref, ago] };
  }
  return { key: "worktree.baseExplicit", args: [ref] };
}

/**
 * The worktree name the backend derives (`slug::slugify`):
 * `[a-z0-9][a-z0-9-]{0,62}`, or null. Used for previews only.
 */
export function slugifyWorktreeName(name: string): string | null {
  let slug = "";
  for (const ch of name) {
    if (/^[A-Za-z0-9]$/.test(ch)) slug += ch.toLowerCase();
    else if (slug && !slug.endsWith("-")) slug += "-";
  }
  slug = slug.slice(0, 63).replace(/-+$/, "");
  return slug || null;
}
