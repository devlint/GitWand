// @vitest-environment jsdom
/**
 * v3.7.0 review-round fix (finding #11): `BaseModal` focus trap, initial
 * focus, and focus restore. Own commit, extra scrutiny: this changes
 * behavior for every modal in the app. Mounted via `h()` so the default
 * slot can carry real focusable content (two buttons), mirroring the
 * `createApp` convention used by `CommitReviewModal.test.ts` /
 * `SecretsFindingsModal.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp, h, type App } from "vue";
import BaseModal from "../BaseModal.vue";

let app: App | null = null;
let container: HTMLElement;
let outsideButton: HTMLButtonElement;

function mount(props: Record<string, unknown> = {}, slotContent?: () => unknown) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render() {
      return h(BaseModal, props, slotContent ? { default: slotContent } : undefined);
    },
  });
  app.mount(container);
}

/** An element outside the modal, focused before mount, to test focus restore. */
function focusOutsideElement() {
  outsideButton = document.createElement("button");
  outsideButton.id = "outside-btn";
  document.body.appendChild(outsideButton);
  outsideButton.focus();
}

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  outsideButton?.remove();
});

function defaultSlotButtons() {
  return [
    h("button", { class: "first-btn" }, "First"),
    h("button", { class: "last-btn" }, "Last"),
  ];
}

describe("BaseModal, focus trap (finding #11)", () => {
  it("focuses the panel on mount by default", async () => {
    focusOutsideElement();
    mount({ title: "T" }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    const panel = document.querySelector(".base-modal");
    expect(document.activeElement).toBe(panel);
  });

  it("does not change focus on mount when autoFocus is false", async () => {
    focusOutsideElement();
    mount({ title: "T", autoFocus: false }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    expect(document.activeElement).toBe(outsideButton);
  });

  it("restores focus to the previously focused element on unmount", async () => {
    focusOutsideElement();
    mount({ title: "T" }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    app?.unmount();
    app = null;

    expect(document.activeElement).toBe(outsideButton);
  });

  it("Tab from the last focusable wraps to the first, with preventDefault called", async () => {
    // hideHeader avoids the header's own close button joining the
    // focusable set, so "first"/"last" unambiguously refer to the two
    // slot buttons.
    mount({ title: "T", hideHeader: true }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    const panel = document.querySelector<HTMLElement>(".base-modal")!;
    const first = document.querySelector<HTMLButtonElement>(".first-btn")!;
    const last = document.querySelector<HTMLButtonElement>(".last-btn")!;
    last.focus();

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    panel.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab from the first focusable wraps to the last, with preventDefault called", async () => {
    mount({ title: "T", hideHeader: true }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    const panel = document.querySelector<HTMLElement>(".base-modal")!;
    const first = document.querySelector<HTMLButtonElement>(".first-btn")!;
    const last = document.querySelector<HTMLButtonElement>(".last-btn")!;
    first.focus();

    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    panel.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(last);
  });

  it("a Tab event with defaultPrevented already true is ignored (the CodeMirror/xterm guard)", async () => {
    mount({ title: "T" }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    const panel = document.querySelector<HTMLElement>(".base-modal")!;
    const first = document.querySelector<HTMLButtonElement>(".first-btn")!;
    const last = document.querySelector<HTMLButtonElement>(".last-btn")!;
    last.focus();

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    event.preventDefault(); // simulates an inner component (CodeMirror/xterm) already handling Tab
    panel.dispatchEvent(event);

    // The trap must not additionally move focus: `last` stays focused.
    expect(document.activeElement).toBe(last);
    void first;
  });

  it("trapFocus: false disables the wrap entirely", async () => {
    mount({ title: "T", trapFocus: false }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    const panel = document.querySelector<HTMLElement>(".base-modal")!;
    const last = document.querySelector<HTMLButtonElement>(".last-btn")!;
    last.focus();

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    panel.dispatchEvent(event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(last);
  });

  it("Escape still emits close, and closable: false still suppresses it (regression guard)", async () => {
    const onClose = vi.fn();
    mount({ title: "T", onClose }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    app?.unmount();
    app = null;
    container?.remove();

    const onCloseNonClosable = vi.fn();
    mount({ title: "T", closable: false, onClose: onCloseNonClosable }, defaultSlotButtons);
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCloseNonClosable).not.toHaveBeenCalled();
  });
});
