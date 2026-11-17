import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

const ghPrAttachmentUrls = vi.fn();
vi.mock("../../utils/backend", () => ({ ghPrAttachmentUrls: (...a: unknown[]) => ghPrAttachmentUrls(...a) }));

import { usePrAttachments } from "../usePrAttachments";

const A = "e56beadb-c31a-4dee-bcd2-973dae719016";
const B = "11111111-2222-3333-4444-555555555555";
const md = (uuid: string) => `![x](https://github.com/user-attachments/assets/${uuid})`;
const asset = (uuid: string) => `https://github.com/user-attachments/assets/${uuid}`;

function signed(uuid: string, expSec: number): string {
  const payload = btoa(JSON.stringify({ exp: expSec })).replace(/=+$/, "");
  return `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=h.${payload}.s`;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};

function setup(bodies: string[], enabled = true) {
  let clock = 1_000_000;
  const state = {
    cwd: ref("/repo"),
    number: ref<number | null>(7),
    enabled: ref(enabled),
    bodies: ref<string[]>(bodies),
  };
  const api = usePrAttachments({ ...state, now: () => clock });
  return { ...state, ...api, tick: (ms: number) => (clock += ms) };
}

// No mockReset: config `clearMocks` resets calls, and each test sets its own implementation.

describe("usePrAttachments", () => {
  it("fetches once the bodies reference an attachment, then resolves it", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 2_000)]);
    const s = setup([md(A), "no image"]);
    expect(ghPrAttachmentUrls).toHaveBeenCalledWith("/repo", 7);
    await flush();
    expect(s.resolveImage(asset(A))).toBe(signed(A, 2_000));
    expect(s.resolveImage("https://example.com/x.png")).toBeNull();
  });

  it("does nothing without attachments or on another forge", () => {
    setup(["plain text"]);
    setup([md(A)], false);
    expect(ghPrAttachmentUrls).not.toHaveBeenCalled();
  });

  it("refetches when a new attachment appears, not for known ones", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 2_000)]);
    const s = setup([md(A)]);
    await flush();
    s.bodies.value = [md(A), "edited"];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 2_000), signed(B, 2_000)]);
    s.bodies.value = [md(A), md(B)];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(B))).toBe(signed(B, 2_000));
  });

  it("does not use an expired URL and fetches fresh ones", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 1_100)]); // expires at 1_100_000 ms
    const s = setup([md(A)]);
    await flush();
    s.tick(200_000);
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 2_000)]);
    expect(s.resolveImage(asset(A))).toBeNull();
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(A))).toBe(signed(A, 2_000));
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

  it("drops a late answer for the previous PR", async () => {
    let answer!: (v: string[]) => void;
    ghPrAttachmentUrls.mockReturnValueOnce(new Promise((r) => (answer = r)));
    ghPrAttachmentUrls.mockResolvedValue([]);
    const s = setup([md(A)]);
    s.number.value = 8;
    await flush();
    answer([signed(A, 2_000)]);
    await flush();
    expect(s.resolveImage(asset(A))).toBeNull();
  });
});
