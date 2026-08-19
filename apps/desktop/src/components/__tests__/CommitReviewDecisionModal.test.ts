/**
 * Task 5 (v3.7.0) — `CommitReviewDecisionModal`: Review now / Vouch
 * personally / Skip, at commit time. Mounted with native `createApp`,
 * mirroring `CommitReviewModal.test.ts`. No custom keyboard shortcuts are
 * added here — `BaseModal` already maps Escape/backdrop to `close`, which
 * this component treats as "cancel the commit" (decision D8).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import CommitReviewDecisionModal from "../CommitReviewDecisionModal.vue";

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(CommitReviewDecisionModal, {
    findingsCount: 2,
    iterations: 1,
    coverage: 60,
    ...props,
  });
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

describe("CommitReviewDecisionModal", () => {
  it("renders the current findings/iteration/coverage context", () => {
    mount({ findingsCount: 3, iterations: 2, coverage: 75 });
    // BaseModal teleports its content to <body>, so assert against
    // document.body rather than the (now-empty) mount container.
    expect(document.body.textContent).toContain("3");
    expect(document.body.textContent).toContain("2");
    expect(document.body.textContent).toContain("75");
  });

  it("emits review-now when Review now is clicked", () => {
    const onReviewNow = vi.fn();
    mount({ onReviewNow });
    document.querySelector<HTMLButtonElement>(".crdm-review-now")!.click();
    expect(onReviewNow).toHaveBeenCalled();
  });

  it("emits vouch when Vouch personally is clicked", () => {
    const onVouch = vi.fn();
    mount({ onVouch });
    document.querySelector<HTMLButtonElement>(".crdm-vouch")!.click();
    expect(onVouch).toHaveBeenCalled();
  });

  it("emits skip when Skip is clicked", () => {
    const onSkip = vi.fn();
    mount({ onSkip });
    document.querySelector<HTMLButtonElement>(".crdm-skip")!.click();
    expect(onSkip).toHaveBeenCalled();
  });

  it("emits close (not skip, not vouch) when the footer Cancel is clicked", () => {
    const onClose = vi.fn();
    const onSkip = vi.fn();
    const onVouch = vi.fn();
    mount({ onClose, onSkip, onVouch });
    document.querySelector<HTMLButtonElement>(".crdm-cancel")!.click();
    expect(onClose).toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(onVouch).not.toHaveBeenCalled();
  });

  it("the three actions emit distinct events — no click accidentally triggers two", () => {
    const onReviewNow = vi.fn();
    const onVouch = vi.fn();
    const onSkip = vi.fn();
    mount({ onReviewNow, onVouch, onSkip });
    document.querySelector<HTMLButtonElement>(".crdm-vouch")!.click();
    expect(onVouch).toHaveBeenCalledTimes(1);
    expect(onReviewNow).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  // v3.7.0 review-round fix (finding #5): distinguish not-reviewed from
  // reviewed-clean from "N findings", instead of always rendering the
  // "{0} finding(s)" string (which read "0 finding(s)" identically whether a
  // review ran and found nothing, or no review ever ran at all).
  describe("context copy (finding #5)", () => {
    it("iterations: 0, findingsCount: 0 renders the not-reviewed string, not the '0 finding(s)' string", () => {
      mount({ iterations: 0, findingsCount: 0 });
      expect(document.body.textContent).toContain("not been reviewed");
      expect(document.body.textContent).not.toContain("0 finding");
    });

    it("iterations: 2, findingsCount: 0 renders the reviewed-clean string", () => {
      mount({ iterations: 2, findingsCount: 0 });
      expect(document.body.textContent).toContain("Reviewed, no findings");
    });

    it("iterations: 2, findingsCount: 3 renders the count string plus the iterations/coverage chips", () => {
      mount({ iterations: 2, findingsCount: 3, coverage: 80 });
      expect(document.body.textContent).toContain("3");
      expect(document.body.textContent).toContain("Iteration 2");
      expect(document.body.textContent).toContain("80");
    });

    it("riskCount: 2 renders the warning line; riskCount: 0 does not", () => {
      mount({ riskCount: 2 });
      expect(document.body.textContent).toContain("2");
      expect(document.body.textContent).toContain("unresolved risk");

      app?.unmount();
      container?.remove();
      mount({ riskCount: 0 });
      expect(document.body.textContent).not.toContain("unresolved risk");
    });

    it("the three actions still emit their events and close still carries no decision, with riskCount set", () => {
      const onReviewNow = vi.fn();
      const onVouch = vi.fn();
      const onSkip = vi.fn();
      const onClose = vi.fn();
      mount({ riskCount: 3, onReviewNow, onVouch, onSkip, onClose });
      document.querySelector<HTMLButtonElement>(".crdm-cancel")!.click();
      expect(onClose).toHaveBeenCalled();
      expect(onVouch).not.toHaveBeenCalled();
      expect(onSkip).not.toHaveBeenCalled();
      expect(onReviewNow).not.toHaveBeenCalled();
    });
  });
});
