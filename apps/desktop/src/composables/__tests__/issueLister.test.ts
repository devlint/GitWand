/**
 * issueListerFor (#301, part 4): which remotes get the `#` issue list.
 */
import { describe, it, expect, vi } from "vitest";
import type { RemoteInfo } from "../../utils/backend";

const listIssues = vi.fn(async () => []);
const forges: Record<string, object> = { github: { listIssues }, azure: {} };
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn((info: { provider: string }) => forges[info.provider] ?? { listIssues }),
}));

import { issueListerFor } from "../issueLister";

const info = (provider: RemoteInfo["provider"]): RemoteInfo => ({ name: "origin", url: "u", provider, owner: "o", repo: "r" });

describe("issueListerFor", () => {
  it("no list without a remote", () => expect(issueListerFor(null, "/r")).toBeNull());
  it("no list for a remote of no known forge (never falls back to GitHub)", () =>
    expect(issueListerFor(info("unknown"), "/r")).toBeNull());
  it("no list for a forge that cannot list issues", () => expect(issueListerFor(info("azure"), "/r")).toBeNull());
  it("lists through the forge otherwise, 100 at most", async () => {
    await issueListerFor(info("github"), "/r");
    expect(listIssues).toHaveBeenCalledWith("/r", { limit: 100 });
  });
});
