/** GitWand's commit signature, the description's default paragraph (settings: "commit signature"). */
export const COMMIT_SIGNATURE = "\u{1FA84} Commit via GitWand";

/**
 * The description without the signature (the setting turned off): alone, as
 * the closing paragraph, or heading a closing paragraph of trailers.
 */
export function withoutSignature(description: string): string {
  if (description === COMMIT_SIGNATURE) return "";
  const tail = `\n\n${COMMIT_SIGNATURE}`;
  if (description.endsWith(tail)) return description.slice(0, -tail.length);
  const at = description.lastIndexOf(`${tail}\n`);
  if (at >= 0 && !description.slice(at + tail.length + 1).includes("\n\n")) {
    return description.slice(0, at + 2) + description.slice(at + tail.length + 1);
  }
  return description;
}
