/**
 * markdown — small, dependency-free GitHub-flavoured markdown → HTML renderer.
 *
 * Replaces `markdown-it`. It covers the surface GitWand actually renders
 * (READMEs, PR bodies, review comments): ATX / setext headings, paragraphs,
 * emphasis / strong / `~~strike~~`, inline + fenced + indented code,
 * blockquotes, nested ordered / unordered lists (tight and loose), task
 * lists, GFM tables, horizontal rules, inline + reference + auto links,
 * bare-URL and email linkify (GFM autolinks — no fuzzy bare domains), images, raw HTML blocks and inline tags, backslash
 * escapes and entities.
 *
 * The output is NOT safe on its own: raw HTML from the source is passed
 * through untouched. Always feed it to `safeHtml` (DOMPurify) — callers
 * should use `renderMarkdown` from `composables/useSafeHtml.ts`, never this
 * module directly.
 *
 * Elements carry the `md-*` classes the app's stylesheets target
 * (`md-code-block`, `md-inline-code`, `md-link`, `md-table`, `md-blockquote`,
 * `md-hr`, `md-check` / `md-checked` / `md-check-box`), and headings get a slug `id` so
 * in-page `#anchor` links resolve.
 */

import { escapeHtml as esc } from "./escapeHtml";
import { isSafeUrl } from "./urlSafety";

export interface MarkdownOptions {
  /** Render a single newline inside a paragraph as `<br>` (GitHub comments). */
  breaks?: boolean;
}

interface LinkRef {
  href: string;
  title?: string;
}

interface Ctx {
  refs: Map<string, LinkRef>;
  breaks: boolean;
  /** Current blockquote / list nesting level. */
  depth: number;
}

/**
 * Deepest blockquote / list nesting rendered as structure; anything deeper
 * becomes plain text. Bounds recursion (a long `> > > …` line would
 * otherwise overflow the stack) and the per-level line copying.
 */
const MAX_NESTING = 50;

