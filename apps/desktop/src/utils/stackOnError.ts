/**
 * The fixed refusals of the backend's `set_parent` (src-tauri/src/stack/meta.rs),
 * mapped to localized keys for StackOnDialog. Any other message (git failure,
 * new refusal) is shown as the backend wrote it.
 */
import type { LocaleKey } from "../locales";

const REFUSALS: Array<[RegExp, LocaleKey]> = [
  [/^A branch cannot be stacked on itself\.$/, "stacks.stackOn.error.self"],
  [/^(\S+) is the trunk and cannot be stacked\.$/, "stacks.stackOn.error.trunkLayer"],
  [/^(\S+) is the trunk: stacking on it is not a stack\. Use Unstack instead\.$/, "stacks.stackOn.error.trunkParent"],
  [/^Unknown local branch: (\S+)$/, "stacks.stackOn.error.unknownBranch"],
  [
    /^(\S+) already has a stacked branch \((\S+)\)\. Stacks are linear for now: stack on \2 instead\.$/,
    "stacks.stackOn.error.hasChild",
  ],
  [/^Stacking (\S+) on (\S+) would create a cycle\.$/, "stacks.stackOn.error.cycle"],
];

/** `{ key, args }` for a known refusal, else null (show `raw`). */
export function stackOnRefusal(raw: string): { key: LocaleKey; args: string[] } | null {
  for (const [re, key] of REFUSALS) {
    const m = re.exec(raw);
    if (m) return { key, args: m.slice(1) };
  }
  return null;
}
