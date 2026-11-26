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