/** Render markdown to (unsanitized) HTML. */
export function markdownToHtml(src: string, options: MarkdownOptions = {}): string {
  const text = src.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
  const ctx: Ctx = { refs: new Map(), breaks: options.breaks ?? true, depth: 0 };
  const lines = collectRefs(text.split("\n").map(expandTabs), ctx.refs);
  return renderBlocks(lines, ctx, false);
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Strip tags and decode the entities `esc` produces — for alt text and slugs. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Lowercase, strip non-word characters, collapse whitespace / dashes. Kept
 * identical to the previous renderer so existing `#anchor` links still land.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Expand tabs in leading whitespace to 4-column stops. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  return line.replace(/^[ \t]+/, (ws) => {
    let col = 0;
    for (const c of ws) col = c === "\t" ? col + 4 - (col % 4) : col + 1;
    return " ".repeat(col);
  });
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Remove up to `n` leading spaces. */
function stripIndent(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === " ") i++;
  return line.slice(i);
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Percent-encode what a browser would, leaving existing `%XX` escapes alone. */
function normalizeUrl(url: string): string {
  try {
    return url.replace(/%(?![0-9a-f]{2})|[^\w\-.~:/?#[\]@!$&'()*+,;=%]/giu, (c) => encodeURIComponent(c));
  } catch {
    return url;
  }
}

/**
 * Named entities decoded in link destinations / titles. Not the full HTML5
 * table (2k+ names, and this module has no DOM to borrow one from): the
 * markup escapes plus ASCII punctuation, which is what HTML-escaped URLs
 * actually carry. Any other name is kept verbatim, as text.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"',
  apos: "'", nbsp: "\u00a0", excl: "!", num: "#", dollar: "$", percnt: "%",
  lpar: "(", rpar: ")", ast: "*", plus: "+", comma: ",", period: ".", sol: "/",
  colon: ":", semi: ";", equals: "=", quest: "?", commat: "@", lsqb: "[",
  rsqb: "]", bsol: "\\", lowbar: "_", grave: "`", lcub: "{", rcub: "}", verbar: "|",
};

function decodeEntity(ent: string): string {
  if (ent[1] !== "#") return NAMED_ENTITIES[ent.slice(1, -1)] ?? ent;
  const hex = ent[2] === "x" || ent[2] === "X";
  const cp = parseInt(ent.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  // CommonMark: NUL, surrogates and out-of-range code points become U+FFFD.
  return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCodePoint(cp);
}

/**
 * Backslash escapes and entity references, in one pass so `\\&amp;` stays a
 * literal `&amp;`. For link destinations, titles and fence info strings —
 * the spots where CommonMark decodes them — so `?a=1&amp;b=2` becomes
 * `?a=1&b=2` before URL validation and `esc`, instead of `&amp;amp;`.
 */
function unescapeMd(s: string): string {
  return s.replace(
    /\\([!-/:-@[-`{-~])|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (ent, punct: string | undefined) => punct ?? decodeEntity(ent),
  );
}

// ─── Block structure ───────────────────────────────────────────────

const RE_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_BQ = /^ {0,3}> ?(.*)$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_LIST = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))([ \t]+|$)/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_REF_DEF =
  /^ {0,3}\[((?:[^\]\\]|\\.){1,999})\]:[ \t]*<?([^\s>]*)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;

const BLOCK_TAGS = new Set(
  (
    "address article aside base basefont blockquote body caption center col colgroup dd details " +
    "dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 " +
    "head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p " +
    "param picture search section summary table tbody td tfoot th thead title tr track ul"
  ).split(" "),
);

const ATTR = `(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^"'=<>\`\\s]+|'[^']*'|"[^"]*"))?)`;
const OPEN_TAG = `<[A-Za-z][A-Za-z0-9-]*${ATTR}*\\s*/?>`;
const CLOSE_TAG = `</[A-Za-z][A-Za-z0-9-]*\\s*>`;
const RE_HTML_LINE = new RegExp(`^ {0,3}(?:${OPEN_TAG}|${CLOSE_TAG})[ \\t]*$`);

/**
 * If `line` opens an HTML block, return the test that ends it (inclusive):
 * a closing pattern, or `null` meaning "the next blank line". `undefined`
 * when the line does not start an HTML block. Type 7 (any lone tag) cannot
 * interrupt a paragraph.
 */
function htmlBlockEnd(line: string, inParagraph: boolean): RegExp | null | undefined {
  if (!/^ {0,3}</.test(line)) return undefined;
  const s = line.trimStart();
  if (/^<(script|pre|style|textarea)(\s|>|$)/i.test(s)) return /<\/(script|pre|style|textarea)>/i;
  if (s.startsWith("<!--")) return /-->/;
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s|\/?>|$)/.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return null;
  if (!inParagraph && RE_HTML_LINE.test(line)) return null;
  return undefined;
}

interface ListMarker {
  ordered: boolean;
  /** Bullet char, or the `.` / `)` delimiter of an ordered marker. */
  delim: string;
  start: number;
  /** Column where the item's content starts. */
  offset: number;
  empty: boolean;
}

function listMarker(line: string): ListMarker | null {
  const m = RE_LIST.exec(line);
  if (!m) return null;
  const ordered = m[3] !== undefined;
  const markerEnd = m[1].length + (ordered ? m[3].length + 1 : 1);
  const empty = isBlank(line.slice(markerEnd));
  const spaces = m[5].length;
  const offset = empty ? markerEnd + 1 : markerEnd + (spaces > 4 ? 1 : spaces);
  return { ordered, delim: ordered ? m[4] : m[2], start: ordered ? parseInt(m[3], 10) : 1, offset, empty };
}

function isFenceOpen(line: string): RegExpExecArray | null {
  const m = RE_FENCE.exec(line);
  if (!m || (m[2][0] === "`" && m[3].includes("`"))) return null;
  return m;
}

/** True when `line` closes a fence opened with `fence` (e.g. "```"). */
function isFenceClose(line: string, fence: string): boolean {
  const m = RE_FENCE.exec(line);
  return !!m && m[2][0] === fence[0] && m[2].length >= fence.length && isBlank(m[3]);
}

/**
 * Fence still open after `line` (`null` when none), given the one open before.
 * Lets block scanners know when they're inside code, where lazy paragraph
 * continuation never applies.
 */
function fenceAfter(line: string, fence: string | null): string | null {
  if (fence) return isFenceClose(line, fence) ? null : fence;
  return isFenceOpen(line)?.[2] ?? null;
}

/** True when `line` starts a block that ends a paragraph / lazy continuation. */
function interruptsParagraph(line: string): boolean {
  if (isFenceOpen(line) || RE_ATX.test(line) || RE_HR.test(line) || RE_BQ.test(line)) return true;
  if (htmlBlockEnd(line, true) !== undefined) return true;
  const lm = listMarker(line);
  return !!lm && !lm.empty && (!lm.ordered || lm.start === 1);
}

/** Pull `[label]: url "title"` definitions out of the document. */
function collectRefs(lines: string[], refs: Map<string, LinkRef>): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let prevBlank = true;
  for (const line of lines) {
    const open: RegExpExecArray | null = fence ? null : isFenceOpen(line);
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else if (open) {
      fence = open[2];
    } else if (prevBlank) {
      const m = RE_REF_DEF.exec(line);
      if (m) {
        const label = normalizeLabel(m[1]);
        if (label && !refs.has(label)) {
          const title = m[3] ?? m[4] ?? m[5];
          refs.set(label, { href: unescapeMd(m[2]), title: title === undefined ? undefined : unescapeMd(title) });
        }
        continue;
      }
    }
    out.push(line);
    prevBlank = isBlank(line) || (!fence && RE_REF_DEF.test(line));
  }
  return out;
}

/**
 * Whether a paragraph is inside an HTML comment after `line`, given whether
 * it was before. Ignores the empty `<!-->` / `<!--->` forms and code spans
 * (per line — a span crossing a newline is not seen).
 */
function inCommentAfter(line: string, inComment: boolean): boolean {
  const s = line.includes("`") ? line.replace(/(`+)[^`]*?\1/g, "") : line;
  let i = 0;
  for (;;) {
    if (inComment) {
      const close = s.indexOf("-->", i);
      if (close < 0) return true;
      i = close + 3;
      inComment = false;
    } else {
      const open = s.indexOf("<!--", i);
      if (open < 0) return false;
      i = open + 4;
      inComment = !(s.startsWith(">", i) || s.startsWith("->", i));
    }
  }
}

/** Index of the first line at or after `from` holding a `-->`, or -1. */
function nextCommentClose(lines: string[], from: number, lastClose: number): number {
  if (from > lastClose) return -1;
  for (let j = from; j <= lastClose; j++) if (lines[j].includes("-->")) return j;
  return -1;
}

/**
 * At blank line `i` inside an open HTML comment, the index of the line that
 * closes it, or -1 (not in a comment, or never closed). A comment opened
 * mid-paragraph hides everything up to its `-->`, blank lines included —
 * READMEs use that to hide whole sections. `lastClose` (the last line holding
 * a `-->`) bounds the lookahead so an unclosed comment can't make it quadratic.
 */
function commentSpanEnd(lines: string[], i: number, inComment: boolean, lastClose: number): number {
  return inComment && isBlank(lines[i]) ? nextCommentClose(lines, i, lastClose) : -1;
}

/** Whether a comment is open after the line that closed the previous one. */
function inCommentAfterClose(line: string): boolean {
  return inCommentAfter(line.slice(line.indexOf("-->") + 3), false);
}

function renderBlocks(lines: string[], ctx: Ctx, tight: boolean): string {
  if (ctx.depth > MAX_NESTING) return `<p>${esc(lines.join("\n"))}</p>\n`;
  // Bounds the `-->` lookahead: past it, an open comment cannot close.
  let commentClose = lines.length - 1;
  while (commentClose >= 0 && !lines[commentClose].includes("-->")) commentClose--;
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Indented code block.
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        body.push(stripIndent(lines[i], 4));
        i++;
      }
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      out += `<pre class="md-code-block"><code>${esc(body.join("\n"))}\n</code></pre>\n`;
      continue;
    }

    // Fenced code block.
    const fm = isFenceOpen(line);
    if (fm) {
      const indent = fm[1].length;
      const fence = fm[2];
      const lang = unescapeMd(fm[3].trim().split(/\s+/)[0]);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        if (isFenceClose(lines[i], fence)) {
          i++;
          break;
        }
        body.push(stripIndent(lines[i], indent));
        i++;
      }
      const cls = lang === "suggestion" ? "md-code-block md-suggestion-block" : "md-code-block";
      const codeCls = lang ? ` class="language-${esc(lang)}"` : "";
      const code = body.length ? esc(body.join("\n")) + "\n" : "";
      out += `<pre class="${cls}"><code${codeCls}>${code}</code></pre>\n`;
      continue;
    }

    // ATX heading.
    const hm = RE_ATX.exec(line);
    if (hm) {
      out += renderHeading(hm[1].length, hm[2] ?? "", ctx);
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      out += '<hr class="md-hr">\n';
      i++;
      continue;
    }

    // Blockquote (with lazy paragraph continuation).
    if (RE_BQ.test(line)) {
      const inner: string[] = [];
      let fence: string | null = null;
      while (i < lines.length) {
        const q = RE_BQ.exec(lines[i]);
        if (q) {
          inner.push(q[1]);
        } else {
          const prev = inner[inner.length - 1];
          if (fence || isBlank(lines[i]) || prev === undefined || isBlank(prev) || interruptsParagraph(lines[i])) break;
          inner.push(lines[i]);
        }
        fence = fenceAfter(inner[inner.length - 1], fence);
        i++;
      }
      out += `<blockquote class="md-blockquote">\n${renderNested(inner, ctx, false)}</blockquote>\n`;
      continue;
    }

    // List.
    const first = listMarker(line);
    if (first) {
      const res = renderList(lines, i, first, ctx, commentClose);
      out += res.html;
      i = res.next;
      continue;
    }

    // HTML block — passed through verbatim (sanitized downstream).
    const htmlEnd = htmlBlockEnd(line, false);
    if (htmlEnd !== undefined) {
      const body: string[] = [];
      while (i < lines.length) {
        if (htmlEnd === null && isBlank(lines[i])) break;
        body.push(lines[i]);
        i++;
        if (htmlEnd && htmlEnd.test(body[body.length - 1])) break;
      }
      out += body.join("\n") + "\n";
      continue;
    }

    // GFM table.
    if (isTableStart(lines, i)) {
      const res = renderTable(lines, i, ctx);
      out += res.html;
      i = res.next;
      continue;
    }

    // Paragraph, possibly turned into a setext heading.
    const para: string[] = [line];
    let inComment = inCommentAfter(line, false);
    let setext = 0;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        const close = commentSpanEnd(lines, i, inComment, commentClose);
        if (close < 0) break;
        for (; i <= close; i++) para.push(lines[i]);
        inComment = inCommentAfterClose(lines[close]);
        continue;
      }
      const st = RE_SETEXT.exec(l);
      if (st) {
        setext = st[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interruptsParagraph(l) || isTableStart(lines, i)) break;
      para.push(l);
      inComment = inCommentAfter(l, inComment);
      i++;
    }
    const content = para.map((l) => l.replace(/^[ \t]+/, "")).join("\n").replace(/[ \t]+$/, "");
    if (setext) {
      out += renderHeading(setext, content, ctx);
    } else {
      const html = renderInline(content, ctx, false);
      out += tight ? `${html}\n` : `<p>${html}</p>\n`;
    }
  }
  return out;
}

