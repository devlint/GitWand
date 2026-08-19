/**
 * v3.7.0 review-round fix (finding #12) — `FolderPicker`'s "Select this
 * folder" button silently ignored whatever was typed into the path input
 * unless Enter had already been pressed first: it emitted `select` with
 * `currentPath`, which is only ever written by `fetchDir` (reached via
 * navigate/goUp/goHome/onInputEnter), never by typing alone.
 *
 * Mocks `../../utils/backend` (`listDir`) — jsdom `localStorage` is patched
 * by `src/test-setup.ts`, so `useFolderHistory` works as-is, matching the
 * established convention (`CommitReviewModal.test.ts`, `createApp` mount).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import FolderPicker from "../FolderPicker.vue";

const listDirMock = vi.fn();

vi.mock("../../utils/backend", () => ({
  listDir: (...a: unknown[]) => listDirMock(...a),
}));

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(FolderPicker, props);
  app.mount(container);
}

function dirResult(current: string, overrides: Partial<{ parent: string | null; home: string; dirs: unknown[] }> = {}) {
  return {
    current,
    parent: overrides.parent ?? null,
    home: overrides.home ?? "/home/user",
    dirs: overrides.dirs ?? [],
  };
}

beforeEach(() => {
  localStorage.clear();
  listDirMock.mockReset();
  // Initial onMounted fetchDir() call (home dir, no args).
  listDirMock.mockResolvedValue(dirResult("/home/user"));
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("FolderPicker — select the typed path without requiring Enter (finding #12)", () => {
  it("typing a path and clicking Select (no Enter) resolves it via listDir and emits the resolved path", async () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    await flush();

    listDirMock.mockResolvedValueOnce(dirResult("/typed/resolved/path"));

    const input = document.querySelector<HTMLInputElement>(".fp-path-input")!;
    input.value = "/typed/path";
    input.dispatchEvent(new Event("input"));
    await flush();

    const selectBtn = document.querySelector<HTMLButtonElement>(".fp-btn--select")!;
    selectBtn.click();
    await flush();

    expect(listDirMock).toHaveBeenCalledWith("/typed/path");
    expect(onSelect).toHaveBeenCalledWith("/typed/resolved/path");
  });

  it("listDir rejecting for the typed path emits no select and renders the error", async () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    await flush();

    listDirMock.mockRejectedValueOnce(new Error("no such directory"));

    const input = document.querySelector<HTMLInputElement>(".fp-path-input")!;
    input.value = "/bad/path";
    input.dispatchEvent(new Event("input"));
    await flush();

    const selectBtn = document.querySelector<HTMLButtonElement>(".fp-btn--select")!;
    selectBtn.click();
    await flush();

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("no such directory");
  });

  it("typing nothing and clicking Select emits the current path, with no redundant listDir call", async () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    await flush();

    const callsBeforeClick = listDirMock.mock.calls.length;

    const selectBtn = document.querySelector<HTMLButtonElement>(".fp-btn--select")!;
    selectBtn.click();
    await flush();

    expect(listDirMock.mock.calls.length).toBe(callsBeforeClick); // no new call
    expect(onSelect).toHaveBeenCalledWith("/home/user");
  });

  it("typing a path identical to currentPath causes no redundant listDir call, and still emits", async () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    await flush();

    const input = document.querySelector<HTMLInputElement>(".fp-path-input")!;
    input.value = "/home/user"; // same as currentPath already
    input.dispatchEvent(new Event("input"));
    await flush();

    const callsBeforeClick = listDirMock.mock.calls.length;
    const selectBtn = document.querySelector<HTMLButtonElement>(".fp-btn--select")!;
    selectBtn.click();
    await flush();

    expect(listDirMock.mock.calls.length).toBe(callsBeforeClick);
    expect(onSelect).toHaveBeenCalledWith("/home/user");
  });

  it("pressing Enter in the input still navigates (regression guard)", async () => {
    mount({});
    await flush();

    listDirMock.mockResolvedValueOnce(dirResult("/navigated/path"));

    const input = document.querySelector<HTMLInputElement>(".fp-path-input")!;
    input.value = "/some/path";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    expect(listDirMock).toHaveBeenCalledWith("/some/path");
    // currentPath is now updated to what fetchDir resolved.
    expect(input.value).toBe("/navigated/path");
  });
});
