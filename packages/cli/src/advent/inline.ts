/**
 * Tiny inline-markup parser: `code` and **strong**. An unmatched marker stays
 * literal text. Pure, no imports (shared by the CLI and the website).
 */

export type Segment = { kind: "text" | "code" | "strong"; text: string };

export function parseInline(text: string): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const marker = text[i] === "`" ? "`" : text.startsWith("**", i) ? "**" : null;
    if (marker) {
      const end = text.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        flush();
        out.push({
          kind: marker === "`" ? "code" : "strong",
          text: text.slice(i + marker.length, end),
        });
        i = end + marker.length;
        continue;
      }
      buf += marker;
      i += marker.length;
      continue;
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}
