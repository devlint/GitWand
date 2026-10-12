/**
 * useSafeHtml — centralized HTML sanitization + markdown rendering.
 *
 * GitWand runs inside a Tauri webview, which has access to native IPC
 * commands. An XSS in `v-html` here is therefore strictly worse than
 * in a regular browser tab: a malicious payload in a README, a PR body,
 * or a GitHub comment could trigger file writes, git commands, or shell
 * execution through the backend bridge.
 *
 * This composable is the single entry point for turning any text or
 * HTML-shaped content into something safe to feed to `v-html`.
 *
 * Two helpers are exported:
 *
 * - `safeHtml(raw)` — sanitize pre-built HTML (diff highlighting,
 *   syntax-coloured hunks). Use this when the HTML comes from our own
 *   code but may still be mixed with repo content (file names, line
 *   contents, etc.).
 *
 * - `renderMarkdown(src)` — parse markdown with our own renderer
 *   (`utils/markdown.ts`), then run the output through DOMPurify. Use
 *   this for READMEs, PR bodies, PR comments, markdown previews, etc.
 *
 * Both helpers use the same DOMPurify profile: a conservative whitelist
 * that matches the legacy renderer's surface (headings, lists, code,
 * tables, blockquotes, images, links), strips event handlers, and
 * blocks `javascript:` and `data:` URLs except for a small set of safe
 * image mime types.
 */

import DOMPurify from "dompurify";
import { openExternalUrl } from "../utils/backend";
import { markdownToHtml } from "../utils/markdown";
import { isSafeUrl, normalizeUrlText } from "../utils/urlSafety";
import { useSettings } from "./useSettings";
import { t } from "./useI18n";

/**
 * Per-call consent, set by `safeHtml(raw, { allowRemoteImages: true })` for the
 * duration of one synchronous sanitize (the "Show images" button of a PR, or a
 * README whose project the user allowed). Never left set between calls.
 */
let remoteImagesOverride = false;

/** Options shared by `safeHtml` and `renderMarkdown`. */
export interface SafeHtmlOptions {
  /**
   * Load remote images for this render even when the global setting is off —
   * the user accepted them for this PR or project.
   */
  allowRemoteImages?: boolean;
}

/**
 * True when `html` (a `safeHtml` / `renderMarkdown` result) withheld at least
 * one remote image — the cue to offer the "Show images" button.
 */
export function hasBlockedRemoteImages(html: string | null | undefined): boolean {
  return !!html && html.includes("md-img-blocked");
}

/**
 * Whether rendered markdown may load images from remote hosts. Off by
 * default (Settings → `allowRemoteImages`): an `<img>` in someone else's PR
 * body or comment is fetched straight from this machine — unlike on
 * github.com, there is no image proxy in between — so it works as a tracking
 * pixel that learns the reader's IP and when they opened the PR. Read through
 * the reactive settings so a `computed` that renders markdown re-runs when
 * the toggle changes.
 */
function remoteImagesAllowed(): boolean {
  if (remoteImagesOverride) return true;
  try {
    return useSettings().settings.value.allowRemoteImages === true;
  } catch {
    return false;
  }
}

// ─── DOMPurify profile ─────────────────────────────────────────────

/**
 * Whitelist covering the tags used by our legacy markdown renderer
 * (DashboardView / PrCreateView) plus the diff-highlighting output.
 * Anything outside this list is stripped.
 */
const ALLOWED_TAGS = [
  // Block
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "blockquote", "pre", "div", "section", "details", "summary",
  // Lists
  "ul", "ol", "li",
  // Inline
  "strong", "em", "code", "s", "del", "ins", "sub", "sup", "mark",
  "span", "a", "img",
  // Tables
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
];

const ALLOWED_ATTR = [
  "href", "src", "alt", "title",
  "class", "id",
  // Allow anchor targets on headings so our anchor-link behaviour keeps working.
  "target", "rel",
  // For diff / code rendering:
  "data-line", "data-lang",
  // For image / display attributes:
  "width", "height",
];

/**
 * Bases that stand in for the document while classifying an image URL. Both
 * are special schemes, as the webview's own is on Windows (http): there `\\host`
 * and `/\\host` are network paths. Two of them because `scheme:host/x` is
 * relative when `scheme` is the base's own — `https:tracker/x` against an
 * https document — and absolute otherwise: a URL is local only if it is local
 * against both, so its scheme cannot pick the base's.
 */
const LOCAL_IMAGE_BASES = [
  new URL("https://gitwand-local.invalid/"),
  new URL("ws://gitwand-local.invalid/"),
];

/**
 * True unless `src` resolves to the document itself — i.e. it is relative.
 * Decided by parsing, as the browser will: scheme-relative `//host`,
 * backslash forms, `scheme:host` shorthands, absolute URLs of any scheme, and
 * anything unparsable all count as remote.
 */
