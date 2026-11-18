/**
 * useAcceptedReports — accepted proposals kept reportable for the session
 * (#301): listed only once the write landed, and only for the resolution the
 * user actually accepted.
 */
import { describe, it, expect } from "vitest";
import { useAcceptedReports } from "../useAcceptedReports";
import type { ResolutionReport } from "../../utils/resolutionReport";

const r = (path: string) => ({ kind: "engine", path, hunk: {}, resolvedLines: [] }) as unknown as ResolutionReport;

describe("useAcceptedReports", () => {
  it("lists an accepted proposal once its write landed", () => {
    const a = useAcceptedReports();
    a.resolving(2, r("a"));
    expect(a.list.value).toHaveLength(0);
    a.landed(2);
    expect(a.list.value.map((x) => x.path)).toEqual(["a"]);
  });

  it("forgets a proposal whose write did not land before another resolution", () => {
    const a = useAcceptedReports();
    a.resolving(2, r("engine"));
    // The write was refused; the user then picks "ours" for the same hunk.
    a.resolving(2, null);
    a.landed(2);
    expect(a.list.value).toHaveLength(0);
  });

  it("does not list it when another hunk went", () => {
    const a = useAcceptedReports();
    a.resolving(2, r("a"));
    a.landed(1);
    expect(a.list.value).toHaveLength(0);
  });

  it("a reparse that is not a single landed write drops the pending copy", () => {
    const a = useAcceptedReports();
    a.resolving(2, r("a"));
    a.landed(null);
    a.landed(2);
    expect(a.list.value).toHaveLength(0);
  });

  it("clear empties the list and the pending copy", () => {
    const a = useAcceptedReports();
    a.resolving(0, r("a"));
    a.landed(0);
    a.resolving(1, r("b"));
    a.clear();
    a.landed(1);
    expect(a.list.value).toHaveLength(0);
  });
});
