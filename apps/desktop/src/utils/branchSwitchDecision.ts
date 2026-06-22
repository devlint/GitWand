/** The three behaviors a user can set for switching with a dirty working tree. */
export type SwitchBehavior = "ask" | "refuse" | "stash";

/**
 * Decide what to do when the user triggers a branch switch / create.
 *
 * - "direct"  → proceed with the switch/create (clean tree, or stash mode which
 *               the caller handles with its own existing flow).
 * - "modal"   → open the BranchDirtySwitchModal (dirty + ask).
 * - "refuse"  → block with an error (dirty + refuse).
 */
export function resolveDirtySwitchAction(
  dirty: boolean,
  behavior: SwitchBehavior,
): "modal" | "refuse" | "direct" {
  if (!dirty) return "direct";
  if (behavior === "ask") return "modal";
  if (behavior === "refuse") return "refuse";
  return "direct";
}
