/** What happens to a dirty working tree when the user pulls. */
export type PullDirtyBehavior = "ask" | "refuse" | "autostash";

/**
 * Decide what to do when the user triggers a pull.
 *
 * - "direct"    → pull as-is (clean tree — `--autostash` would be a no-op anyway).
 * - "autostash" → pull with `--autostash`, no prompt.
 * - "modal"     → confirm first (dirty + ask).
 * - "refuse"    → block with an error (dirty + refuse).
 */
export function resolveDirtyPullAction(
  dirty: boolean,
  behavior: PullDirtyBehavior,
): "direct" | "autostash" | "modal" | "refuse" {
  if (!dirty) return "direct";
  if (behavior === "autostash") return "autostash";
  if (behavior === "refuse") return "refuse";
  return "modal";
}
