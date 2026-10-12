/**
 * Single URL-scheme policy for rendered content, shared by the markdown
 * renderer (which refuses to turn an unsafe target into a link or image at
 * all) and the DOMPurify hook in `useSafeHtml` (which strips it from raw HTML).
 */

/**
 * What the WHATWG URL parser ignores before parsing an attribute value:
 * leading / trailing C0 controls and spaces, and ASCII tab / newline anywhere.
 * `h&#9;ttps://host/x` (the entity decodes to a tab) is therefore a plain
 * `https://host/x` to the browser, and must be one to us too.
 */
export function normalizeUrlText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}

/** Image types allowed as inline `data:` URLs. */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i;

/**
 * False for targets that can run script or reach the local disk:
 * `javascript:`, `vbscript:`, `file:`, and any `data:` URL except an inline
 * image (only allowed as an `<img>` source — never as a link target).
 */
export function isSafeUrl(url: string, kind: "link" | "image"): boolean {
  const s = normalizeUrlText(url);
  if (/^(javascript|vbscript|file):/i.test(s)) return false;
  if (/^data:/i.test(s)) return kind === "image" && SAFE_DATA_IMAGE.test(s);
  return true;
}
