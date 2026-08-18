// @vitest-environment jsdom
/**
 * XSS regression tests for useSafeHtml.
 *
 * GitWand renders markdown (READMEs, PR bodies, comments) and pre-built
 * HTML (diff / syntax highlighting) via `v-html`. Because we run inside
 * a Tauri webview with IPC commands, any XSS escape is equivalent to
 * local code execution — so every payload below MUST be neutralized.
 *
 * These tests use jsdom via vitest's `environment: jsdom`, which gives
 * DOMPurify a real `window`/`document` to parse against.
 */

import { describe, expect, it } from "vitest";
import { renderMarkdown, safeHtml } from "../useSafeHtml";

describe("safeHtml — raw HTML sanitization", () => {
  it("strips <script> tags", () => {
    const out = safeHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>hi</p>");
  });

  it("removes inline event handlers (onerror, onclick, onload)", () => {
    const cases = [
      '<img src=x onerror="alert(1)">',
      '<svg onload="alert(1)"></svg>',
      '<a href="#" onclick="alert(1)">x</a>',
      '<div onmouseover="alert(1)">x</div>',
    ];
    for (const payload of cases) {
      const out = safeHtml(payload);
      expect(out.toLowerCase()).not.toContain("onerror");
      expect(out.toLowerCase()).not.toContain("onclick");
      expect(out.toLowerCase()).not.toContain("onmouseover");
      expect(out.toLowerCase()).not.toContain("onload");
      expect(out).not.toContain("alert(1)");
    }
  });

  it("drops <svg> / <iframe> / <object> / <embed>", () => {
    const out = safeHtml(
      '<svg><g/></svg><iframe src="evil"></iframe><object data="x"></object><embed src="x">',
    );
    expect(out.toLowerCase()).not.toContain("<svg");
    expect(out.toLowerCase()).not.toContain("<iframe");
    expect(out.toLowerCase()).not.toContain("<object");
    expect(out.toLowerCase()).not.toContain("<embed");
  });

  it("neutralises javascript: URLs on anchors", () => {
    const out = safeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("neutralises vbscript: URLs on anchors", () => {
    const out = safeHtml('<a href="vbscript:msgbox(1)">click</a>');
    expect(out.toLowerCase()).not.toContain("vbscript:");
  });

  it("neutralises javascript: URLs on images", () => {
    const out = safeHtml('<img src="javascript:alert(1)">');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("forbids non-image data: URLs on <img>", () => {
    const out = safeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(out).not.toMatch(/data:text\/html/i);
  });

  it("allows safe data: image URLs", () => {
    const tiny =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
    const out = safeHtml(`<img src="${tiny}" alt="pixel">`);
    expect(out).toContain("data:image/png;base64,");
  });

  it("adds rel=\"noopener noreferrer\" to target=\"_blank\" anchors", () => {
    const out = safeHtml('<a href="https://example.com" target="_blank">x</a>');
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });

  it("preserves benign HTML (headings, lists, tables, code)", () => {
    const raw = `
      <h2>Title</h2>
      <ul><li>one</li><li>two</li></ul>
      <pre class="md-code-block"><code>const x = 1;</code></pre>
      <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>
    `;
    const out = safeHtml(raw);
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain('<pre class="md-code-block"><code>const x = 1;</code></pre>');
    expect(out).toContain("<table>");
    expect(out).toContain("<th>A</th>");
  });

  it("returns empty string for nullish input", () => {
    expect(safeHtml(null)).toBe("");
    expect(safeHtml(undefined)).toBe("");
    expect(safeHtml("")).toBe("");
  });
});

describe("renderMarkdown — markdown → sanitized HTML", () => {
  it("renders headings, bold, and code fences", () => {
    const out = renderMarkdown("# Title\n\n**bold** `inline`\n\n```js\nx\n```");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('<code class="md-inline-code">inline</code>');
    expect(out).toContain('<pre class="md-code-block">');
  });

  it("strips raw HTML <script> tags embedded in markdown", () => {
    // markdown-it (html: true) parses the raw HTML tag, and DOMPurify strips it.
    const out = renderMarkdown("normal\n\n<script>alert(1)</script>\n\nmore");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("normal");
    expect(out).toContain("more");
  });

  it("strips XSS payloads smuggled via inline HTML in markdown", () => {
    const out = renderMarkdown('click <img src=x onerror="alert(1)"> here');
    // markdown-it (html: true) parses the raw HTML tag. DOMPurify allows the img tag,
    // but strips the onerror handler.
    expect(out).toContain('<img src="x">');
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("renders raw HTML img tags with width and height in markdown", () => {
    const out = renderMarkdown('hello <img width="2521" height="203" alt="image" src="https://github.com/user-attachments/assets/5284ccc2-4567-40f0-88b7-1faec2289bbe" /> world');
    expect(out).toContain('<img width="2521" height="203" alt="image" src="https://github.com/user-attachments/assets/5284ccc2-4567-40f0-88b7-1faec2289bbe">');
  });


  it("neutralises javascript: links in markdown", () => {
    // markdown-it's default link validator rejects javascript: URIs, so
    // the link is not parsed as a link at all — the source text remains
    // as inert markdown syntax. We assert no real <a href="javascript:">
    // ever reaches the DOM.
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toMatch(/href\s*=\s*"javascript:/i);
    expect(out).not.toMatch(/href\s*=\s*'javascript:/i);
  });

  it("tags links with md-link class for styling parity with legacy renderer", () => {
    const out = renderMarkdown("[ok](https://example.com)");
    expect(out).toContain('class="md-link"');
    expect(out).toContain('href="https://example.com"');
  });

  it("tags tables / blockquotes / hr with legacy md-* classes", () => {
    const out = renderMarkdown("> quote\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toContain('class="md-blockquote"');
    expect(out).toContain('class="md-hr"');
    expect(out).toContain('class="md-table"');
  });

  it("adds slug ids to headings for in-page anchor links", () => {
    const out = renderMarkdown("# Hello World\n\n## Getting Started\n");
    expect(out).toContain('id="hello-world"');
    expect(out).toContain('id="getting-started"');
  });

  it("strips punctuation from heading slugs (parity with legacy renderer)", () => {
    const out = renderMarkdown("## What's new? — 2026");
    // The legacy slugify removed punctuation, collapsed whitespace, and
    // trimmed leading/trailing dashes.
    expect(out).toMatch(/id="whats-new-2026"/);
  });

  it("renders single newlines as <br> by default (comment/PR behaviour)", () => {
    const out = renderMarkdown("line one\nline two");
    expect(out).toContain("<br>");
  });

  it("does not render single newlines as <br> when breaks is false (README behaviour)", () => {
    const out = renderMarkdown("line one\nline two", { breaks: false });
    expect(out).not.toContain("<br>");
  });

  it("returns empty string for nullish input", () => {
    expect(renderMarkdown(null)).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
    expect(renderMarkdown("")).toBe("");
  });
});
