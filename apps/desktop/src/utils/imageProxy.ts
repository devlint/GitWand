/**
 * Remote images go through the backend (`gwimg:`, see
 * `src-tauri/src/commands/image_proxy.rs`), so the CSP's `img-src` does not
 * have to allow every `https:`/`http:` host: avatars from self-hosted forges,
 * README badges and the images of a PR the user accepted all come from hosts
 * nobody can list up front. Under dev:web, the dev server's
 * `/api/image-proxy` stands in for it.
 *
 * `proxyImageUrl` rewrites an absolute http(s) URL; anything else (`data:`,
 * `blob:`, a relative or app URL, an already proxied one) is returned as is.
 */
import { isTauri, DEV_SERVER } from "./backend-core";

type TauriInternals = { convertFileSrc?: (path: string, protocol?: string) => string };

/** `gwimg://localhost/` (`http://gwimg.localhost/` on Windows), as Tauri builds it. */
function schemeBase(): string {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  const viaTauri = internals?.convertFileSrc?.("", "gwimg");
  if (viaTauri) return viaTauri.endsWith("/") ? viaTauri : `${viaTauri}/`;
  const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return windows ? "http://gwimg.localhost/" : "gwimg://localhost/";
}

/** True for a URL this module already rewrote. */
function isProxied(url: string): boolean {
  return (
    url.startsWith("gwimg:") ||
    url.startsWith("http://gwimg.localhost/") ||
    url.startsWith(`${DEV_SERVER}/api/image-proxy?`)
  );
}

export function proxyImageUrl(url: string): string;
export function proxyImageUrl(url: string | null | undefined): string | null;
export function proxyImageUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null;
  const trimmed = url.trim();
  if (isProxied(trimmed) || !/^https?:\/\//i.test(trimmed)) return url;
  const encoded = encodeURIComponent(trimmed);
  return isTauri() ? `${schemeBase()}?u=${encoded}` : `${DEV_SERVER}/api/image-proxy?u=${encoded}`;
}

/**
 * The remote URL behind a URL `proxyImageUrl` rewrote, or `url` itself. Code
 * that reads an image's `src` back (the full-screen viewer, attachment
 * re-signing, a second sanitising pass) works on the original.
 */
export function originalImageUrl(url: string): string {
  const trimmed = url.trim();
  if (!isProxied(trimmed)) return url;
  try {
    const q = trimmed.slice(trimmed.indexOf("?") + 1);
    return new URLSearchParams(q).get("u") ?? url;
  } catch {
    return url;
  }
}
