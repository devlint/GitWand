/**
 * The store against the real stack service (the dev-server mirror of the
 * Rust backend, `dev-stack-service.mjs`, parity-tested against it) on a real
 * temp repo — wave 3, item 7. The backend clears a pending record when it
 * reports it `finalized`, so a later report never carries it again: a failed
 * after-restack handling must be retried from the store's own memory.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { rmSync } from "node:fs";
// @ts-expect-error — plain .mjs module, no type declarations
import { devStackStatus, devStackRestackPlan, devGitRestack } from "../../../dev-stack-service.mjs";
// @ts-expect-error — plain .mjs module, no type declarations
import { fixtureStack } from "../../../tests/parity/fixtures.mjs";
import { createStacks, preloadStacksFlow, registerRestackHost, type StacksDeps } from "../useStacks";
import type { RestackPlan, StackReport } from "../../utils/backend";

let cwd: string | null = null;

beforeAll(() => preloadStacksFlow());

afterEach(() => {
  registerRestackHost(null);
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = null;
});

function store(repo: string) {
  const deps = {
    status: vi.fn(async (c: string, t: string | null, h: never[]) => devStackStatus(c, t, h) as StackReport),
    setParent: vi.fn(),
    unset: vi.fn(),
    plan: vi.fn(),
    fetch: vi.fn(),
    branchPr: vi.fn(async () => null),
    setPrBase: vi.fn(),
    pushBranch: vi.fn(),
    deleteMergedParent: vi.fn(),
    forge: () => "gitlab",
    trunkSetting: () => "main",
    dismissed: () => [],
    dismiss: vi.fn(),
    now: () => 0,
  } as unknown as StacksDeps;
  const s = createStacks(deps);
  s.setContext({ cwd: repo, forge: "gitlab", currentBranch: "step-3", localBranches: [], prs: [] });
  return s;
}

describe("useStacks against the real stack service (wave 3, item 7)", () => {
  it("retries a failed after-restack handling, though the backend reports the finalization only once", async () => {
    cwd = fixtureStack("moved") as string;
    const p = devStackRestackPlan(cwd, "step-2", "main", []) as RestackPlan;
    const previewed = {
      onto_sha: p.onto_sha,
      upstream_sha: p.upstream_sha,
      top_sha: p.top_sha,
      moving: p.moving.map((m) => m.branch),
    };
    expect(devGitRestack(cwd, "step-2", "main", [], previewed)).toEqual({ conflict: false });

    const offerPush = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("toast failed");
      })
      .mockImplementation(() => {});
    const notify = vi.fn();
    registerRestackHost({ apply: vi.fn(), offerPush, notify });
    const s = store(cwd);

    await s.refresh(cwd);
    expect(notify).toHaveBeenCalledWith("toast failed");
    // The real backend: the record is gone, the next report has nothing.
    expect((devStackStatus(cwd, "main", []) as StackReport).finalized).toBeNull();

    await s.refresh(cwd);
    expect(offerPush).toHaveBeenCalledTimes(2);
    expect(s.after.value?.finalized).toMatchObject({ moment: "parent_moved", bottom: "step-2", moved: ["step-2", "step-3"] });
    // Handled: a third refresh does not offer again.
    await s.refresh(cwd);
    expect(offerPush).toHaveBeenCalledTimes(2);
    // Every step spawns git synchronously: under heavy load (the Rust suite
    // running alongside) this took 35 s, so 30 s was not enough.
  }, 60_000);
});
