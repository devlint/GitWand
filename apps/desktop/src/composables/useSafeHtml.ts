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
 * - `renderMarkdown(src)` — parse markdown via `markdown-it`, then
 *   run the output through DOMPurify. Use this for READMEs, PR bodies,
 *   PR comments, markdown previews, etc.
 *
 * Both helpers use the same DOMPurify profile: a conservative whitelist
 * that matches the legacy renderer's surface (headings, lists, code,
 * tables, blockquotes, images, links), strips event handlers, and
 * blocks `javascript:` and `data:` URLs except for a small set of safe
 * image mime types.
 */

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { openExternalUrl } from "../utils/backend";
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

/**
 * Lowercase, strip non-word characters, collapse whitespace / dashes.
 * Matches the legacy DashboardView behaviour so existing in-page anchor
 * links (e.g. `#installation`) keep working after the renderer swap.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
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
 * What the WHATWG URL parser ignores before parsing an attribute value:
 * leading / trailing C0 controls and spaces, and ASCII tab / newline anywhere.
 * `h&#9;ttps://host/x` (the entity decodes to a tab) is therefore a plain
 * `https://host/x` to the browser, and must be one to us too.
 */
function normalizeUrlText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

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
 * Tighten `<a>` targets and `img`/`a` protocols. DOMPurify already blocks
 * `javascript:` by default, but we also explicitly forbid `data:` outside
 * of a short whitelist of image mime types to keep the attack surface small.
 */
function hardenLinksAndImages(node: Element) {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (/^\s*javascript:/i.test(href) || /^\s*vbscript:/i.test(href)) {
      node.removeAttribute("href");
    }
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
    if (/^javascript:/i.test(norm)) {
      node.removeAttribute("src");
    } else if (/^data:/i.test(norm)) {
      if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(norm)) {
        node.removeAttribute("src");
      }
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
 * `markdown-it` instance shared across the app. `html: true` allows raw
 * HTML tags (like `<img>` or `<details>`) inside markdown.
 * DOMPurify downstream takes care of sanitizing the raw HTML output.
 */
const md = new MarkdownIt({
  html: true, // let source markdown embed raw HTML (DOMPurify will sanitize)
  linkify: true,
  breaks: true,
  typographer: false,
});

// Tag our rendered output with the same CSS classes the legacy renderer
// used, so existing styles keep applying.
//
// IMPORTANT: we snapshot the *original* renderer functions before we
// override them. If we looked them up through `md.renderer.rules[name]`
// at call time, the override would point back at itself and recurse
// forever. The generic token renderer (`self.renderToken`) is used as
// the fallback for rules that are not registered by default.
const rules = md.renderer.rules;
const originalCodeBlock =
  rules.code_block ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const originalFence =
  rules.fence ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const originalCodeInline =
  rules.code_inline ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

rules.code_block = (tokens, idx, options, env, self) => {
  const rendered = originalCodeBlock(tokens, idx, options, env, self);
  return rendered.replace("<pre>", '<pre class="md-code-block">');
};
rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = (token.info || "").trim();
  const rendered = originalFence(tokens, idx, options, env, self);
  let html = rendered.replace("<pre>", '<pre class="md-code-block">');
  if (lang === "suggestion") {
    html = html.replace('class="md-code-block"', 'class="md-code-block md-suggestion-block"');
  }
  return html;
};
rules.code_inline = (tokens, idx, options, env, self) => {
  const rendered = originalCodeInline(tokens, idx, options, env, self);
  return rendered.replace("<code>", '<code class="md-inline-code">');
};
rules.table_open = () => '<table class="md-table">';
rules.blockquote_open = () => '<blockquote class="md-blockquote">';
rules.hr = () => '<hr class="md-hr">';

// Attach `id="slug-of-heading"` to every heading token. This lets the
// README pane act as a table of contents target (same behaviour as the
// legacy regex renderer in DashboardView), without pulling in the
// `markdown-it-anchor` plugin for such a small use case.
rules.heading_open = (tokens, idx, options, env, self) => {
  const open = tokens[idx];
  const inline = tokens[idx + 1];
  const text = inline?.children?.map((c) => c.content).join("") ?? "";
  const slug = slugifyHeading(text);
  if (slug && open.attrIndex("id") < 0) {
    open.attrPush(["id", slug]);
  }
  return self.renderToken(tokens, idx, options);
};

rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const existing = token.attrIndex("class");
  if (existing < 0) token.attrPush(["class", "md-link"]);
  return self.renderToken(tokens, idx, options);
};

/**
 * Parse markdown and sanitize the result. Safe to feed to `v-html`.
 *
 * `breaks` controls whether a single newline becomes a `<br>`. Default `true`
 * matches GitHub's comment/PR-body rendering (soft line breaks are honoured).
 * Pass `false` for README-style documents, where GitHub soft-wraps single
 * newlines as spaces and rendering them as `<br>` would mangle the layout.
 *
 * The single shared `md` instance is toggled per call. Rendering is synchronous
 * and JS is single-threaded, so there is no interleaving between the toggle and
 * the render.
 */
export function renderMarkdown(
  src: string | null | undefined,
  options: { breaks?: boolean } & SafeHtmlOptions = {},
): string {
  if (!src) return "";
  md.set({ breaks: options.breaks ?? true });
  const rawHtml = md.render(src);
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