function renderNested(lines: string[], ctx: Ctx, tight: boolean): string {
  ctx.depth++;
  try {
    return renderBlocks(lines, ctx, tight);
  } finally {
    ctx.depth--;
  }
}

function renderHeading(level: number, src: string, ctx: Ctx): string {
  const html = renderInline(src.trim(), ctx, false);
  const slug = slugifyHeading(plainText(html));
  const id = slug ? ` id="${esc(slug)}"` : "";
  return `<h${level}${id}>${html}</h${level}>\n`;
}

function renderList(
  lines: string[],
  start: number,
  first: ListMarker,
  ctx: Ctx,
  commentClose: number,
): { html: string; next: number } {
  const items: string[][] = [];
  let cur: string[] = [];
  let offset = 0;
  // Fence open in the current item's content, if any.
  let fence: string | null = null;
  // Whether the current item's text is inside an HTML comment.
  let inComment = false;
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    // Same rule as a top-level paragraph: from a blank line, keep the rest of
    // the comment (unindented lines too) in the item, where the paragraph
    // builder drops the whole range instead of the item ending here.
    const close = fence ? -1 : commentSpanEnd(lines, i, inComment, commentClose);
    if (close >= 0) {
      for (; i <= close; i++) cur.push(lines[i].slice(Math.min(offset, indentOf(lines[i]))));
      inComment = inCommentAfterClose(lines[close]);
      continue;
    }
    const mk = listMarker(l);
    const isNewItem =
      mk && mk.ordered === first.ordered && mk.delim === first.delim &&
      (i === start || indentOf(l) < offset) && !(i > start && RE_HR.test(l));
    if (isNewItem) {
      if (i > start) items.push(cur);
      cur = [mk.empty ? "" : l.slice(mk.offset)];
      offset = mk.offset;
      fence = null;
    } else if (isBlank(l)) {
      // An empty item followed by a blank line ends the list.
      if (cur.length === 1 && cur[0] === "") break;
      cur.push("");
    } else if (indentOf(l) >= offset) {
      cur.push(l.slice(offset));
    } else {
      const prev = cur[cur.length - 1];
      if (fence || prev === undefined || isBlank(prev) || mk || interruptsParagraph(l)) break;
      cur.push(l); // lazy paragraph continuation
    }
    fence = fenceAfter(cur[cur.length - 1], fence);
    inComment = !fence && inCommentAfter(cur[cur.length - 1], isNewItem ? false : inComment);
    i++;
  }
  items.push(cur);

  // Loose when items are separated by blank lines, or an item holds two
  // direct children separated by one (blank lines inside code or nested
  // items don't count).
  let loose = false;
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    let trailing = 0;
    while (item.length > 1 && isBlank(item[item.length - 1])) {
      item.pop();
      trailing++;
    }
    if (trailing && k < items.length - 1) loose = true;
    let inFence = false;
    // Content column of the nested list item the scan is in, or -1. Lines
    // indented to it (and sibling markers) belong to that nested list.
    let nested = -1;
    // Blank lines hidden inside an HTML comment don't separate anything — but
    // only a comment closed within the item hides them (as in renderBlocks).
    let itemClose = item.length - 1;
    while (itemClose >= 0 && !item[itemClose].includes("-->")) itemClose--;
    let inItemComment = false;
    for (let j = 0; j < item.length && !loose; j++) {
      const l = item[j];
      if (inItemComment) {
        inItemComment = inCommentAfter(l, true);
        continue;
      }
      if (isFenceOpen(l) || (inFence && RE_FENCE.test(l))) inFence = !inFence;
      if (inFence) continue;
      inItemComment = j < itemClose && inCommentAfter(l, false);
      if (!isBlank(l)) {
        const mk = listMarker(l);
        // Deeper markers are inside the nested item already: keep its column.
        if (mk && (nested < 0 || indentOf(l) < nested)) nested = mk.offset;
        else if (!mk && nested >= 0 && indentOf(l) < nested && isBlank(item[j - 1])) nested = -1;
        continue;
      }
      if (j === 0) continue;
      let after = j + 1;
      while (after < item.length && isBlank(item[after])) after++;
      if (after === item.length) break;
      const next = item[after];
      // Loose only when the blank separates two direct children of the item.
      if (nested < 0 || (indentOf(next) < nested && !listMarker(next))) loose = true;
      j = after - 1;
    }
  }

  const tag = first.ordered ? "ol" : "ul";
  const startAttr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : "";
  let html = `<${tag}${startAttr}>\n`;
  for (const item of items) {
    let cls = "";
    let box = "";
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(item[0]);
    if (task) {
      const checked = task[1] !== " ";
      cls = checked ? ' class="md-check md-checked"' : ' class="md-check"';
      // The state lives in the HTML itself, not in a stylesheet: the body is
      // rendered in many panes and DOMPurify strips <input>.
      box = `<span class="md-check-box">${checked ? "☑" : "☐"}</span> `;
      item[0] = item[0].slice(task[0].length);
    }
    let inner = renderNested(item, ctx, !loose);
    // Keep the box on the text's line: inside the first <p> of a loose item.
    inner = inner.startsWith("<p>") ? "<p>" + box + inner.slice(3) : box + inner;
    html += `<li${cls}>${loose ? "\n" + inner : inner.replace(/\n$/, "")}</li>\n`;
  }
  return { html: html + `</${tag}>\n`, next: i };
}

