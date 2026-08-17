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
});
