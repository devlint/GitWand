/** GitWand's commit signature, the description's default paragraph (settings: "commit signature"). */
export const COMMIT_SIGNATURE = "\u{1FA84} Commit via GitWand";

/** The description without the signature, alone or as its closing paragraph (the setting turned off). */
export function withoutSignature(description: string): string {
  if (description === COMMIT_SIGNATURE) return "";
  const tail = `\n\n${COMMIT_SIGNATURE}`;
  return description.endsWith(tail) ? description.slice(0, -tail.length) : description;
}
