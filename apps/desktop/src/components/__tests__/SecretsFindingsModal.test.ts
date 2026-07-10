/**
 * SecretsFindingsModal.vue — findings list + per-finding/per-pattern actions.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep), mirroring
 * LlmTracePanel.test.ts / LaunchpadView.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import SecretsFindingsModal from "../SecretsFindingsModal.vue";
import type { SecretFinding } from "@gitwand/core";

const findings: SecretFinding[] = [
  {
    file: "src/config.ts",
    line: 3,
    patternId: "aws_access_key_id",
    severity: "high",
    redactedExcerpt: "AKI…NOP",
  },
  {
    file: "src/blob.ts",
    line: 10,
    patternId: "high_entropy",
    severity: "low",
    redactedExcerpt: "aZ3…3k",
  },
];

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(SecretsFindingsModal, { findings, ...props });
  app.mount(container);
}

beforeEach(() => {
  localStorage.clear(); // ensure default (English) locale
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

describe("SecretsFindingsModal", () => {
  // BaseModal renders its content via <Teleport to="body">, so queries target
  // `document` rather than the local `container` the app was mounted into.

  it("renders one row per finding with file:line and the redacted excerpt", () => {
    mount();
    const rows = document.querySelectorAll(".sfm-item");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("src/config.ts");
    expect(rows[0].textContent).toContain("3");
    expect(rows[0].textContent).toContain("AKI…NOP");
    expect(rows[1].textContent).toContain("src/blob.ts");
    expect(rows[1].textContent).toContain("aZ3…3k");
  });

  it("never renders the raw secret — only the redacted excerpt text is present", () => {
    mount();
    expect(document.body.innerHTML).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("emits dismiss with the finding key when a row's Dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    mount({ onDismiss });
    document.querySelectorAll<HTMLButtonElement>(".sfm-item__dismiss")[0].click();
    expect(onDismiss).toHaveBeenCalledWith("src/config.ts:3:aws_access_key_id");
  });

  it("emits ignore with the patternId when a row's Ignore button is clicked", async () => {
    const onIgnore = vi.fn();
    mount({ onIgnore });
    document.querySelectorAll<HTMLButtonElement>(".sfm-item__ignore")[1].click();
    expect(onIgnore).toHaveBeenCalledWith("high_entropy");
  });

  it("emits commit-anyway when the footer action is clicked", async () => {
    const onCommitAnyway = vi.fn();
    mount({ onCommitAnyway });
    document.querySelector<HTMLButtonElement>(".sfm-footer-commit")!.click();
    expect(onCommitAnyway).toHaveBeenCalled();
  });

  it("emits close when Cancel is clicked", async () => {
    const onClose = vi.fn();
    mount({ onClose });
    document.querySelector<HTMLButtonElement>(".sfm-footer-cancel")!.click();
    expect(onClose).toHaveBeenCalled();
  });
});
