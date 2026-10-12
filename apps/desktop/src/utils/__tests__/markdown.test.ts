/**
 * Unit tests for the in-house markdown renderer. Sanitization is covered by
 * `composables/__tests__/useSafeHtml.test.ts`; these pin the markdown → HTML
 * structure READMEs, PR bodies and comments rely on.
 */

import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../markdown";

const md = (src: string, breaks = false) => markdownToHtml(src, { breaks });

describe("markdownToHtml — blocks", () => {
  it("renders ATX and setext headings with slug ids", () => {
    expect(md("## Getting Started ##")).toBe('<h2 id="getting-started">Getting Started</h2>\n');
    expect(md("Title\n===")).toBe('<h1 id="title">Title</h1>\n');
    expect(md("Sub\n---")).toBe('<h2 id="sub">Sub</h2>\n');
  });

  it("renders fenced code with a language class, escaped", () => {
    expect(md("```ts\nconst a = <b>;\n```")).toBe(
      '<pre class="md-code-block"><code class="language-ts">const a = &lt;b&gt;;\n</code></pre>\n',
    );
    expect(md("```suggestion\nx\n```")).toContain('class="md-code-block md-suggestion-block"');
  });

  it("renders indented code", () => {
    expect(md("    a\n\n    b")).toBe('<pre class="md-code-block"><code>a\n\nb\n</code></pre>\n');
  });

  it("renders horizontal rules and blockquotes with lazy continuation", () => {
    expect(md("***")).toBe('<hr class="md-hr">\n');
    expect(md("> a\nb")).toBe('<blockquote class="md-blockquote">\n<p>a\nb</p>\n</blockquote>\n');
  });

  it("renders tight nested lists without <p>", () => {
    expect(md("- a\n- b\n  - c")).toBe("<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul>\n");
  });

  it("renders loose lists with <p> and ordered start numbers", () => {
    expect(md("3. a\n\n4. b")).toBe('<ol start="3">\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ol>\n');
  });

  it("ends a list when another marker type starts", () => {
    expect(md("- a\n1. b")).toBe("<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>\n");
  });

  it("renders task list items with md-check classes", () => {
    const out = md("- [ ] todo\n- [x] done");
    expect(out).toContain('<li class="md-check">todo</li>');
    expect(out).toContain('<li class="md-check md-checked">done</li>');
  });

  it("renders GFM tables, padding short rows and honouring escaped pipes", () => {
    const out = md("| a | b |\n|:--|--:|\n| x \\| y | 2 |\n| 3 |");
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>x | y</td>");
    expect(out).toContain("<td>3</td>\n<td></td>");
  });

  it("passes HTML blocks through and resumes markdown after a blank line", () => {
    const out = md('<div align="center">\n<img src="a.png">\n</div>\n\n**bold**');
    expect(out).toContain('<div align="center">\n<img src="a.png">\n</div>\n');
    expect(out).toContain("<p><strong>bold</strong></p>");
  });
});

describe("markdownToHtml — inline", () => {
  it("renders emphasis, strong, nested and strikethrough", () => {
    expect(md("*a* **b** ***c*** ~~d~~")).toBe(
      "<p><em>a</em> <strong>b</strong> <em><strong>c</strong></em> <s>d</s></p>\n",
    );
  });

  it("does not treat intraword underscores as emphasis", () => {
    expect(md("snake_case_name")).toBe("<p>snake_case_name</p>\n");
  });

  it("renders inline code with the md-inline-code class", () => {
    expect(md("`` a`b ``")).toBe('<p><code class="md-inline-code">a`b</code></p>\n');
  });

  it("renders inline, reference and nested image links", () => {
    expect(md('[x](https://e.com "T")')).toBe('<p><a href="https://e.com" title="T" class="md-link">x</a></p>\n');
    expect(md("[r] [t][r]\n\n[r]: /ref")).toBe(
      '<p><a href="/ref" class="md-link">r</a> <a href="/ref" class="md-link">t</a></p>\n',
    );
    expect(md("[![CI](b.svg)](ci)")).toBe(
      '<p><a href="ci" class="md-link"><img src="b.svg" alt="CI"></a></p>\n',
    );
  });

  it("linkifies bare URLs and autolinks, trimming trailing punctuation", () => {
    expect(md("see https://e.com/a.")).toBe('<p>see <a href="https://e.com/a" class="md-link">https://e.com/a</a>.</p>\n');
    expect(md("(www.e.com)")).toBe('<p>(<a href="http://www.e.com" class="md-link">www.e.com</a>)</p>\n');
    expect(md("<me@e.com>")).toBe('<p><a href="mailto:me@e.com" class="md-link">me@e.com</a></p>\n');
  });

  it("refuses javascript:, vbscript: and non-image data: link targets", () => {
    for (const src of ["[x](javascript:alert(1))", "<javascript:alert(1)>", "[x](data:text/html,a)", "[x](VBScript:a)"]) {
      expect(md(src), src).not.toContain("href=");
    }
  });

  it("honours backslash escapes and escapes stray HTML characters", () => {
    expect(md("\\*a\\* 1 < 2 & 3")).toBe("<p>*a* 1 &lt; 2 &amp; 3</p>\n");
  });

  it("renders hard breaks always, soft breaks only with `breaks`", () => {
    expect(md("a  \nb")).toBe("<p>a<br>\nb</p>\n");
    expect(md("a\nb")).toBe("<p>a\nb</p>\n");
    expect(md("a\nb", true)).toBe("<p>a<br>\nb</p>\n");
  });

  it("stays fast on pathological input", () => {
    const t = performance.now();
    md("[".repeat(20000));
    md("![".repeat(20000));
    md("*a ".repeat(20000));
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
