/**
 * Whether `child` is `root` or inside it, compared by path component: `/a/wt2`
 * is not under `/a/wt`. Both `/` and `\` separate components. No resolution
 * of `..` or symlinks: pass paths the backend already canonicalized.
 */
export function isUnderPath(child: string, root: string): boolean {
  const trim = (p: string) => p.replace(/[\\/]+$/, "");
  const c = trim(child);
  const r = trim(root);
  if (c === r) return true;
  return c.startsWith(r) && (c[r.length] === "/" || c[r.length] === "\\");
}
