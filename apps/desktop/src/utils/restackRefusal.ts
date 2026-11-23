/**
 * v3.14 — the arguments of a restack refusal's localized text
 * (`stacks.refusal.<code>`), taken from the refusal the backend (or the
 * restack flow) built (M-3): the branch, the worktree path and the code's
 * own detail (a commit count, a git version, a fetch error).
 */
import type { RestackRefusal } from "./backend";

export function restackRefusalArgs(r: RestackRefusal): string[] {
  const branch = r.branch ?? "";
  const detail = r.detail ?? "";
  switch (r.code) {
    case "occupied":
    case "occupied_rebasing":
      return [branch, r.path ?? ""];
    case "parent_behind":
      return [branch, detail];
    case "git_too_old":
    case "fetch_failed":
      return [detail];
    case "merged_work_missing":
      return [branch];
    default:
      return [];
  }
}
