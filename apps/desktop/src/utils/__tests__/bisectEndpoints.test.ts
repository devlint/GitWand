import { describe, it, expect } from "vitest";
import { bisectEndpoints } from "../bisectEndpoints";

// Log order: newest first, as the Git Tree shows it.
const log = ["h1", "h2", "h3", "h4"];

describe("bisectEndpoints", () => {
  it("makes the older commit good and the newer bad, whatever the selection order", () => {
    expect(bisectEndpoints(["h3", "h1"], log)).toEqual({ good: "h3", bad: "h1" });
    expect(bisectEndpoints(["h1", "h3"], log)).toEqual({ good: "h3", bad: "h1" });
  });

  it("needs exactly two commits of the loaded log", () => {
    expect(bisectEndpoints(["h1"], log)).toBeNull();
    expect(bisectEndpoints(["h1", "h2", "h3"], log)).toBeNull();
    expect(bisectEndpoints(["h1", "zz"], log)).toBeNull();
    expect(bisectEndpoints(["h2", "h2"], log)).toBeNull();
  });
});

import { inLoadedHistoryOf } from "../bisectEndpoints";

describe("inLoadedHistoryOf", () => {
  // h1 -> h2 -> h3 (main); s1 -> h3 (side branch off h3); h3's parent is not loaded.
  const log = [
    { hashFull: "h1", parents: ["h2"] },
    { hashFull: "s1", parents: ["h3"] },
    { hashFull: "h2", parents: ["h3"] },
    { hashFull: "h3", parents: ["h0"] },
  ];

  it("finds an ancestor through loaded parents", () => {
    expect(inLoadedHistoryOf(log, "h3", "h1")).toBe(true);
  });

  it("says no when the whole history down to the log's end lacks it", () => {
    expect(inLoadedHistoryOf(log.slice(0, 3).concat([{ hashFull: "h3", parents: [] }]), "s1", "h1")).toBe(false);
  });

  it("does not know when the walk leaves the loaded log", () => {
    expect(inLoadedHistoryOf(log, "s1", "h1")).toBeNull();
  });
});
