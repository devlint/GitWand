import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

const ghPrAttachmentUrls = vi.fn();
vi.mock("../../utils/backend", () => ({ ghPrAttachmentUrls: (...a: unknown[]) => ghPrAttachmentUrls(...a) }));

import { usePrAttachments } from "../usePrAttachments";

// No mockReset: config `clearMocks` resets calls, and each test sets its own implementation.

const A = "e56beadb-c31a-4dee-bcd2-973dae719016";
const B = "11111111-2222-3333-4444-555555555555";
const md = (uuid: string) => `![x](https://github.com/user-attachments/assets/${uuid})`;
const asset = (uuid: string) => `https://github.com/user-attachments/assets/${uuid}`;

/** A signed URL valid for five minutes; `tag` makes successive ones differ. */
function signed(uuid: string, tag = 1): string {
  const payload = btoa(JSON.stringify({ nbf: 1000 * tag, exp: 1000 * tag + 300 })).replace(/=+$/, "");
  return `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=h.${payload}.s`;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  scopes.splice(0).forEach((s) => s.stop());
  vi.useRealTimers();
});

function setup(bodies: string[], enabled = true) {
  let clock = 1_000_000;
  const state = {
    cwd: ref("/repo"),
    number: ref<number | null>(7),
    enabled: ref(enabled),
    bodies: ref<string[]>(bodies),
  };
  const scope = effectScope();
  scopes.push(scope);
  const api = scope.run(() => usePrAttachments({ ...state, now: () => clock }))!;
  return { ...state, ...api, tick: (ms: number) => (clock += ms) };
}

describe("usePrAttachments", () => {
  it("fetches once the bodies reference an attachment, then resolves it", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const s = setup([md(A), "no image"]);
    expect(ghPrAttachmentUrls).toHaveBeenCalledWith("/repo", 7);
    await flush();
    expect(s.resolveImage(asset(A))).toBe(signed(A));
    expect(s.resolveImage("https://example.com/x.png")).toBeNull();
  });

  it("does nothing without attachments or on another forge", () => {
    setup(["plain text"]);
    setup([md(A)], false);
    expect(ghPrAttachmentUrls).not.toHaveBeenCalled();
  });

  it("refetches for a new attachment, not for one GitHub already left out", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const s = setup([md(A), md(B)]); // B is not returned (say, past the first page)
    await flush();
    s.bodies.value = [md(A), md(B), "edited"];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    const C = "99999999-2222-3333-4444-555555555555";
    ghPrAttachmentUrls.mockResolvedValue([signed(A), signed(C)]);
    s.bodies.value = [md(A), md(B), md(C)];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(C))).toBe(signed(C));
  });

  it("refreshes before expiry, keeping the old URL until the new one lands", async () => {
    vi.useFakeTimers();
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 1)]);
    const s = setup([md(A)]);
    await flush();
    let answer!: (v: string[]) => void;
    ghPrAttachmentUrls.mockReturnValueOnce(new Promise((r) => (answer = r)));
    s.tick(270_000);
    vi.advanceTimersByTime(270_000); // 300 s lifetime − 30 s margin
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(A))).toBe(signed(A, 1));
    answer([signed(A, 2)]);
    await flush();
    expect(s.resolveImage(asset(A))).toBe(signed(A, 2));
  });

  it("holds the refresh while the window is hidden", async () => {
    vi.useFakeTimers();
    const doc = { hidden: true, listeners: [] as (() => void)[] };
    vi.stubGlobal("document", {
      get hidden() {
        return doc.hidden;
      },
      addEventListener: (_: string, f: () => void) => doc.listeners.push(f),
      removeEventListener: () => {},
    });
    try {
      ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
      const s = setup([md(A)]);
      await flush();
      s.tick(270_000);
      vi.advanceTimersByTime(270_000);
      expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
      doc.hidden = false;
      doc.listeners.forEach((f) => f());
      expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the original URL on failure and does not retry right away", async () => {
    ghPrAttachmentUrls.mockImplementation(async () => {
      throw new Error("no token");
    });
    const s = setup([md(A)]);
    await flush();
    expect(s.resolveImage(asset(A))).toBeNull();
    s.bodies.value = [md(A), md(B)];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    s.tick(31_000);
    s.bodies.value = [md(B)];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
  });

  it("drops a late answer for the previous PR and then fetches the new one's", async () => {
    let answer!: (v: string[]) => void;
    ghPrAttachmentUrls.mockReturnValueOnce(new Promise((r) => (answer = r)));
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 3)]);
    const s = setup([md(A)]);
    s.number.value = 8;
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1); // #8 waits for #7's fetch
    answer([signed(A, 1)]);
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenLastCalledWith("/repo", 8);
    expect(s.resolveImage(asset(A))).toBe(signed(A, 3));
  });
});