/** Split a table row on unescaped pipes (GFM splits inside code spans too). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes("|") || !RE_TABLE_DELIM.test(delim) || indentOf(head) >= 4) return false;
  return splitRow(head).length === splitRow(delim).length;
}

function renderTable(lines: string[], start: number, ctx: Ctx): { html: string; next: number } {
  const head = splitRow(lines[start]);
  const cols = head.length;
  let html = '<table class="md-table">\n<thead>\n<tr>\n';
  for (const c of head) html += `<th>${renderInline(c, ctx, false)}</th>\n`;
  html += "</tr>\n</thead>\n";
  let i = start + 2;
  let body = "";
  while (i < lines.length && !isBlank(lines[i]) && !interruptsParagraph(lines[i])) {
    const cells = splitRow(lines[i]);
    body += "<tr>\n";
    for (let c = 0; c < cols; c++) body += `<td>${renderInline(cells[c] ?? "", ctx, false)}</td>\n`;
    body += "</tr>\n";
    i++;
  }
  if (body) html += `<tbody>\n${body}</tbody>\n`;
  return { html: html + "</table>\n", next: i };
}

// ─── Inline ────────────────────────────────────────────────────────

/** An emphasis delimiter run (`*`, `_`, `~~`), resolved after scanning. */
interface Delim {
  ch: string;
  /** Characters not yet consumed by a match. */
  n: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  openTags: string[];
  closeTags: string[];
}

