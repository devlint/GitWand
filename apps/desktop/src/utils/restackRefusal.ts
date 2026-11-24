/**
 * v3.14 — the arguments of a restack refusal's localized text
 * (`stacks.refusal.<code>`), taken from the refusal the backend (or the
 * restack flow) built (M-3): the branch, the worktree path and the code's
 * own detail (a commit count, a git version, a fetch error).
 */
import type { LocaleKey } from "../locales";
import type { RestackPlan, RestackRefusal } from "./backend";

/**
 * The locale key and arguments of a refusal (wave 4, M2): a moment-2
 * `merged_work_missing` onto the remote trunk (`new_parent` null) gets its
 * own text — the fetch just ran, so the work was most likely merged
 * elsewhere — naming the merged parent and the target.
 */
export function restackRefusalText(
  r: RestackRefusal,
  plan: RestackPlan | null,
): { key: LocaleKey; args: string[] } {
  if (r.code === "merged_work_missing" && plan?.moment === "parent_merged" && plan.new_parent === null) {
    return { key: "stacks.refusal.merged_work_missing_trunk", args: [plan.parent, r.branch ?? plan.onto_ref] };
  }
  return { key: `stacks.refusal.${r.code}`, args: restackRefusalArgs(r) };
}

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
