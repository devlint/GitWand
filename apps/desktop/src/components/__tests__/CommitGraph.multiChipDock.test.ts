/**
 * CommitGraph.vue — the multi-selection chip (v3.15) is pinned at the bottom
 * of the graph, where the floating AppDock sits. QA found it under the dock,
 * its "Combined diff" button unclickable. It clears the dock the way
 * UndoToast does: from the dock's own offset and height (`--app-dock-height`,
 * assets/main.css), so a change to either moves the chip with it. jsdom does
 * no layout, so this pins the rule itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const graph = readFileSync(resolve(__dirname, "../CommitGraph.vue"), "utf-8");
const toast = readFileSync(resolve(__dirname, "../UndoToast.vue"), "utf-8");

function bottomOf(src: string, selector: string): string {
  const rule = src.match(new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`));
  expect(rule, `${selector} rule`).not.toBeNull();
  const bottom = rule![1].match(/\n\s*bottom:\s*([^;]+);/);
  expect(bottom, `${selector} bottom`).not.toBeNull();
  return bottom![1].trim();
}

describe("CommitGraph — multi-selection chip vs the dock", () => {
  it("sits above the dock, derived from the dock's offset and height", () => {
    const chip = bottomOf(graph, ".cg-multi-chip");
    expect(chip).toContain("var(--app-dock-height");
    expect(chip).toContain("var(--space-4");
  });

  it("clears the dock by the same rule as the undo toast", () => {
    expect(bottomOf(graph, ".cg-multi-chip")).toBe(bottomOf(toast, ".undo-toast"));
  });
});