type Tok = string | Delim;

const RE_PUNCT = /[\p{P}\p{S}]/u;
/**
 * Next character the inline scanner must act on. Bare-URL starts are matched
 * here too (at a word boundary) so ordinary `h` / `w` letters are copied in
 * bulk instead of stopping the scan.
 */
const RE_SPECIAL = /[\\`*_~![\]<&\n@]|(?<![\w/.:@-])(?:https?:\/\/|www\.)/gi;
const RE_INLINE_HTML = new RegExp(`${OPEN_TAG}|${CLOSE_TAG}|<!--(?!>|->)[\\s\\S]*?-->`, "y");
const RE_ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const RE_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
const RE_EMAIL =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const RE_LINKIFY = /(?:https?:\/\/[^\s<>]+|www\.[a-zA-Z0-9-]+\.[^\s<>]+)/iy;
/**
 * Bare email, GFM extended autolink: local part (already in the text run) and
 * domain after `@`. The last label must be alphabetic, as a TLD is: otherwise
 * package specs like `vue@3.5.42` or `@types/node@25.9.5` — all over
 * Dependabot/Renovate PR bodies — would become mailto links. A numeric first
 * label is refused too, for prereleases like `pkg@1.0.0-alpha.beta`.
 */
const RE_EMAIL_LOCAL_CHAR = /[a-zA-Z0-9.+-]/;
const RE_EMAIL_DOMAIN = /(?![0-9]+\.)(?:[a-zA-Z0-9_-]+\.)+[a-zA-Z]{2,}(?![a-zA-Z0-9_-])/y;
/** Punctuation trimmed off the end of a bare URL (`see https://x.com.`). */
const RE_TRAIL_PUNCT = /[.,:;!?'"*_~]+$/;

function flanking(ch: string, before: string, after: string): { canOpen: boolean; canClose: boolean } {
  const wsB = /\s/.test(before);
  const wsA = /\s/.test(after);
  const pB = RE_PUNCT.test(before);
  const pA = RE_PUNCT.test(after);
  const left = !wsA && (!pA || wsB || pB);
  const right = !wsB && (!pB || wsA || pA);
  if (ch === "_") return { canOpen: left && (!right || pB), canClose: right && (!left || pA) };
  return { canOpen: left, canClose: right };
}

/**
 * Bounds of the code span opened by the backtick run at `i`, or `null` when
 * no run of the same length closes it.
 */
function codeSpanEnd(src: string, i: number): { contentStart: number; contentEnd: number; end: number } | null {
  let j = i;
  while (src[j] === "`") j++;
  const run = j - i;
  let k = j;
  for (;;) {
    const p = src.indexOf("`", k);
    if (p < 0) return null;
    let q = p;
    while (src[q] === "`") q++;
    if (q - p === run) return { contentStart: j, contentEnd: p, end: q };
    k = q;
  }
}

/**
 * Longest link text we look for a `]` in. Bounds the scan so a run of
 * unclosed `[` can't turn rendering quadratic.
 */
const MAX_LABEL = 1000;

/** Index of the `]` closing the label opened just before `start`, or -1. */
function labelEnd(src: string, start: number): number {
  let depth = 1;
  const limit = Math.min(src.length, start + MAX_LABEL);
  for (let k = start; k < limit; k++) {
    const c = src[k];
    if (c === "\\") {
      k++;
    } else if (c === "`") {
      const span = codeSpanEnd(src, k);
      if (span) k = span.end - 1;
      else while (src[k + 1] === "`") k++;
    } else if (c === "[") {
      depth++;
    } else if (c === "]" && --depth === 0) {
      return k;
    }
  }
  return -1;
}

/** Parse `(dest "title")` starting at the `(` at `p`. */
function parseInlineDest(src: string, p: number): { href: string; title?: string; end: number } | null {
  let i = p + 1;
  const skipWs = () => {
    while (i < src.length && /[ \t\n]/.test(src[i])) i++;
  };
  skipWs();
  let href = "";
  if (src[i] === "<") {
    const close = src.indexOf(">", i);
    if (close < 0) return null;
    href = src.slice(i + 1, close);
    if (/[\n<]/.test(href)) return null;
    i = close + 1;
  } else {
    const s = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\" && i + 1 < src.length) {
        i += 2;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === "(" && ++depth > 32) return null; // bounds `[a]([a]([a](…`
      if (c === ")" && depth-- === 0) break;
      i++;
    }
    href = src.slice(s, i);
  }
  const beforeTitle = i;
  skipWs();
  let title: string | undefined;
  const q = src[i];
  if (i > beforeTitle && (q === '"' || q === "'" || q === "(")) {
    const closer = q === "(" ? ")" : q;
    let j = i + 1;
    while (j < src.length && src[j] !== closer) j += src[j] === "\\" ? 2 : 1;
    if (j >= src.length) return null;
    title = unescapeMd(src.slice(i + 1, j));
    i = j + 1;
    skipWs();
  }
  if (src[i] !== ")") return null;
  return { href: unescapeMd(href), title, end: i + 1 };
}

