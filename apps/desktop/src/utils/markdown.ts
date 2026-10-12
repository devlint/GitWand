/**
 * markdown — small, dependency-free GitHub-flavoured markdown → HTML renderer.
 *
 * Replaces `markdown-it`. It covers the surface GitWand actually renders
 * (READMEs, PR bodies, review comments): ATX / setext headings, paragraphs,
 * emphasis / strong / `~~strike~~`, inline + fenced + indented code,
 * blockquotes, nested ordered / unordered lists (tight and loose), task
 * lists, GFM tables, horizontal rules, inline + reference + auto links,
 * bare-URL linkify, images, raw HTML blocks and inline tags, backslash
 * escapes and entities.
 *
 * The output is NOT safe on its own: raw HTML from the source is passed
 * through untouched. Always feed it to `safeHtml` (DOMPurify) — callers
 * should use `renderMarkdown` from `composables/useSafeHtml.ts`, never this
 * module directly.
 *
 * Elements carry the `md-*` classes the app's stylesheets target
 * (`md-code-block`, `md-inline-code`, `md-link`, `md-table`, `md-blockquote`,
 * `md-hr`, `md-check` / `md-checked`), and headings get a slug `id` so
 * in-page `#anchor` links resolve.
 */

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
}

/** Render markdown to (unsanitized) HTML. */
export function markdownToHtml(src: string, options: MarkdownOptions = {}): string {
  const text = src.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
  const ctx: Ctx = { refs: new Map(), breaks: options.breaks ?? true };
  const lines = collectRefs(text.split("\n").map(expandTabs), ctx.refs);
  return renderBlocks(lines, ctx, false);
}

// ─── Helpers ───────────────────────────────────────────────────────

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

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
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
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
 * Refuse script-bearing schemes, same policy as markdown-it: no
 * `javascript:` / `vbscript:` / `file:`, and `data:` only for raster images.
 * DOMPurify re-checks downstream; this keeps such links from rendering at all.
 */
function isSafeUrl(url: string): boolean {
  // eslint-disable-next-line no-control-regex
  const s = url.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (/^(javascript|vbscript|file):/.test(s)) return false;
  if (/^data:/.test(s)) return /^data:image\/(gif|png|jpeg|webp);/.test(s);
  return true;
}

function unescapeMd(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
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
    const f = RE_FENCE.exec(line);
    if (fence) {
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length && isBlank(f[3])) fence = null;
    } else if (isFenceOpen(line)) {
      fence = f![2];
    } else if (prevBlank) {
      const m = RE_REF_DEF.exec(line);
      if (m) {
        const label = normalizeLabel(m[1]);
        if (label && !refs.has(label)) {
          refs.set(label, { href: unescapeMd(m[2]), title: m[3] ?? m[4] ?? m[5] });
        }
        continue;
      }
    }
    out.push(line);
    prevBlank = isBlank(line) || (!fence && RE_REF_DEF.test(line));
  }
  return out;
}

