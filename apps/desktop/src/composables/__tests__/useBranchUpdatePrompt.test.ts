/**
 * useBranchUpdatePrompt unit tests — post-checkout "Update branch" prompt.
 *
 * computeCheckoutPrompt is a pure decision function; the skip helpers persist
 * to localStorage via loadSettings/saveSettings. Each test clears localStorage
 * before running so there is no bleed-over.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  computeCheckoutPrompt,
  skipUpdatePrompt,
  isUpdatePromptSkipped,
  clearUpdatePromptSkip,
  clearAllUpdatePromptSkips,
} from "../useBranchUpdatePrompt";

const CWD_A = "/repos/alpha";
const CWD_B = "/repos/beta";

// ═════════════════════════════════════════════════════════════════════════════
// computeCheckoutPrompt — decision matrix
// ═════════════════════════════════════════════════════════════════════════════

describe("computeCheckoutPrompt", () => {
  it("behind-only + upstream + not muted → update", () => {
    expect(
      computeCheckoutPrompt({ ahead: 0, behind: 3, hasUpstream: true, skipped: false }),
    ).toBe("update");
  });

  it("behind-only + muted → none", () => {
    expect(
      computeCheckoutPrompt({ ahead: 0, behind: 3, hasUpstream: true, skipped: true }),
    ).toBe("none");
  });

  it("diverged (ahead>0 && behind>0) → genericPull, even when muted", () => {
    expect(
      computeCheckoutPrompt({ ahead: 2, behind: 3, hasUpstream: true, skipped: false }),
    ).toBe("genericPull");
    // The mute only silences the dedicated update prompt, not the generic one.
    expect(
      computeCheckoutPrompt({ ahead: 2, behind: 3, hasUpstream: true, skipped: true }),
    ).toBe("genericPull");
  });

  it("not behind → none (clean, ahead-only)", () => {
    expect(
      computeCheckoutPrompt({ ahead: 0, behind: 0, hasUpstream: true, skipped: false }),
    ).toBe("none");
    expect(
      computeCheckoutPrompt({ ahead: 5, behind: 0, hasUpstream: true, skipped: false }),
    ).toBe("none");
  });

  it("no upstream → none regardless of counters", () => {
    expect(
      computeCheckoutPrompt({ ahead: 0, behind: 3, hasUpstream: false, skipped: false }),
    ).toBe("none");
    expect(
      computeCheckoutPrompt({ ahead: 2, behind: 3, hasUpstream: false, skipped: false }),
    ).toBe("none");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// skip persistence
// ═════════════════════════════════════════════════════════════════════════════

describe("update-prompt skip persistence", () => {
  beforeEach(() => localStorage.clear());

  it("skipUpdatePrompt() mutes the branch; isUpdatePromptSkipped() → true", () => {
    expect(isUpdatePromptSkipped(CWD_A, "feat/x")).toBe(false);
    skipUpdatePrompt(CWD_A, "feat/x");
    expect(isUpdatePromptSkipped(CWD_A, "feat/x")).toBe(true);
  });

  it("mute is scoped per repo", () => {
    skipUpdatePrompt(CWD_A, "feat/x");
    expect(isUpdatePromptSkipped(CWD_B, "feat/x")).toBe(false);
  });

  it("mute is scoped per branch", () => {
    skipUpdatePrompt(CWD_A, "feat/x");
    expect(isUpdatePromptSkipped(CWD_A, "feat/y")).toBe(false);
  });

  it("skip is idempotent (no duplicate entries)", () => {
    skipUpdatePrompt(CWD_A, "feat/x");
    skipUpdatePrompt(CWD_A, "feat/x");
    clearUpdatePromptSkip(CWD_A, "feat/x");
    expect(isUpdatePromptSkipped(CWD_A, "feat/x")).toBe(false);
  });

  it("clearUpdatePromptSkip() un-mutes a single branch only", () => {
    skipUpdatePrompt(CWD_A, "feat/x");
    skipUpdatePrompt(CWD_A, "feat/y");
    clearUpdatePromptSkip(CWD_A, "feat/x");
    expect(isUpdatePromptSkipped(CWD_A, "feat/x")).toBe(false);
    expect(isUpdatePromptSkipped(CWD_A, "feat/y")).toBe(true);
  });

  it("clearUpdatePromptSkip() on a non-muted branch is a no-op", () => {
    expect(() => clearUpdatePromptSkip(CWD_A, "feat/none")).not.toThrow();
    expect(isUpdatePromptSkipped(CWD_A, "feat/none")).toBe(false);
  });

  it("clearAllUpdatePromptSkips() clears every repo", () => {
    skipUpdatePrompt(CWD_A, "feat/x");
    skipUpdatePrompt(CWD_B, "feat/y");
    clearAllUpdatePromptSkips();
    expect(isUpdatePromptSkipped(CWD_A, "feat/x")).toBe(false);
    expect(isUpdatePromptSkipped(CWD_B, "feat/y")).toBe(false);
  });

  it("cwd is normalised (backslashes, trailing slashes)", () => {
    skipUpdatePrompt("C:\\repos\\alpha\\", "feat/x");
    expect(isUpdatePromptSkipped("C:/repos/alpha", "feat/x")).toBe(true);
    skipUpdatePrompt(`${CWD_A}///`, "feat/z");
    expect(isUpdatePromptSkipped(CWD_A, "feat/z")).toBe(true);
  });

  it("defaults to no mutes when settings are absent (migration)", () => {
    expect(isUpdatePromptSkipped(CWD_A, "any")).toBe(false);
  });
});
