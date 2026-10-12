const HTML_SPECIAL = /[&<>"]/;
const HTML_SPECIAL_G = /[&<>"]/g;
const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/**
 * Escape `& < > "` so `s` is safe as HTML text or inside a double-quoted
 * attribute. Strings with nothing to escape (most diff lines, terminal runs)
 * are returned as-is without allocating.
 */
export function escapeHtml(s: string): string {
  return HTML_SPECIAL.test(s) ? s.replace(HTML_SPECIAL_G, (c) => ENTITY[c]) : s;
}
