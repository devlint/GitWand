import { describe, it, expect } from "vitest";
import { BUILT_IN_PATTERNS } from "../../secrets/patterns.js";

describe("v3.5.0 — BUILT_IN_PATTERNS catalog", () => {
  it("has unique ids", () => {
    const ids = BUILT_IN_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every regex compiles as a JS RegExp", () => {
    for (const p of BUILT_IN_PATTERNS) {
      expect(() => new RegExp(p.regex)).not.toThrow();
    }
  });

  it("has at least 12 built-in patterns", () => {
    expect(BUILT_IN_PATTERNS.length).toBeGreaterThanOrEqual(12);
  });

  const cases: Array<{ id: string; positive: string; nearMiss: string }> = [
    {
      id: "aws_access_key_id",
      positive: 'const key = "AKIAABCDEFGHIJKLMNOP";',
      nearMiss: 'const key = "AKIASHORT";',
    },
    {
      id: "aws_secret_access_key",
      positive:
        'aws_secret_access_key = "AAAA0000BBBB1111CCCC2222DDDD3333EEEE4444"',
      nearMiss: 'secret = "AAAA0000BBBB1111CCCC2222DDDD3333EEEE4444"',
    },
    {
      id: "gcp_api_key",
      positive: 'const apiKey = "AIzaABCDEFGABCDEFGABCDEFGABCDEFGABCDEFG";',
      nearMiss: 'const apiKey = "AIzaSHORT";',
    },
    {
      id: "azure_storage_account_key",
      positive:
        "DefaultEndpointsProtocol=https;AccountName=mystore;AccountKey=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH==;EndpointSuffix=core.windows.net",
      nearMiss: "AccountKey=short==",
    },
    {
      id: "azure_client_secret",
      positive: 'AZURE_CLIENT_SECRET="AbCdEfGhIjKlMnOpQrStUvWxYz0123456789~7"',
      nearMiss: 'client_secret = "short"',
    },
    {
      id: "github_pat_classic",
      positive: 'const token = "ghp_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF";',
      nearMiss: 'const token = "ghp_short";',
    },
    {
      id: "github_pat_fine_grained",
      positive: 'const token = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAA";',
      nearMiss: 'const token = "github_pat_short";',
    },
    {
      id: "gitlab_pat",
      positive: 'const token = "glpat-ABCDEFGHIJ0123456789";',
      nearMiss: 'const token = "glpat-short";',
    },
    {
      id: "slack_token",
      positive: 'const token = "xoxb-1234567890abcdef";',
      nearMiss: 'const token = "xoxb-123";',
    },
    {
      id: "stripe_live_key",
      positive: 'const key = "sk_live_ABCDEFGHIJKLMNOPQRSTUVWX";',
      nearMiss: 'const key = "sk_live_short";',
    },
    {
      id: "openai_api_key",
      positive: 'const key = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";',
      nearMiss: 'const key = "sk-short";',
    },
    {
      id: "anthropic_api_key",
      positive: 'const key = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ";',
      nearMiss: 'const key = "sk-ant-short";',
    },
    {
      id: "private_key_header",
      positive: "-----BEGIN RSA PRIVATE KEY-----",
      nearMiss: "-----BEGIN CERTIFICATE-----",
    },
    {
      id: "jwt",
      positive:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123SIGNATURE_-",
      nearMiss: "eyJhbGciOiJIUzI1NiJ9",
    },
  ];

  it("covers every case id against the catalog", () => {
    const ids = new Set(BUILT_IN_PATTERNS.map((p) => p.id));
    for (const c of cases) {
      expect(ids.has(c.id), `catalog missing id ${c.id}`).toBe(true);
    }
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("matches the positive fixture", () => {
        const pattern = BUILT_IN_PATTERNS.find((p) => p.id === c.id);
        expect(pattern, `pattern ${c.id} not found`).toBeDefined();
        const re = new RegExp(pattern!.regex);
        expect(re.test(c.positive)).toBe(true);
      });

      it("does not match the near-miss fixture", () => {
        const pattern = BUILT_IN_PATTERNS.find((p) => p.id === c.id);
        expect(pattern, `pattern ${c.id} not found`).toBeDefined();
        const re = new RegExp(pattern!.regex);
        expect(re.test(c.nearMiss)).toBe(false);
      });
    });
  }

  it("private keys and live tokens are severity high", () => {
    const highIds = [
      "aws_access_key_id",
      "aws_secret_access_key",
      "gcp_api_key",
      "github_pat_classic",
      "github_pat_fine_grained",
      "gitlab_pat",
      "slack_token",
      "stripe_live_key",
      "openai_api_key",
      "anthropic_api_key",
      "private_key_header",
    ];
    for (const id of highIds) {
      const pattern = BUILT_IN_PATTERNS.find((p) => p.id === id);
      expect(pattern?.severity, `${id} should be high severity`).toBe("high");
    }
  });
});
