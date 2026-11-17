import { describe, expect, it } from "vitest";
import {
  attachmentKey,
  attachmentKeysIn,
  indexSignedAttachments,
  isGithubAttachmentUrl,
} from "../githubAttachments";

const UUID = "e56beadb-c31a-4dee-bcd2-973dae719016";

/** A signed URL whose JWT carries `claims`. */
function signed(uuid: string, claims: Record<string, unknown> = { iss: "github.com" }): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `https://private-user-images.githubusercontent.com/12479055/672752852-${uuid}.png?jwt=eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

describe("isGithubAttachmentUrl / attachmentKey", () => {
  it("recognises the three forms and keys them by UUID", () => {
    expect(attachmentKey(`https://github.com/user-attachments/assets/${UUID}`)).toBe(UUID);
    expect(attachmentKey(`https://github.com/user-attachments/assets/${UUID.toUpperCase()}`)).toBe(UUID);
    expect(attachmentKey(`https://user-images.githubusercontent.com/1/2-${UUID}.png`)).toBe(UUID);
    expect(attachmentKey(signed(UUID))).toBe(UUID);
  });

  it("rejects other hosts, paths, schemes and credentials", () => {
    for (const u of [
      `https://github.com.evil.example/user-attachments/assets/${UUID}`,
      `https://evil.example/github.com/user-attachments/assets/${UUID}`,
      `https://github.com/o/r/blob/main/${UUID}.png`,
      `http://github.com/user-attachments/assets/${UUID}`,
      `https://a:b@github.com/user-attachments/assets/${UUID}`,
      `https://github.com:8443/user-attachments/assets/${UUID}`,
      "not a url",
    ]) {
      expect(isGithubAttachmentUrl(u)).toBe(false);
    }
    expect(attachmentKey("https://github.com/user-attachments/assets/no-uuid")).toBeNull();
  });
});

describe("attachmentKeysIn", () => {
  it("finds markdown, HTML and bare forms, once each", () => {
    const md = [
      `![a](https://github.com/user-attachments/assets/${UUID})`,
      `<img src="https://github.com/user-attachments/assets/${UUID}">`,
      "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555",
      "![b](https://example.com/x.png)",
    ].join("\n");
    expect(attachmentKeysIn(md)).toEqual([UUID, "11111111-2222-3333-4444-555555555555"]);
    expect(attachmentKeysIn(null)).toEqual([]);
  });
});

describe("indexSignedAttachments", () => {
  it("expires each URL its JWT lifetime after the fetch, whatever the local clock says", () => {
    const fetchedAt = 1_000_000; // far from the JWT's absolute times
    const B = "11111111-2222-3333-4444-555555555555";
    const C = "99999999-2222-3333-4444-555555555555";
    const m = indexSignedAttachments(
      [
        signed(UUID, { nbf: 1794902505, exp: 1794902805 }),
        signed(B, { iat: 100, exp: 160 }),
        signed(C, { exp: 1794902805 }),
      ],
      fetchedAt,
    );
    expect(m.get(UUID)).toEqual({ url: signed(UUID, { nbf: 1794902505, exp: 1794902805 }), expiresAt: fetchedAt + 300_000 });
    expect(m.get(B)?.expiresAt).toBe(fetchedAt + 60_000);
    // No start claim: the five-minute default.
    expect(m.get(C)?.expiresAt).toBe(fetchedAt + 300_000);
  });

  it("ignores URLs that are not attachments", () => {
    expect(indexSignedAttachments(["https://example.com/x.png", "garbage"]).size).toBe(0);
  });
});
