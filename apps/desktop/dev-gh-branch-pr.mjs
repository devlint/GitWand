// v3.14.0 — Dev-server mirror of the pure parts of `gh_branch_pr` and of the
// fork lookup in `src-tauri/src/commands/gh.rs`: `parse_gh_branch_pr_json`
// (with `parse_gh_branch_prs` and `newest_merged`) and `fork_parent_nwo`.
// Same rules and error strings. Kept in its own module so the unit test
// (`src/__tests__/ghBranchPr.devserver.test.ts`) imports it without starting
// the server.

/** `parse_gh_branch_pr_json`: of `gh pr list --json number,baseRefName,
 *  headRefOid,mergedAt,url,headRepositoryOwner,mergeCommit`, only the PRs whose head repo
 *  owner is `originOwner` (ASCII case-insensitive; an entry with no owner is
 *  dropped — `--head` carries no owner, so a fork's same-named branch would
 *  match). `merged` keeps the newest merged one and never falls back to an
 *  unmerged PR; `open` takes the first. null when there is none. */
export function devParseGhBranchPr(stdout, state, originOwner) {
  let v;
  try {
    v = JSON.parse(stdout.trim());
  } catch (e) {
    throw new Error(`Failed to parse gh pr list output: ${e.message}`);
  }
  if (!Array.isArray(v)) throw new Error("gh pr list did not return a list");
  const str = (x, k) => (typeof x?.[k] === "string" ? x[k] : "");
  const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const prs = v
    .filter((x) => Number.isSafeInteger(x?.number))
    .filter((x) => {
      const owner = str(x.headRepositoryOwner, "login");
      return owner !== "" && lower(owner) === lower(originOwner);
    })
    .map((x) => {
      const mergedAt = typeof x.mergedAt === "string" ? x.mergedAt : null;
      // Only once merged: an open PR's merge commit is a test merge.
      const oid = typeof x.mergeCommit?.oid === "string" && x.mergeCommit.oid !== "" ? x.mergeCommit.oid : null;
      return {
        number: x.number,
        base: str(x, "baseRefName"),
        head_ref_oid: str(x, "headRefOid"),
        merged_at: mergedAt,
        url: str(x, "url"),
        merge_commit_oid: mergedAt !== null ? oid : null,
      };
    });
  if (state !== "merged") return prs[0] ?? null;
  // `newest_merged`: RFC 3339 strings order like the instants; `max_by`
  // returns the last of equal maxima.
  let newest = null;
  for (const p of prs) {
    if (p.merged_at !== null && (newest === null || p.merged_at >= newest.merged_at)) newest = p;
  }
  return newest;
}

/** `fork_parent_nwo`: `owner/name` of the parent in a `gh repo view --json
 *  isFork,parent` answer when the repo is a fork, else null. */
export function devForkParentNwo(v) {
  if (v?.isFork !== true) return null;
  const owner = v.parent?.owner?.login;
  const name = v.parent?.name;
  if (typeof owner !== "string" || owner === "" || typeof name !== "string" || name === "") return null;
  return `${owner}/${name}`;
}
