import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/backend", () => ({
  scanSecrets: vi.fn(),
  readGitwandrc: vi.fn(async () => ""),
  writeGitwandrc: vi.fn(async () => {}),
}));

import { scanSecrets, readGitwandrc, writeGitwandrc, type SecretFinding } from "@/utils/backend";
import { useSecretsScanner } from "../useSecretsScanner";

const SETTINGS = { secretsScannerEnabled: true, secretsEntropyThreshold: 4.0 };

function finding(overrides: Partial<SecretFinding> = {}): SecretFinding {
  return {
    file: "src/config.ts",
    line: 1,
    patternId: "aws_access_key_id",
    severity: "high",
    redactedExcerpt: "AKI…NOP",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(scanSecrets).mockReset();
  vi.mocked(readGitwandrc).mockReset().mockResolvedValue("");
  vi.mocked(writeGitwandrc).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSecretsScanner", () => {
  it("scan() populates findings after the debounce elapses", async () => {
    vi.mocked(scanSecrets).mockResolvedValue([finding()]);
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    expect(scanner.findings.value).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);

    expect(scanSecrets).toHaveBeenCalledTimes(1);
    expect(scanSecrets).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ enabled: true, entropyThreshold: 4.0 }),
    );
    expect(scanner.findings.value).toEqual([finding()]);
    expect(scanner.activeFindings.value).toEqual([finding()]);
  });

  it("disabled config (app setting) skips the scanSecrets IPC call entirely", async () => {
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", { ...SETTINGS, secretsScannerEnabled: false });
    await vi.advanceTimersByTimeAsync(100);

    expect(scanSecrets).not.toHaveBeenCalled();
    expect(scanner.findings.value).toEqual([]);
  });

  it("disabled config (.gitwandrc secrets.enabled: false) overrides the app setting and skips the call", async () => {
    vi.mocked(readGitwandrc).mockResolvedValue(JSON.stringify({ secrets: { enabled: false } }));
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(100);

    expect(scanSecrets).not.toHaveBeenCalled();
  });

  it("debounces rapid calls into a single scanSecrets invocation", async () => {
    vi.mocked(scanSecrets).mockResolvedValue([finding()]);
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(30);
    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(30);
    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(100);

    expect(scanSecrets).toHaveBeenCalledTimes(1);
  });

  it("dismiss(findingKey) removes a finding from activeFindings without clearing findings", async () => {
    const f1 = finding({ file: "a.ts", line: 1, patternId: "aws_access_key_id" });
    const f2 = finding({ file: "b.ts", line: 2, patternId: "github_pat_classic" });
    vi.mocked(scanSecrets).mockResolvedValue([f1, f2]);
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(100);
    expect(scanner.activeFindings.value.length).toBe(2);

    scanner.dismiss(scanner.findingKey(f1));

    expect(scanner.activeFindings.value).toEqual([f2]);
    // The underlying findings list is untouched — dismissal is session-only.
    expect(scanner.findings.value.length).toBe(2);
  });

  it("ignorePattern(cwd, patternId) writes the affected file paths to .gitwandrc secrets.ignore[] and re-scans", async () => {
    const f1 = finding({ file: "a.ts", line: 1, patternId: "aws_access_key_id" });
    const f2 = finding({ file: "b.ts", line: 2, patternId: "aws_access_key_id" });
    const f3 = finding({ file: "c.ts", line: 3, patternId: "github_pat_classic" });
    vi.mocked(scanSecrets).mockResolvedValue([f1, f2, f3]);
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(100);
    expect(scanner.findings.value.length).toBe(3);

    await scanner.ignorePattern("/repo", "aws_access_key_id");

    expect(writeGitwandrc).toHaveBeenCalledTimes(1);
    const [cwdArg, rcArg] = vi.mocked(writeGitwandrc).mock.calls[0];
    expect(cwdArg).toBe("/repo");
    expect((rcArg as any).secrets.ignore).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect((rcArg as any).secrets.ignore).not.toEqual(expect.arrayContaining(["c.ts"]));

    // Locally-known findings for that pattern are cleared immediately (optimistic),
    // independent of any subsequent re-scan.
    expect(scanner.findings.value.map((f) => f.patternId)).toEqual(["github_pat_classic"]);
  });

  it("ignorePattern is a no-op when no known finding has that patternId", async () => {
    vi.mocked(scanSecrets).mockResolvedValue([finding({ patternId: "aws_access_key_id" })]);
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(100);

    await scanner.ignorePattern("/repo", "some_unrelated_pattern");

    expect(writeGitwandrc).not.toHaveBeenCalled();
  });

  it("filesForPattern(patternId) lists every unique file currently carrying that pattern, so callers can build an honest confirm message", async () => {
    const f1 = finding({ file: "a.ts", line: 1, patternId: "aws_access_key_id" });
    const f2 = finding({ file: "b.ts", line: 2, patternId: "aws_access_key_id" });
    const f2b = finding({ file: "b.ts", line: 5, patternId: "aws_access_key_id" });
    const f3 = finding({ file: "c.ts", line: 3, patternId: "github_pat_classic" });
    vi.mocked(scanSecrets).mockResolvedValue([f1, f2, f2b, f3]);
    const scanner = useSecretsScanner({ debounceMs: 100 });

    scanner.scan("/repo", SETTINGS);
    await vi.advanceTimersByTimeAsync(100);

    expect(scanner.filesForPattern("aws_access_key_id")).toEqual(["a.ts", "b.ts"]);
    expect(scanner.filesForPattern("github_pat_classic")).toEqual(["c.ts"]);
    expect(scanner.filesForPattern("no_such_pattern")).toEqual([]);
  });
});