function titleAttr(title?: string): string {
  return title ? ` title="${esc(title)}"` : "";
}

/** `<a>` for a validated target; `html` is the already-rendered link text. */
function anchor(href: string, html: string, title?: string): string {
  return `<a href="${esc(normalizeUrl(href))}"${titleAttr(title)} class="md-link">${html}</a>`;
}

function renderInline(src: string, ctx: Ctx, inLink: boolean): string {
  const toks: Tok[] = [];
  let text = "";
  const flush = () => {
    if (text) toks.push(text);
    text = "";
  };
  const push = (html: string) => {
    flush();
    toks.push(html);
  };
  let rawAnchors = 0;
  let i = 0;
  const n = src.length;
  // Without this, every unclosed `<!--` rescans to the end of the input.
  const lastCommentEnd = src.lastIndexOf("-->");

  while (i < n) {
    RE_SPECIAL.lastIndex = i;
    const sm = RE_SPECIAL.exec(src);
    const at = sm ? sm.index : n;
    if (at > i) text += esc(src.slice(i, at));
    i = at;
    if (i >= n) break;
    const c = src[i];

    if (c === "\\") {
      const nx = src[i + 1];
      if (nx === "\n") {
        push("<br>\n");
        i += 2;
        while (src[i] === " ") i++;
      } else if (nx !== undefined && /[!-/:-@[-`{-~]/.test(nx)) {
        text += esc(nx);
        i += 2;
      } else {
        text += "\\";
        i++;
      }
      continue;
    }

    if (c === "`") {
      const span = codeSpanEnd(src, i);
      if (!span) {
        let j = i;
        while (src[j] === "`") j++;
        text += src.slice(i, j);
        i = j;
        continue;
      }
      let code = src.slice(span.contentStart, span.contentEnd).replace(/\n/g, " ");
      if (code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
      push(`<code class="md-inline-code">${esc(code)}</code>`);
      i = span.end;
      continue;
    }

    if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (src[j] === c) j++;
      const run = j - i;
      if (c === "~" && run !== 2) {
        text += src.slice(i, j);
      } else {
        const fl = flanking(c, i > 0 ? src[i - 1] : "\n", j < n ? src[j] : "\n");
        flush();
        toks.push({ ch: c, n: run, orig: run, ...fl, openTags: [], closeTags: [] });
      }
      i = j;
      continue;
    }

    if ((c === "!" && src[i + 1] === "[") || (c === "[" && !inLink)) {
      const image = c === "!";
      const res = parseLink(src, image ? i + 1 : i, image, ctx);
      if (res) {
        push(res.html);
        i = res.end;
      } else {
        text += image ? "![" : "[";
        i += image ? 2 : 1;
      }
      continue;
    }

    if (c === "<") {
      RE_AUTOLINK.lastIndex = i;
      RE_EMAIL.lastIndex = i;
      RE_INLINE_HTML.lastIndex = i;
      let m: RegExpExecArray | null;
      if ((m = RE_AUTOLINK.exec(src)) && isSafeUrl(m[1], "link")) {
        push(inLink ? esc(m[1]) : anchor(m[1], esc(m[1])));
        i += m[0].length;
      } else if ((m = RE_EMAIL.exec(src))) {
        push(inLink ? esc(m[1]) : anchor("mailto:" + m[1], esc(m[1])));
        i += m[0].length;
      } else if ((src.startsWith("<!--", i) ? i < lastCommentEnd : true) && (m = RE_INLINE_HTML.exec(src))) {
        if (/^<a[\s>]/i.test(m[0])) rawAnchors++;
        else if (/^<\/a\s*>/i.test(m[0])) rawAnchors = Math.max(0, rawAnchors - 1);
        push(m[0]);
        i += m[0].length;
      } else {
        text += "&lt;";
        i++;
      }
      continue;
    }

    // Bare email (GFM): the local part was copied into `text` already.
    if (c === "@" && !inLink && rawAnchors === 0) {
      // Read back from `src`, not `text` (slicing the concatenated run on
      // every `@` is quadratic): these characters are never special or
      // escaped, so they are exactly the tail of `text`. Capped at RFC 5321's 64.
      let start = i;
      while (start > 0 && i - start < 64 && RE_EMAIL_LOCAL_CHAR.test(src[start - 1])) start--;
      const local = src.slice(start, i);
      RE_EMAIL_DOMAIN.lastIndex = i + 1;
      const domain = local && RE_EMAIL_DOMAIN.exec(src)?.[0];
      if (domain) {
        text = text.slice(0, -local.length);
        const addr = `${local}@${domain}`;
        push(anchor("mailto:" + addr, esc(addr)));
        i += 1 + domain.length;
        continue;
      }
    }

    if (c === "&") {
      RE_ENTITY.lastIndex = i;
      const m = RE_ENTITY.exec(src);
      text += m ? m[0] : "&amp;";
      i += m ? m[0].length : 1;
      continue;
    }

    if (c === "\n") {
      const trimmed = text.replace(/ +$/, "");
      const spaces = text.length - trimmed.length;
      text = trimmed;
      push(spaces >= 2 || ctx.breaks ? "<br>\n" : "\n");
      i++;
      while (src[i] === " ") i++;
      continue;
    }

    // Start of a bare URL (RE_SPECIAL checked the word boundary): linkify
    // it unless we're already inside a link.
    if (!inLink && rawAnchors === 0) {
      RE_LINKIFY.lastIndex = i;
      const m = RE_LINKIFY.exec(src);
      if (m) {
        let url = m[0].replace(RE_TRAIL_PUNCT, "");
        // Drop a trailing `)` / `]` that closes a bracket opened outside the URL.
        const unbalanced = (o: RegExp, c: RegExp) => (url.match(o)?.length ?? 0) < (url.match(c)?.length ?? 0);
        while (
          (url.endsWith(")") && unbalanced(/\(/g, /\)/g)) ||
          (url.endsWith("]") && unbalanced(/\[/g, /\]/g))
        ) {
          url = url.slice(0, -1).replace(RE_TRAIL_PUNCT, "");
        }
        const href = /^www\./i.test(url) ? "http://" + url : url;
        if (isSafeUrl(href, "link")) {
          push(anchor(href, esc(url)));
          i += url.length;
          continue;
        }
      }
    }
    text += esc(c);
    i++;
  }
  flush();
  resolveEmphasis(toks);

  let out = "";
  for (const t of toks) {
    out += typeof t === "string" ? t : t.closeTags.join("") + t.ch.repeat(t.n) + t.openTags.join("");
  }
  return out;
}

/** Parse a link or image whose `[` is at `p`. */
function parseLink(src: string, p: number, image: boolean, ctx: Ctx): { html: string; end: number } | null {
  const close = labelEnd(src, p + 1);
  if (close < 0) return null;
  const label = src.slice(p + 1, close);
  let target: LinkRef | undefined;
  let end = close + 1;

  if (src[end] === "(") {
    const dest = parseInlineDest(src, end);
    if (dest) {
      target = dest;
      end = dest.end;
    }
  }
  if (!target) {
    let refLabel = label;
    if (src[end] === "[") {
      const refClose = src.indexOf("]", end + 1);
      if (refClose > 0) {
        const inner = src.slice(end + 1, refClose);
        if (inner.trim()) refLabel = inner;
        end = refClose + 1;
      }
    }
    target = ctx.refs.get(normalizeLabel(refLabel));
    if (!target) return null;
  }
  if (!isSafeUrl(target.href, image ? "image" : "link")) return null;

  if (image) {
    const alt = plainText(renderInline(label, ctx, true));
    return { html: `<img src="${esc(normalizeUrl(target.href))}" alt="${esc(alt)}"${titleAttr(target.title)}>`, end };
  }
  return { html: anchor(target.href, renderInline(label, ctx, true), target.title), end };
}

/**
 * CommonMark "process emphasis", reduced to what `*`, `_` and `~~` need.
 * `prev` links each delimiter to the previous one still in play, so matched
 * ranges drop out in O(1); `bottom` remembers, per closer kind, below which
 * index no opener can exist — together they keep this linear.
 */
function resolveEmphasis(toks: Tok[]): void {
  const delims = toks.filter((t): t is Delim => typeof t !== "string");
  const prev = delims.map((_, k) => k - 1);
  const bottom = new Map<string, number>();
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.canClose) continue;
    const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}`;
    while (closer.n > 0) {
      const floor = bottom.get(key) ?? -1;
      let oi = prev[ci];
      for (; oi > floor; oi = prev[oi]) {
        const o = delims[oi];
        if (o.ch !== closer.ch || !o.canOpen || o.n === 0) continue;
        if (closer.ch === "~") break;
        // "Rule of 3": `*foo**bar*` must not pair the `*` with the `**`.
        if ((o.canClose || closer.canOpen) && (o.orig + closer.orig) % 3 === 0 && (o.orig % 3 || closer.orig % 3)) {
          continue;
        }
        break;
      }
      if (oi <= floor) {
        bottom.set(key, ci - 1);
        break;
      }
      const opener = delims[oi];
      const use = closer.ch === "~" ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      const tag = closer.ch === "~" ? "s" : use === 2 ? "strong" : "em";
      opener.n -= use;
      closer.n -= use;
      opener.openTags.unshift(`<${tag}>`);
      closer.closeTags.push(`</${tag}>`);
      // Delimiters between the pair (and a spent opener) can no longer match.
      prev[ci] = opener.n > 0 ? oi : prev[oi];
    }
    if (closer.n === 0 && ci + 1 < delims.length) prev[ci + 1] = prev[ci];
  }
}
