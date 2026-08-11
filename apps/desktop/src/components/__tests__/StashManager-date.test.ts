/**
 * Issue #151 — every stash rendered its date as the literal "Invalid Date".
 *
 * The backend half of the fix (strict ISO 8601 from git) lives in
 * ops.rs / dev-server.mjs; this guards the view half: a strict ISO date must
 * render as a real localized date, and an unparseable one must fall back to the
 * raw string instead of "Invalid Date". `formatDate`'s old `try/catch` could
 * never fire because `new Date("garbage")` returns an Invalid Date object
 * rather than throwing.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep), mirroring
 * SecretsFindingsModal.test.ts. `globalThis.fetch` is stubbed because the
 * component loads its list through the dev-server HTTP route when not running
 * under Tauri — the git layer itself is covered by the Rust + parity tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import StashManager from "../StashManager.vue";
import type { StashEntry } from "../../utils/backend";

let app: App | null = null;
let container: HTMLElement;

function entry(date: string): StashEntry {
  return { index: 0, message: "wip on parser", branch: "main", date, hash: "a710d79" };
}

/** Resolve /api/git-stash-list with `entries`; 200 + [] for anything else. */
function stubFetch(entries: StashEntry[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/git-stash-list") ? entries : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** Mount and let `onMounted` → loadStashes() → fetch settle. */
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(StashManager, { cwd: "/tmp/repo" });
  app.mount(container);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function renderedDate(): string {
  // BaseModal teleports to body, so query the document.
  const el = document.querySelector(".sm-date");
  expect(el, "the stash row must render a .sm-date span").not.toBeNull();
  return el!.textContent!.trim();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  vi.restoreAllMocks();
});

describe("StashManager — date rendering (#151)", () => {
  it("renders a real formatted date for a strict ISO 8601 value", async () => {
    stubFetch([entry("2026-08-11T09:16:44+02:00")]);
    await mount();

    const text = renderedDate();
    expect(text).not.toBe("Invalid Date");
    expect(text).not.toContain("NaN");
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders a real formatted date for a UTC value spelled with Z", async () => {
    // git's iso-strict emits a bare `Z` (not `+00:00`) for UTC commits.
    stubFetch([entry("2024-01-01T00:00:02Z")]);
    await mount();

    expect(renderedDate()).not.toBe("Invalid Date");
  });

  it("falls back to the raw string when the date is unparseable", async () => {
    stubFetch([entry("not-a-date")]);
    await mount();

    expect(renderedDate()).toBe("not-a-date");
  });
});