function renderBlocks(lines: string[], ctx: Ctx, tight: boolean): string {
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
      const lang = unescapeMd(fm[3].trim().split(/\s+/)[0] ?? "");
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = RE_FENCE.exec(lines[i]);
        if (close && close[2][0] === fence[0] && close[2].length >= fence.length && isBlank(close[3])) {
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
      while (i < lines.length) {
        const q = RE_BQ.exec(lines[i]);
        if (q) {
          inner.push(q[1]);
        } else {
          const prev = inner[inner.length - 1];
          if (isBlank(lines[i]) || prev === undefined || isBlank(prev) || interruptsParagraph(lines[i])) break;
          inner.push(lines[i]);
        }
        i++;
      }
      out += `<blockquote class="md-blockquote">\n${renderBlocks(inner, ctx, false)}</blockquote>\n`;
      continue;
    }

    // List.
    const first = listMarker(line);
    if (first) {
      const res = renderList(lines, i, first, ctx);
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
    let setext = 0;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) break;
      const st = RE_SETEXT.exec(l);
      if (st) {
        setext = st[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interruptsParagraph(l) || isTableStart(lines, i)) break;
      para.push(l);
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

function renderHeading(level: number, src: string, ctx: Ctx): string {
  const html = renderInline(src.trim(), ctx, false);
  const slug = slugifyHeading(plainText(html));
  const id = slug ? ` id="${esc(slug)}"` : "";
  return `<h${level}${id}>${html}</h${level}>\n`;
}

function renderList(lines: string[], start: number, first: ListMarker, ctx: Ctx): { html: string; next: number } {
  const items: string[][] = [];
  let cur: string[] = [];
  let offset = 0;
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    const mk = listMarker(l);
    const isNewItem =
      mk && mk.ordered === first.ordered && mk.delim === first.delim &&
      (i === start || indentOf(l) < offset) && !(i > start && RE_HR.test(l));
    if (isNewItem) {
      if (i > start) items.push(cur);
      cur = [mk.empty ? "" : l.slice(Math.min(mk.offset, l.length))];
      offset = mk.offset;
    } else if (isBlank(l)) {
      // An empty item followed by a blank line ends the list.
      if (cur.length === 1 && cur[0] === "") break;
      cur.push("");
    } else if (indentOf(l) >= offset) {
      cur.push(l.slice(offset));
    } else {
      const prev = cur[cur.length - 1];
      if (prev === undefined || isBlank(prev) || mk || interruptsParagraph(l)) break;
      cur.push(l); // lazy paragraph continuation
    }
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
    for (let j = 0; j < item.length && !loose; j++) {
      if (isFenceOpen(item[j]) || (inFence && RE_FENCE.test(item[j]))) inFence = !inFence;
      if (inFence || !isBlank(item[j]) || j === 0) continue;
      const nextLine = item.slice(j + 1).find((l) => !isBlank(l));
      if (nextLine !== undefined && indentOf(nextLine) < 2) loose = true;
    }
  }

  const tag = first.ordered ? "ol" : "ul";
  const startAttr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : "";
  let html = `<${tag}${startAttr}>\n`;
  for (const item of items) {
    let cls = "";
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(item[0]);
    if (task) {
      cls = task[1] === " " ? ' class="md-check"' : ' class="md-check md-checked"';
      item[0] = item[0].slice(task[0].length);
    }
    const inner = renderBlocks(item, ctx, !loose);
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
const RE_SPECIAL = /[\\`*_~![\]<&\nhHwW]/g;
const RE_INLINE_HTML = new RegExp(`${OPEN_TAG}|${CLOSE_TAG}|<!--(?!>|->)[\\s\\S]*?-->`, "y");
const RE_ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const RE_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
const RE_EMAIL =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const RE_LINKIFY = /(?:https?:\/\/[^\s<>]+|www\.[a-zA-Z0-9-]+\.[^\s<>]+)/iy;

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

/** Index just past the code span closing the backtick run at `i`, or -1. */
function codeSpanEnd(src: string, i: number): { contentEnd: number; end: number } | null {
  let j = i;
  while (src[j] === "`") j++;
  const run = j - i;
  let k = j;
  for (;;) {
    const p = src.indexOf("`", k);
    if (p < 0) return null;
    let q = p;
    while (src[q] === "`") q++;
    if (q - p === run) return { contentEnd: p, end: q };
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
      if (c === "(") depth++;
      else if (c === ")" && depth-- === 0) break;
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

function linkAttrs(href: string, title?: string): string {
  return `href="${esc(normalizeUrl(href))}"${title ? ` title="${esc(title)}"` : ""}`;
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
      let j = i;
      while (src[j] === "`") j++;
      if (!span) {
        text += src.slice(i, j);
        i = j;
        continue;
      }
      let code = src.slice(j, span.contentEnd).replace(/\n/g, " ");
      if (code.length > 2 && code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
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
      if ((m = RE_AUTOLINK.exec(src)) && isSafeUrl(m[1])) {
        push(inLink ? esc(m[1]) : `<a ${linkAttrs(m[1])} class="md-link">${esc(m[1])}</a>`);
        i += m[0].length;
      } else if ((m = RE_EMAIL.exec(src))) {
        push(inLink ? esc(m[1]) : `<a ${linkAttrs("mailto:" + m[1])} class="md-link">${esc(m[1])}</a>`);
        i += m[0].length;
      } else if ((m = RE_INLINE_HTML.exec(src))) {
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

    if (c === "&") {
      RE_ENTITY.lastIndex = i;
      const m = RE_ENTITY.exec(src);
      text += m ? m[0] : "&amp;";
      i += m ? m[0].length : 1;
      continue;
    }

    if (c === "\n") {
      let spaces = 0;
      while (text.endsWith(" ")) {
        text = text.slice(0, -1);
        spaces++;
      }
      push(spaces >= 2 || ctx.breaks ? "<br>\n" : "\n");
      i++;
      while (src[i] === " ") i++;
      continue;
    }

    // h / w: bare URL linkify, only at a word boundary and outside links.
    if (!inLink && rawAnchors === 0 && (i === 0 || !/[\w/.:@-]/.test(src[i - 1]))) {
      RE_LINKIFY.lastIndex = i;
      const m = RE_LINKIFY.exec(src);
      if (m) {
        let url = m[0].replace(/[.,:;!?'"*_~]+$/, "");
        // Drop a trailing `)` that closes a paren opened outside the URL.
        while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
          url = url.slice(0, -1).replace(/[.,:;!?'"*_~]+$/, "");
        }
        const href = /^www\./i.test(url) ? "http://" + url : url;
        if (isSafeUrl(href)) {
          push(`<a ${linkAttrs(href)} class="md-link">${esc(url)}</a>`);
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
  if (!isSafeUrl(target.href)) return null;

  if (image) {
    const alt = plainText(renderInline(label, ctx, true));
    const title = target.title ? ` title="${esc(target.title)}"` : "";
    return { html: `<img src="${esc(normalizeUrl(target.href))}" alt="${esc(alt)}"${title}>`, end };
  }
  return { html: `<a ${linkAttrs(target.href, target.title)} class="md-link">${renderInline(label, ctx, true)}</a>`, end };
}

/** CommonMark "process emphasis", reduced to what `*`, `_` and `~~` need. */
function resolveEmphasis(toks: Tok[]): void {
  const delims = toks.filter((t): t is Delim => typeof t !== "string");
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.canClose) continue;
    while (closer.n > 0) {
      let oi = ci - 1;
      for (; oi >= 0; oi--) {
        const o = delims[oi];
        if (o.ch !== closer.ch || !o.canOpen || o.n === 0) continue;
        if (closer.ch === "~") break;
        // "Rule of 3": `*foo**bar*` must not pair the `*` with the `**`.
        if ((o.canClose || closer.canOpen) && (o.orig + closer.orig) % 3 === 0 && (o.orig % 3 || closer.orig % 3)) {
          continue;
        }
        break;
      }
      if (oi < 0) break;
      const opener = delims[oi];
      const use = closer.ch === "~" ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      const tag = closer.ch === "~" ? "s" : use === 2 ? "strong" : "em";
      opener.n -= use;
      closer.n -= use;
      opener.openTags.unshift(`<${tag}>`);
      closer.closeTags.push(`</${tag}>`);
      // Delimiters between the pair can no longer match across it.
      for (let k = oi + 1; k < ci; k++) delims[k].canOpen = delims[k].canClose = false;
    }
  }
}
