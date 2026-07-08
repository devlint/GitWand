import { describe, it, expect } from "vitest";
import { scanSecrets, shannonEntropy, redact, isIgnored } from "../../secrets/scanner.js";
import type { ScanFileInput, SecretsScanConfig } from "../../secrets/types.js";

function baseConfig(overrides: Partial<SecretsScanConfig> = {}): SecretsScanConfig {
  return {
    enabled: true,
    extraPatterns: [],
    ignore: [],
    entropyThreshold: 0,
    ...overrides,
  };
}

function fileWith(path: string, lines: string[]): ScanFileInput {
  return {
    path,
    addedLines: lines.map((text, i) => ({ line: i + 1, text })),
  };
}

describe("v3.5.0 — scanSecrets", () => {
  it("detects each built-in pattern in a realistic added line", () => {
    const files: ScanFileInput[] = [
      fileWith("src/config.ts", ['const key = "AKIAABCDEFGHIJKLMNOP";']),
    ];
    const findings = scanSecrets(files, baseConfig());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].patternId).toBe("aws_access_key_id");
    expect(findings[0].file).toBe("src/config.ts");
    expect(findings[0].line).toBe(1);
    expect(findings[0].severity).toBe("high");
  });

  it("detects a github classic PAT", () => {
    const files = [
      fileWith("src/x.ts", ['const t = "ghp_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF";']),
    ];
    const findings = scanSecrets(files, baseConfig());
    expect(findings.some((f) => f.patternId === "github_pat_classic")).toBe(true);
  });

  it("detects a private key header", () => {
    const files = [fileWith("id_rsa", ["-----BEGIN RSA PRIVATE KEY-----"])];
    const findings = scanSecrets(files, baseConfig());
    expect(findings.some((f) => f.patternId === "private_key_header")).toBe(true);
  });

  it("detects a user extraPattern", () => {
    const files = [fileWith("src/x.ts", ['const t = "itok_deadbeefdeadbeef";'])];
    const config = baseConfig({
      extraPatterns: [
        { id: "internal_token", regex: "itok_[0-9a-f]{16}", severity: "high", description: "" },
      ],
    });
    const findings = scanSecrets(files, config);
    expect(findings.some((f) => f.patternId === "internal_token")).toBe(true);
  });

  it("skips a malformed user extraPattern regex without throwing", () => {
    const files = [fileWith("src/x.ts", ["hello world"])];
    const config = baseConfig({
      extraPatterns: [{ id: "bad", regex: "(unterminated[", severity: "high", description: "" }],
    });
    expect(() => scanSecrets(files, config)).not.toThrow();
  });

  it("an ignore glob suppresses findings on a matching path", () => {
    const files = [
      fileWith("fixtures/sample.ts", ['const key = "AKIAABCDEFGHIJKLMNOP";']),
    ];
    const config = baseConfig({ ignore: ["fixtures/**"] });
    const findings = scanSecrets(files, config);
    expect(findings).toEqual([]);
  });

  it("an ignore /regex/ literal suppresses a specific value", () => {
    const files = [fileWith("src/x.ts", ['const key = "AKIAABCDEFGHIJKLMNOP";'])];
    const config = baseConfig({ ignore: ["/AKIAABCDEFGHIJKLMNOP/"] });
    const findings = scanSecrets(files, config);
    expect(findings).toEqual([]);
  });

  it("ignore does not suppress a non-matching path or value", () => {
    const files = [fileWith("src/x.ts", ['const key = "AKIAABCDEFGHIJKLMNOP";'])];
    const config = baseConfig({ ignore: ["other/**", "/NOTTHEKEY/"] });
    const findings = scanSecrets(files, config);
    expect(findings.length).toBe(1);
  });

  it("entropy pass finds a random 40-char base64-like blob when threshold enabled", () => {
    const files = [
      fileWith("src/x.ts", ['const token = "aZ3xQ9mK2pL7vN5wR8tY1cB4fH6jD0sE2gU9iO3k";']),
    ];
    const config = baseConfig({ entropyThreshold: 4.0 });
    const findings = scanSecrets(files, config);
    expect(findings.some((f) => f.patternId === "high_entropy")).toBe(true);
    const hit = findings.find((f) => f.patternId === "high_entropy");
    expect(hit?.severity).toBe("low");
  });

  it("entropy pass does not flag an English sentence", () => {
    const files = [
      fileWith("src/x.ts", ["this is a perfectly normal english sentence about nothing"]),
    ];
    const config = baseConfig({ entropyThreshold: 4.0 });
    const findings = scanSecrets(files, config);
    expect(findings.filter((f) => f.patternId === "high_entropy")).toEqual([]);
  });

  it("entropy pass does not flag a long hex git SHA when threshold set above hex's max entropy", () => {
    const files = [
      fileWith("src/x.ts", ["commit deadbeefcafe0123456789abcdef01234567deadbeefcafe0123456789"]),
    ];
    const config = baseConfig({ entropyThreshold: 4.5 });
    const findings = scanSecrets(files, config);
    expect(findings.filter((f) => f.patternId === "high_entropy")).toEqual([]);
  });

  it("entropy pass is skipped entirely when entropyThreshold is 0", () => {
    const files = [
      fileWith("src/x.ts", ['const token = "aZ3xQ9mK2pL7vN5wR8tY1cB4fH6jD0sE2gU9iO3k";']),
    ];
    const findings = scanSecrets(files, baseConfig({ entropyThreshold: 0 }));
    expect(findings).toEqual([]);
  });

  it("entropy pass does not double-report a token already covered by a regex hit on the same line", () => {
    const files = [fileWith("src/x.ts", ['const key = "AKIAABCDEFGHIJKLMNOP";'])];
    const config = baseConfig({ entropyThreshold: 3.0 });
    const findings = scanSecrets(files, config);
    // only the regex hit, no additional high_entropy finding for the same token
    expect(findings.length).toBe(1);
    expect(findings[0].patternId).toBe("aws_access_key_id");
  });

  it("redaction never contains the raw planted secret verbatim", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const files = [fileWith("src/x.ts", [`const key = "${secret}";`])];
    const findings = scanSecrets(files, baseConfig());
    for (const f of findings) {
      expect(f.redactedExcerpt).not.toBe(secret);
      expect(f.redactedExcerpt.includes(secret)).toBe(false);
    }
  });

  it("enabled: false returns []", () => {
    const files = [fileWith("src/x.ts", ['const key = "AKIAABCDEFGHIJKLMNOP";'])];
    const findings = scanSecrets(files, baseConfig({ enabled: false }));
    expect(findings).toEqual([]);
  });

  it("caps total findings at 500", () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `const key${i} = "AKIAABCDEFGHIJKLMNOP";`,
    );
    const files = [fileWith("src/x.ts", lines)];
    const findings = scanSecrets(files, baseConfig());
    expect(findings.length).toBe(500);
  });
});

