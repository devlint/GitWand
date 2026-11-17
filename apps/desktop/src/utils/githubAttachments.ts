/**
 * Files uploaded through GitHub's editor — screenshots in a PR description or
 * comment (#302).
 *
 * The markdown names them `https://github.com/user-attachments/assets/<uuid>`
 * (older uploads: `user-images.githubusercontent.com/<user>/<id>-<uuid>.png`).
 * On a public repository that URL redirects to the file; on a private one it
 * answers 404 to anything but a signed-in github.com session, so the webview
 * cannot load it. The API hands out signed, short-lived equivalents
 * (`private-user-images.githubusercontent.com/<user>/<id>-<uuid>.png?jwt=…`)
 * in `body_html`: both forms carry the same UUID, which is how one is matched
 * to the other.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Every attachment URL in a markdown body, for `attachmentKeysIn`. */
const ATTACHMENT_URL_RE =
  /https:\/\/(?:github\.com\/user-attachments\/assets\/|(?:private-)?user-images\.githubusercontent\.com\/)[^\s"'<>)]+/gi;

/**
 * True when `src` is a file uploaded to GitHub, served by GitHub itself.
 * Loading one tells nobody but GitHub — which already serves the PR being read
 * — that it was opened, so it is not a tracking pixel the way an image on a
 * third-party host is.
 */
export function isGithubAttachmentUrl(src: string): boolean {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === "github.com") return u.pathname.startsWith("/user-attachments/assets/");
  return host === "user-images.githubusercontent.com" || host === "private-user-images.githubusercontent.com";
}

/** The UUID naming the attachment at `src` (lower-case), or null when it is not one. */
export function attachmentKey(src: string): string | null {
  if (!isGithubAttachmentUrl(src)) return null;
  const m = new URL(src).pathname.match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

/** The attachment keys referenced by a markdown body, deduplicated. */
export function attachmentKeysIn(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const keys = new Set<string>();
  for (const m of markdown.matchAll(ATTACHMENT_URL_RE)) {
    const k = attachmentKey(m[0]);
    if (k) keys.add(k);
  }
  return [...keys];
}

/** A signed URL and when it stops working (ms since epoch). */
export interface SignedAttachment {
  url: string;
  expiresAt: number;
}

/** Signed URLs are valid for five minutes; assumed when the token can't be read. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** `exp` of the `jwt` query parameter, in ms — null when it can't be read. */
function jwtExpiry(url: URL): number | null {
  const jwt = url.searchParams.get("jwt");
  const payload = jwt?.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Index the signed URLs returned by `ghPrAttachmentUrls` by attachment key. */
export function indexSignedAttachments(
  urls: readonly string[],
  now: number = Date.now(),
): Map<string, SignedAttachment> {
  const out = new Map<string, SignedAttachment>();
  for (const url of urls) {
    const key = attachmentKey(url);
    if (!key) continue;
    out.set(key, { url, expiresAt: jwtExpiry(new URL(url)) ?? now + DEFAULT_TTL_MS });
  }
  return out;
}
