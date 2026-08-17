/**
 * Task 1b (v3.7.0) — `CommitReviewModal`: summary + severity-sorted finding
 * list + jump/dismiss/close. Mounted with native `createApp`, mirroring
 * `SecretsFindingsModal.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import CommitReviewModal from "../CommitReviewModal.vue";
import type { ReviewFinding } from "../../composables/usePrPreReview";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    path: "src/a.ts",
    line: 1,
    side: "RIGHT",
    severity: "nit",
    confidence: 50,
    title: "A nit",
    detail: "A nit detail",
    ...overrides,
  };
}

const findings: ReviewFinding[] = [
  finding({ id: "nit-1", severity: "nit", confidence: 90, title: "High-confidence nit" }),
  finding({ id: "risk-1", severity: "risk", confidence: 60, title: "A risk", path: "src/b.ts", line: 5 }),
  finding({ id: "suggestion-1", severity: "suggestion", confidence: 80, title: "A suggestion" }),
];

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(CommitReviewModal, { findings, ...props });
  app.mount(container);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

describe("CommitReviewModal", () => {
  it("renders findings sorted by severity (risk > suggestion > nit), then confidence descending", () => {
    mount();
    const rows = document.querySelectorAll(".crm-item");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("A risk");
    expect(rows[1].textContent).toContain("A suggestion");
    expect(rows[2].textContent).toContain("High-confidence nit");
  });

  it("renders path:line, confidence, title, and detail for each finding", () => {
    mount();
    const rows = document.querySelectorAll(".crm-item");
    expect(rows[0].textContent).toContain("src/b.ts");
    expect(rows[0].textContent).toContain("5");
    expect(rows[0].textContent).toContain("60");
    expect(rows[0].textContent).toContain("A risk");
  });

  it("shows the empty state when there are no findings", () => {
    mount({ findings: [] });
    expect(document.querySelector(".crm-empty")).not.toBeNull();
    expect(document.querySelectorAll(".crm-item").length).toBe(0);
  });

  it("emits jump with the finding's id when Jump to is clicked", () => {
    const onJump = vi.fn();
    mount({ onJump });
    document.querySelectorAll<HTMLButtonElement>(".crm-item__jump")[0].click();
    expect(onJump).toHaveBeenCalledWith("risk-1");
  });

  it("emits dismiss with the finding's id when Dismiss is clicked", () => {
    const onDismiss = vi.fn();
    mount({ onDismiss });
    document.querySelectorAll<HTMLButtonElement>(".crm-item__dismiss")[0].click();
    expect(onDismiss).toHaveBeenCalledWith("risk-1");
  });

  it("emits close when the footer Close action is clicked", () => {
    const onClose = vi.fn();
    mount({ onClose });
    document.querySelector<HTMLButtonElement>(".crm-footer-close")!.click();
    expect(onClose).toHaveBeenCalled();
  });

  // ── Task 3 (v3.7.0) — "Fix with agent" ────────────────────────────────
  // Scope-narrowed for PR2 (deliberate, not a bug fix): manual QA against
  // real claude/codex CLIs found that a brand-new scratch worktree hits a
  // first-run "trust this directory?" onboarding screen that misinterprets
  // the piped prompt as menu navigation (it drove a real `brew upgrade
  // --cask codex` in testing). The scratch-worktree option is removed from
  // this flow until there's a real fix (pre-trusting the directory, or
  // detecting the onboarding screen before writing) — tracked as a roadmap
  // follow-up. "Fix with agent" only ever targets the current repo now.
  describe("Fix with agent", () => {
    it("emits fix-with-agent with only the selected tool — no scratch option", () => {
      const onFixWithAgent = vi.fn();
      mount({ onFixWithAgent });

      const select = document.querySelector<HTMLSelectElement>(".crm-fix-tool")!;
      select.value = "codex";
      select.dispatchEvent(new Event("change"));

      document.querySelector<HTMLButtonElement>(".crm-fix-btn")!.click();

      expect(onFixWithAgent).toHaveBeenCalledWith({ tool: "codex" });
    });

    it("defaults to claude when the tool is left untouched", () => {
      const onFixWithAgent = vi.fn();
      mount({ onFixWithAgent });
      document.querySelector<HTMLButtonElement>(".crm-fix-btn")!.click();
      expect(onFixWithAgent).toHaveBeenCalledWith({ tool: "claude" });
    });

    it("disables the Fix with agent button when there are no findings", () => {
      const onFixWithAgent = vi.fn();
      mount({ findings: [], onFixWithAgent });
      const btn = document.querySelector<HTMLButtonElement>(".crm-fix-btn")!;
      expect(btn.disabled).toBe(true);
      btn.click();
      expect(onFixWithAgent).not.toHaveBeenCalled();
    });

    it("never renders a scratch-worktree checkbox", () => {
      mount();
      expect(document.querySelector(".crm-fix-scratch")).toBeNull();
      expect(document.querySelector(".crm-fix-scratch-label")).toBeNull();
    });
  });

  // ── Task 4 (v3.7.0) — iteration / coverage display ────────────────────
  describe("iteration / coverage display", () => {
    it("shows iter:N and coverage:X% when iterations > 0", () => {
      mount({ iterations: 2, coverage: 87 });
      const el = document.querySelector(".crm-stats");
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("2");
      expect(el!.textContent).toContain("87");
    });

    it("hides the iteration/coverage line before any review has run", () => {
      mount({ iterations: 0, coverage: 0 });
      expect(document.querySelector(".crm-stats")).toBeNull();
    });
  });
});
