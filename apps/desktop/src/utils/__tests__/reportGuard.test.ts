/**
 * reportGuard — the secrets scan a report's body goes through before it can
 * be sent (#301): known secret patterns block a public report, entropy only
 * warns (lockfile hashes would otherwise block every lockfile report).
 */
import { describe, it, expect } from "vitest";
import { scanReportBody } from "../reportGuard";

const opts = { extraPatterns: [], entropyThreshold: 4.0, blockAt: "medium" as const };
const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("scanReportBody", () => {
  it("blocks a known secret, naming its line", () => {
    const r = scanReportBody(`intro\n\ntoken = "${token}"\n`, opts);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].line).toBe(3);
    expect(r.blocking[0].patternId).toBe("github_pat_classic");
  });

  it("only warns when nothing blocks (the repository path)", () => {
    const r = scanReportBody(`token = "${token}"`, { ...opts, blockAt: "never" });
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
  });

  it("only warns on high entropy (a lockfile's integrity hash)", () => {
    const hash = "sha512-" + "Zm9vYmFyYmF6cXV4cXV1eA9xT3+kL0pQ8rW2vY5zN1mH6jC4bD7eF0gA3iK9oU1sR8tE2wQ5yP4lM6nV3xB0cZ7=";
    const r = scanReportBody(`"integrity": "${hash}",`, opts);
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("finds nothing in plain prose", () => {
    expect(scanReportBody("The resolver kept both imports.", opts)).toEqual({ blocking: [], warnings: [] });
  });

  it("applies the repository's extra patterns", () => {
    const r = scanReportBody("id ACME-123456", {
      ...opts,
      extraPatterns: [{ id: "acme", regex: "ACME-[0-9]{6}", severity: "high", description: "ACME id" }],
    });
    expect(r.blocking.map((f) => f.patternId)).toEqual(["acme"]);
  });

  it("still blocks a secret that comes after hundreds of entropy warnings (the scan's finding cap)", () => {
    const hashes = Array.from({ length: 520 }, (_, i) => `"integrity": "sha512-${"Zm9vYmFyYmF6cXV4cXV1eA9xT3kL0pQ8rW2vY5zN1mH6jC4bD7eF0gA3iK9oU1sR8tE2wQ5yP4lM6nV3xB0cZ7" + i}",`);
    const r = scanReportBody([...hashes, `token = "${token}"`].join("\n"), opts);
    expect(r.blocking.map((f) => f.patternId)).toEqual(["github_pat_classic"]);
  });

  it("scans a title given with the body", () => {
    expect(scanReportBody(`Leak ${token}`, opts).blocking).toHaveLength(1);
  });

  it("counts every entropy warning, past the scanner's 500-finding cap", () => {
    const hashes = Array.from({ length: 1200 }, (_, i) => `"integrity": "sha512-${"Zm9vYmFyYmF6cXV4cXV1eA9xT3kL0pQ8rW2vY5zN1mH6jC4bD7eF0gA3iK9oU1sR8tE2wQ5yP4lM6nV3xB0cZ7" + i}",`);
    const r = scanReportBody([...hashes, `token = "${token}"`].join("\n"), opts);
    expect(r.warnings).toHaveLength(1200);
    expect(r.blocking.map((f) => f.line)).toEqual([1201]);
  });

  it("finds a secret right after one line that alone fills the scanner's cap", () => {
    const tok = (i: number) => `Q${i}xT3kL0pQ8rW2vY5zN1mH6jC4bD7eF0gA3`;
    const line = Array.from({ length: 600 }, (_, i) => tok(i)).join(" ");
    const r = scanReportBody([line, `token = "${token}"`].join("\n"), opts);
    expect(r.blocking.map((f) => f.line)).toEqual([2]);
  });
});

