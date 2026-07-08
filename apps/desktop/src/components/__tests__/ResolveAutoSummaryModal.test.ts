/**
 * ResolveAutoSummaryModal.vue — confirmation before "Résoudre auto" applies
 * every auto-resolved hunk in a file.
 *
 * BaseModal renders via `<Teleport to="body">`, so assertions query
 * `document.body`, not the mount container (which stays empty).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import ResolveAutoSummaryModal from "../ResolveAutoSummaryModal.vue";

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(ResolveAutoSummaryModal, {
    resolutions: [
      { hunkIndex: 0, resolvedLines: ["line1-changed", "line2-changed"] },
      { hunkIndex: 2, resolvedLines: ["foo = 2"] },
    ],
    ...props,
  });
  app.mount(container);
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { app?.unmount(); app = null; container?.remove(); });

describe("ResolveAutoSummaryModal", () => {
  it("liste chaque résolution avec son contenu", () => {
    mount({});
    expect(document.body.textContent).toContain("line1-changed");
    expect(document.body.textContent).toContain("foo = 2");
  });

  it("affiche le nombre de conflits dans le titre/corps", () => {
    mount({});
    expect(document.body.textContent).toContain("2");
  });

  it("émet confirm au clic sur Confirmer", async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    document.body.querySelector<HTMLButtonElement>(".bm-btn--primary")!.click();
    await nextTick();
    expect(onConfirm).toHaveBeenCalled();
  });

  it("émet cancel au clic sur Annuler", async () => {
    const onCancel = vi.fn();
    mount({ onCancel });
    document.body.querySelector<HTMLButtonElement>(".bm-btn--ghost")!.click();
    await nextTick();
    expect(onCancel).toHaveBeenCalled();
  });
});
