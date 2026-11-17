import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

const ghPrAttachmentUrls = vi.fn();
vi.mock("../../utils/backend", () => ({ ghPrAttachmentUrls: (...a: unknown[]) => ghPrAttachmentUrls(...a) }));

import { _resetSigningRepos, usePrAttachments } from "../usePrAttachments";

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

/** The `error` event of an `<img>` showing `src`. */
const imgError = (src: string) =>
  ({ target: { tagName: "IMG", getAttribute: (n: string) => (n === "src" ? src : null) } }) as unknown as Event;

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await nextTick();
};

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  scopes.splice(0).forEach((s) => s.stop());
  _resetSigningRepos();
  vi.useRealTimers();
});

function setup(bodies: string[], { enabled = true, cwd = "/repo" } = {}) {
  let clock = 1_000_000;
  const state = {
    cwd: ref(cwd),
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
  it("fetches nothing while attachment images load (public repository)", async () => {
    const s = setup([md(A)]);
    await flush();
    expect(ghPrAttachmentUrls).not.toHaveBeenCalled();
    expect(s.resolveImage(asset(A))).toBeNull();
  });

  it("fetches when an attachment image fails, then resolves it", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const s = setup([md(A), "no image"]);
    s.onImageError(imgError(asset(A)));
    expect(ghPrAttachmentUrls).toHaveBeenCalledWith("/repo", 7);
    await flush();
    expect(s.resolveImage(asset(A))).toBe(signed(A));
    expect(s.resolveImage("https://example.com/x.png")).toBeNull();
  });

  it("ignores other images, and attachments on another forge", async () => {
    const s = setup([md(A)]);
    s.onImageError(imgError("https://example.com/x.png"));
    const other = setup([md(A)], { enabled: false });
    other.onImageError(imgError(asset(A)));
    await flush();
    expect(ghPrAttachmentUrls).not.toHaveBeenCalled();
  });

  it("fetches up front for the next PR of a repository that needed it", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const first = setup([md(A)]);
    first.onImageError(imgError(asset(A)));
    await flush();
    const next = setup([md(B)]);
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    await flush();
    // …but not for another repository.
    setup([md(B)], { cwd: "/public" });
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    void next;
  });

  it("fetches for a new attachment, not for one GitHub already left out", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const s = setup([md(A), md(B)]); // B is not returned (say, past the first page)
    s.onImageError(imgError(asset(A)));
    await flush();
    s.bodies.value = [md(A), md(B), "edited"];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    const C = "99999999-2222-3333-4444-555555555555";
    ghPrAttachmentUrls.mockResolvedValue([signed(C)]);
    s.bodies.value = [md(A), md(B), md(C)];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(C))).toBe(signed(C));
    // Merged: A keeps the URL it had though this answer left it out.
    expect(s.resolveImage(asset(A))).toBe(signed(A));
  });

  it("picks up a body that changed while a fetch ran", async () => {
    let answer!: (v: string[]) => void;
    ghPrAttachmentUrls.mockReturnValueOnce(new Promise((r) => (answer = r)));
    ghPrAttachmentUrls.mockResolvedValue([signed(B)]);
    const s = setup([md(A)]);
    s.onImageError(imgError(asset(A)));
    s.bodies.value = [md(A), md(B)];
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    answer([signed(A)]);
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(B))).toBe(signed(B));
  });

  it("refreshes an expired URL on render, keeping it until the new one lands", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 1)]);
    const s = setup([md(A)]);
    s.onImageError(imgError(asset(A)));
    await flush();
    s.tick(300_000);
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 2)]);
    expect(s.resolveImage(asset(A))).toBe(signed(A, 1));
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    expect(s.resolveImage(asset(A))).toBe(signed(A, 2));
  });

  it("does not loop on images that keep failing", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const s = setup([md(A)]);
    s.onImageError(imgError(asset(A)));
    await flush();
    s.onImageError(imgError(signed(A)));
    s.onImageError(imgError(signed(A)));
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    s.tick(31_000);
    s.onImageError(imgError(signed(A)));
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
  });

  it("keeps the original URL on failure and waits before trying again", async () => {
    ghPrAttachmentUrls.mockImplementation(async () => {
      throw new Error("no token");
    });
    const s = setup([md(A)]);
    s.onImageError(imgError(asset(A)));
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
    s.onImageError(imgError(asset(A)));
    s.number.value = 8;
    await flush();
    s.onImageError(imgError(asset(A))); // #8's image fails too
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1); // #8 waits for #7's fetch
    answer([signed(A, 1)]);
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenLastCalledWith("/repo", 8);
    expect(s.resolveImage(asset(A))).toBe(signed(A, 3));
  });

  it("retries a failed fetch once, after the gap", async () => {
    vi.useFakeTimers();
    ghPrAttachmentUrls.mockImplementationOnce(async () => {
      throw new Error("502");
    });
    ghPrAttachmentUrls.mockResolvedValue([signed(A)]);
    const s = setup([md(A)]);
    s.onImageError(imgError(asset(A)));
    await flush();
    s.tick(30_000);
    vi.advanceTimersByTime(30_000);
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
    await flush();
    expect(s.resolveImage(asset(A))).toBe(signed(A));
  });

  it("does not mark a repository whose failed file GitHub did not sign (deleted, public)", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(B)]);
    const s = setup([md(A), md(B)]);
    s.onImageError(imgError(asset(A)));
    await flush();
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    setup([md(B)]); // another PR of the same repository
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(1);
    // An expired signed URL failing is not a sign either.
    s.tick(31_000);
    s.onImageError(imgError(signed(B)));
    await flush();
    setup([md(B)]);
    expect(ghPrAttachmentUrls).toHaveBeenCalledTimes(2);
  });

  it("gives the full-screen viewer the current signed URL", async () => {
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 1)]);
    const s = setup([md(A)]);
    s.onImageError(imgError(asset(A)));
    await flush();
    s.tick(300_000);
    ghPrAttachmentUrls.mockResolvedValue([signed(A, 2)]);
    s.onImageError(imgError(signed(A, 1)));
    await flush();
    expect(s.currentUrl(signed(A, 1))).toBe(signed(A, 2));
    expect(s.currentUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
  });
});
