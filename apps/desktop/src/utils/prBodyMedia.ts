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
}

/**
 * Media snippets, in alternation order. Wrappers come before what they wrap
 * so a `<picture>` or a linked image is kept as one unit rather than having
 * its inner `<img>` / `![…](…)` pulled out of it.
 */
const MEDIA_RE = new RegExp(
  [
    String.raw`<picture\b[\s\S]*?<\/picture>`,
    String.raw`<video\b[\s\S]*?<\/video>`,
    String.raw`<img\b[^>]*>`,
    // Linked image: [![alt](src)](href)
    String.raw`\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)`,
    String.raw`!\[[^\]]*\]\([^)]*\)`,
    // GitHub renders a bare attachment URL on its own line as an image/video.
    String.raw`^[ \t]*https?:\/\/(?:github\.com\/user-attachments\/assets\/|(?:private-)?user-images\.githubusercontent\.com\/)\S+[ \t]*$`,
    // Any other bare media URL on its own line.
    String.raw`^[ \t]*https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)(?:\?\S*)?[ \t]*$`,
  ].join("|"),
  "gim",
);

/** Tolerates the usual model drift: spacing, case, backtick wrapping. */
const PLACEHOLDER_RE = /`?\[\[\s*IMAGE_(\d+)\s*\]\]`?/gi;

export function placeholder(n: number): string {
  return `[[IMAGE_${n}]]`;
}

export function maskMedia(body: string): MaskedMedia {
  const media: string[] = [];
  const text = body.replace(MEDIA_RE, (match) => {
    const leading = match.match(/^[ \t]*/)![0];
    media.push(match.trim());
    return leading + placeholder(media.length);
  });
  return { text, media };
}

/**
 * Put the original media back into `text`. Each placeholder is restored once,
 * at its first occurrence; repeats and placeholders that match no media are
 * removed; media whose placeholder the model dropped is appended at the end.
 */
export function restoreMedia(text: string, media: string[]): string {
  const used = new Set<number>();
  let out = text.replace(PLACEHOLDER_RE, (_m, digits: string) => {
    const idx = Number(digits) - 1;
    if (idx < 0 || idx >= media.length || used.has(idx)) return "";
    used.add(idx);
    return media[idx]!;
  });
  const missing = media.filter((_, i) => !used.has(i));
  out = out.trim();
  if (missing.length) out = [out, ...missing].filter(Boolean).join("\n\n");
  return out;
}
