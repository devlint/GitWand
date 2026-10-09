/**
 * Keep the images (and other embedded media) of a PR description intact
 * across an AI rewrite.
 *
 * Images in a PR body are uploads the user made on the forge — screenshots,
 * GIFs, videos. Their URLs are long, opaque and easy for a model to truncate,
 * "fix" or drop. So before the body goes to the model every media snippet is
 * swapped for a short placeholder (`[[IMAGE_1]]`), the model is asked to keep
 * those placeholders where they belong, and afterwards each placeholder is
 * swapped back for the exact original snippet. A placeholder the model dropped
 * is not lost: its media is appended at the end of the new body.
 */

export interface MaskedMedia {
  /** The body with every media snippet replaced by `[[IMAGE_n]]` (1-based). */
  text: string;
  /** The original snippets, `media[n - 1]` for placeholder `[[IMAGE_n]]`. */
  media: string[];
  /**
   * 0-based indexes of placeholders that sit right next to a backtick the
   * user wrote. `restoreMedia` must never treat those backticks as model drift.
   */
  adjacentTicks: number[];
}

/** `(…)` of a markdown link/image: allows spaces (titles) and one level of nested parens. */
const PAREN = String.raw`\((?:[^()]|\([^()]*\))*\)`;

/**
 * A literal `[[IMAGE_n]]` already present in the body. It would be
 * indistinguishable from our own placeholders on the way back, so it is
 * protected like media: swapped out and restored verbatim.
 */
const LITERAL_PLACEHOLDER = "`?" + String.raw`\[\[\s*IMAGE_\d+\s*\]\]` + "`?";

/**
 * Media snippets, in alternation order. Wrappers come before what they wrap
 * so a `<picture>` or a linked image is kept as one unit rather than having
 * its inner `<img>` / `![…](…)` pulled out of it. A wrapper's lazy span may
 * not contain another opening tag of the same kind, so an unclosed or
 * self-closed `<video>` never swallows everything up to a later `</video>`.
 */
const MEDIA_ALTERNATIVES = [
  String.raw`<picture\b[^>]*\/>`,
  String.raw`<picture\b(?:(?!<picture\b)[\s\S])*?<\/picture>`,
  String.raw`<video\b[^>]*\/>`,
  String.raw`<video\b(?:(?!<video\b)[\s\S])*?<\/video>`,
  String.raw`<img\b[^>]*>`,
  // Linked image: [![alt](src)](href)
  String.raw`\[!\[[^\]]*\]` + PAREN + String.raw`\]` + PAREN,
  String.raw`!\[[^\]]*\]` + PAREN,
  // GitHub renders a bare attachment URL on its own line as an image/video.
  String.raw`^[ \t]*https?:\/\/(?:github\.com\/user-attachments\/assets\/|(?:private-)?user-images\.githubusercontent\.com\/)\S+[ \t]*$`,
  // Any other bare media URL on its own line.
  String.raw`^[ \t]*https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)(?:\?\S*)?[ \t]*$`,
];

const MEDIA_RE = new RegExp([...MEDIA_ALTERNATIVES, LITERAL_PLACEHOLDER].join("|"), "gim");
/** Inside fenced code only literal placeholders are protected; media there is just code. */
const LITERAL_RE = new RegExp(LITERAL_PLACEHOLDER, "gi");

/** Tolerates the usual model drift: spacing, case, backtick wrapping. */
const PLACEHOLDER_RE = /(`?)\[\[\s*IMAGE_(\d+)\s*\]\](`?)/gi;

/** Inline code spans (not across a blank line): media inside is just code. */
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

/** Split a non-fenced run into inline-code / other pieces. */
function splitInlineCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_CODE_RE)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

export function placeholder(n: number): string {
  return `[[IMAGE_${n}]]`;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Split a body into runs of lines that are inside / outside fenced code
 * blocks (CommonMark: a fence closes on the same character, at least as long,
 * with nothing else on the line; an unclosed fence runs to the end).
 */
function splitFences(body: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  let fence: { ch: string; len: number } | null = null;
  const push = (code: boolean, line: string) => {
    const last = parts[parts.length - 1];
    if (last && last.code === code) last.text += line;
    else parts.push({ code, text: line });
  };
  for (const line of body.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "");
    if (!fence) {
      const m = FENCE_OPEN_RE.exec(bare);
      if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
        fence = { ch: m[1]![0]!, len: m[1]!.length };
        push(true, line);
      } else {
        push(false, line);
      }
    } else {
      push(true, line);
      const t = bare.trim();
      if (t.length >= fence.len && t === fence.ch.repeat(t.length)) fence = null;
    }
  }
  return parts;
}

export function maskMedia(body: string): MaskedMedia {
  const media: string[] = [];
  const mask = (match: string) => {
    const leading = match.match(/^[ \t]*/)![0];
    media.push(match.trim());
    return leading + placeholder(media.length);
  };
  const text = splitFences(body)
    .flatMap((part) => (part.code ? [part] : splitInlineCode(part.text)))
    .map((part) => part.text.replace(part.code ? LITERAL_RE : MEDIA_RE, mask))
    .join("");
  const adjacentTicks: number[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m[1] || m[3]) adjacentTicks.push(Number(m[2]) - 1);
  }
  return { text, media, adjacentTicks };
}

/**
 * Put the original media back into `text`. Each placeholder is restored once,
 * at its first occurrence; repeats and placeholders that match no media are
 * removed; media whose placeholder the model dropped is appended at the end.
 */
export function restoreMedia(
  text: string,
  media: string[],
  adjacentTicks: readonly number[] = [],
): string {
  const used = new Set<number>();
  const keep = new Set(adjacentTicks);
  let out = text.replace(PLACEHOLDER_RE, (_m, pre: string, digits: string, post: string) => {
    const idx = Number(digits) - 1;
    // Masking never adds backticks: only a pair the model wrapped around a
    // placeholder is drift. A single one, or one next to a placeholder the
    // user's own backtick touched, belongs to the user.
    const drift = pre && post && !keep.has(idx);
    const [a, b] = drift ? ["", ""] : [pre, post];
    if (idx < 0 || idx >= media.length || used.has(idx)) return a + b;
    used.add(idx);
    return a + media[idx]! + b;
  });
  const missing = media.filter((_, i) => !used.has(i));
  out = out.trim();
  if (missing.length) out = [out, ...missing].filter(Boolean).join("\n\n");
  return out;
}
