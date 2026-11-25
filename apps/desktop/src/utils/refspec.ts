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
    if (full !== null && full.startsWith("refs/heads/") && full.length > "refs/heads/".length) {
      return full.slice("refs/heads/".length);
    }
  }
  return null;
}