function isRemoteImageSrc(src: string): boolean {
  try {
    return LOCAL_IMAGE_BASES.some((base) => new URL(src, base).origin !== base.origin);
  } catch {
    return true;
  }
}

/**
 * Tighten `<a>` targets and `img`/`a` protocols with the same policy the
 * markdown renderer applies (`utils/urlSafety.ts`). DOMPurify already blocks
 * `javascript:` by default; this also covers `file:` and non-image `data:`.
 */
function hardenLinksAndImages(node: Element) {
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    if (href !== null && !isSafeUrl(href, "link")) node.removeAttribute("href");
    // Open external links in a new OS window; the webview doesn't have
    // target="_blank" semantics without `rel="noopener"`.
    if (node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";
    // Decide on what the browser will actually fetch, not on the raw text.
    const norm = normalizeUrlText(src);
    if (!isSafeUrl(norm, "image")) {
      node.removeAttribute("src");
    } else if (/^data:/i.test(norm)) {
      // Inline image: nothing is fetched, so the remote-image rule doesn't apply.
    } else if (src && isRemoteImageSrc(norm) && !remoteImagesAllowed()) {
      // Remote image, not allowed: keep a visible placeholder (alt text) and
      // the URL in a title so the reader knows what was withheld.
      node.removeAttribute("src");
      node.setAttribute("class", "md-img-blocked");
      if (!node.getAttribute("alt")) node.setAttribute("alt", t("common.remoteImageBlocked"));
      node.setAttribute("title", `${t("common.remoteImageBlocked")} — ${src.trim()}`);
    }
  }
}

// Attach the hardening hook once per module load. DOMPurify keeps hooks
// global, so we guard against duplicate registration.
let hooksInstalled = false;
function ensureHooks() {
  if (hooksInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    hardenLinksAndImages(node);
  });
  hooksInstalled = true;
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Note on URI schemes: we intentionally do NOT set `ALLOWED_URI_REGEXP`.
  // DOMPurify applies that regex to ALL URI-ish attributes (including
  // `target`), which silently strips `target="_blank"` on external links.
  // Dangerous protocols are instead handled by:
  //   - DOMPurify's default scheme whitelist (blocks `javascript:` etc.)
  //   - Our `hardenLinksAndImages` hook below, which explicitly drops
  //     `javascript:`/`vbscript:` URLs and non-image `data:` URLs.
  // We never want raw <script> or on* handlers, even if ALLOWED_TAGS
  // somehow grew to include them.
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "textarea", "select", "button"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "onsubmit"],
};

/**
 * Sanitize pre-built HTML (e.g. diff hunks already coloured by our own
 * syntax highlighter). Returns a string safe to feed to `v-html`.
 */
export function safeHtml(raw: string | null | undefined, options: SafeHtmlOptions = {}): string {
  if (!raw) return "";
  ensureHooks();
  remoteImagesOverride = options.allowRemoteImages === true;
  try {
    return DOMPurify.sanitize(raw, PURIFY_CONFIG) as string;
  } finally {
    remoteImagesOverride = false;
  }
}

// ─── Markdown ──────────────────────────────────────────────────────

/**
 * Parse markdown and sanitize the result. Safe to feed to `v-html`.
 *
 * `breaks` controls whether a single newline becomes a `<br>`. Default `true`
 * matches GitHub's comment/PR-body rendering (soft line breaks are honoured).
 * Pass `false` for README-style documents, where GitHub soft-wraps single
 * newlines as spaces and rendering them as `<br>` would mangle the layout.
 *
 * The renderer passes raw HTML from the source through untouched — DOMPurify
 * is what makes the result safe.
 */
export function renderMarkdown(
  src: string | null | undefined,
  options: { breaks?: boolean } & SafeHtmlOptions = {},
): string {
  if (!src) return "";
  const rawHtml = markdownToHtml(src, { breaks: options.breaks ?? true });
  return safeHtml(rawHtml, { allowRemoteImages: options.allowRemoteImages });
}

/**
 * Click handler for containers that render markdown via `v-html`. Anchors
 * inside rendered markdown would otherwise navigate the Tauri webview away from
 * the app — intercept clicks on http(s) links and hand them to the OS browser.
 *
 * Usage: `<div v-html="..." @click="onMarkdownLinkClick" />`.
 */
export function onMarkdownLinkClick(e: MouseEvent): void {
  const href = (e.target as HTMLElement | null)?.closest("a")?.getAttribute("href");
  if (href && /^https?:\/\//i.test(href)) {
    e.preventDefault();
    void openExternalUrl(href);
  }
}