describe("v3.5.0 — shannonEntropy", () => {
  it("returns 0 for an empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for a single repeated character", () => {
    expect(shannonEntropy("aaaaaaaaaa")).toBe(0);
  });

  it("returns higher entropy for a varied string than a repetitive one", () => {
    expect(shannonEntropy("aZ3xQ9mK2pL7vN5wR8tY")).toBeGreaterThan(shannonEntropy("aaaaaaaaaaaaaaaaaaaa"));
  });
});

describe("v3.5.0 — redact", () => {
  it("never returns the raw input verbatim for a long match", () => {
    const raw = "ghp_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF";
    expect(redact(raw)).not.toBe(raw);
  });

  it("fully masks very short matches (no leak via lead+trail)", () => {
    const raw = "abc";
    const out = redact(raw);
    expect(out).not.toContain("abc");
  });
});

describe("v3.5.0 — isIgnored", () => {
  it("matches a glob against the file path", () => {
    expect(isIgnored("fixtures/a.ts", "whatever", ["fixtures/**"])).toBe(true);
    expect(isIgnored("src/a.ts", "whatever", ["fixtures/**"])).toBe(false);
  });

  it("matches a /regex/ literal against the value", () => {
    expect(isIgnored("src/a.ts", "AKIAABCDEFGHIJKLMNOP", ["/AKIAABCDEFGHIJKLMNOP/"])).toBe(true);
    expect(isIgnored("src/a.ts", "somethingelse", ["/AKIAABCDEFGHIJKLMNOP/"])).toBe(false);
  });
});
