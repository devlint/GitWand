/**
 * The remote branch whose remote-tracking ref is `tracking`, read back
 * through the remote's fetch refspecs (`git config --get-all
 * remote.<r>.fetch`, one per line): the default
 * `+refs/heads/*:refs/remotes/origin/*`, a single-branch clone's
 * `+refs/heads/main:refs/remotes/origin/main`, or a custom
 * `refs/heads/*:refs/remotes/origin/heads/*`. `null` when no refspec maps a
 * branch onto `tracking`. Mirrors `remote_branch_of` in
 * src-tauri/src/commands/ops.rs (and `devRemoteBranchOf` in dev-server.mjs).
 */
/** A negative refspec (`^refs/heads/wip`, `^refs/heads/tmp-*`) excludes `full`. */
function excluded(refspecs: string, full: string): boolean {
  return refspecs.split("\n").some((l) => {
    const t = l.trim();
    if (!t.startsWith("^")) return false;
    const neg = t.slice(1);
    const star = neg.indexOf("*");
    if (star < 0) return neg === full;
    const pre = neg.slice(0, star);
    const suf = neg.slice(star + 1);
    return full.length >= pre.length + suf.length && full.startsWith(pre) && full.endsWith(suf);
  });
}

export function remoteBranchOf(refspecs: string, tracking: string): string | null {
  for (const line of refspecs.split("\n")) {
    const spec = line.trim().replace(/^\+/, "");
    if (spec === "" || spec.startsWith("^")) continue; // a negative refspec maps nothing
    const colon = spec.indexOf(":");
    if (colon < 0) continue;
    const src = spec.slice(0, colon);
    const dst = spec.slice(colon + 1);
    const srcStar = src.indexOf("*");
    const dstStar = dst.indexOf("*");
    let full: string | null = null;
    if (srcStar >= 0 && dstStar >= 0) {
      const dstPre = dst.slice(0, dstStar);
      const dstSuf = dst.slice(dstStar + 1);
      if (tracking.length >= dstPre.length + dstSuf.length && tracking.startsWith(dstPre) && tracking.endsWith(dstSuf)) {
        const mid = tracking.slice(dstPre.length, tracking.length - dstSuf.length);
        full = src.slice(0, srcStar) + mid + src.slice(srcStar + 1);
      }
    } else if (srcStar < 0 && dstStar < 0 && dst === tracking) {
      full = src;
    }
    if (full !== null) {
      // Excluded by a negative refspec: git never fetches it, the tracking
      // ref by that name is stale.
      if (excluded(refspecs, full)) return null;
      if (full.startsWith("refs/heads/") && full.length > "refs/heads/".length) return full.slice("refs/heads/".length);
      return null;
    }
  }
  return null;
}

/**
 * The forward mapping: the remote-tracking ref that `refs/heads/<branch>` on
 * the remote is fetched into, through the same refspecs. `null` when none
 * fetches it.
 */
export function trackingRefOf(refspecs: string, branch: string): string | null {
  const src = `refs/heads/${branch}`;
  if (excluded(refspecs, src)) return null;
  for (const line of refspecs.split("\n")) {
    const spec = line.trim().replace(/^\+/, "");
    if (spec === "" || spec.startsWith("^")) continue;
    const colon = spec.indexOf(":");
    if (colon < 0) continue;
    const from = spec.slice(0, colon);
    const to = spec.slice(colon + 1);
    const fromStar = from.indexOf("*");
    const toStar = to.indexOf("*");
    if (fromStar >= 0 && toStar >= 0) {
      const pre = from.slice(0, fromStar);
      const suf = from.slice(fromStar + 1);
      if (src.length >= pre.length + suf.length && src.startsWith(pre) && src.endsWith(suf)) {
        return to.slice(0, toStar) + src.slice(pre.length, src.length - suf.length) + to.slice(toStar + 1);
      }
    } else if (fromStar < 0 && toStar < 0 && from === src && to !== "") {
      return to;
    }
  }
  return null;
}
