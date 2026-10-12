import { describe, expect, it } from "vitest";
import { isSafeUrl, normalizeUrlText } from "../urlSafety";
import { escapeHtml } from "../escapeHtml";

describe("isSafeUrl", () => {
  it("refuses script and local-file schemes, however they are spelled", () => {
    for (const url of ["javascript:alert(1)", " JavaScript:x", "java\tscript:x", "\u0001vbscript:x", "file:///etc/passwd"]) {
      expect(isSafeUrl(url, "link"), url).toBe(false);
      expect(isSafeUrl(url, "image"), url).toBe(false);
    }
  });

  it("allows data: only for inline images of a known type", () => {
    expect(isSafeUrl("data:image/png;base64,AA", "image")).toBe(true);
    expect(isSafeUrl("data:image/svg+xml;base64,AA", "image")).toBe(true);
    expect(isSafeUrl("data:image/png;base64,AA", "link")).toBe(false);
    expect(isSafeUrl("data:text/html,<b>", "image")).toBe(false);
  });

  it("allows ordinary and relative URLs", () => {
    for (const url of ["https://e.com", "mailto:a@b.c", "/path", "#anchor", "./doc.md"]) {
      expect(isSafeUrl(url, "link"), url).toBe(true);
    }
  });

  it("normalizes like the browser URL parser", () => {
    expect(normalizeUrlText(" \u0001h\tt\ntps://x \u0002")).toBe("https://x");
  });
});

describe("escapeHtml", () => {
  it("escapes & < > and double quotes", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("returns strings with nothing to escape unchanged", () => {
    const s = "plain text";
    expect(escapeHtml(s)).toBe(s);
  });
});
