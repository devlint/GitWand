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

  it("treats a continuation paragraph indented past the item offset as loose", () => {
    expect(md("* a\n\n    more text")).toBe("<ul>\n<li>\n<p>a</p>\n<p>more text</p>\n</li>\n</ul>\n");
    expect(md("- a\n\n  - b")).toBe("<ul>\n<li>\n<p>a</p>\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ul>\n");
  });

  it("ignores blank lines inside a nested list when judging the outer one", () => {
    // Blank between nested siblings, and inside a doubly-nested item.
    expect(md("- a\n  - b\n\n  - c\n- d")).toMatch(/^<ul>\n<li>a\n<ul>/);
    expect(md("- a\n  - b\n    - c\n\n      more\n- d")).toMatch(/^<ul>\n<li>a\n<ul>/);
    // …but a paragraph back at the outer item's level after the nested list is loose.
    expect(md("- a\n  - b\n\n  tail")).toContain("<p>tail</p>");
  });

  it("never lazily continues a fenced code block in a blockquote or list item", () => {
    expect(md("> ```\n> code\nlazy")).toBe(
      '<blockquote class="md-blockquote">\n<pre class="md-code-block"><code>code\n</code></pre>\n</blockquote>\n<p>lazy</p>\n',
    );
    expect(md("- ```\n  code\nlazy")).toMatch(/<\/ul>\n<p>lazy<\/p>\n$/);
    // A closed fence doesn't block lazy continuation of a later paragraph.
    expect(md("> ```\n> x\n> ```\n> para\nlazy")).toContain("<p>para\nlazy</p>");
  });

  it("ends a list when another marker type starts", () => {
    expect(md("- a\n1. b")).toBe("<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>\n");
  });

  it("renders task list items with md-check classes and a state glyph", () => {
    const out = md("- [ ] todo\n- [x] done");
    expect(out).toContain('<li class="md-check"><span class="md-check-box">☐</span> todo</li>');
    expect(out).toContain('<li class="md-check md-checked"><span class="md-check-box">☑</span> done</li>');
  });

  it("puts the task glyph inside the paragraph of a loose item", () => {
    const out = md("- [x] a\n\n- [ ] b");
    expect(out).toContain('<li class="md-check md-checked">\n<p><span class="md-check-box">☑</span> a</p>');
    expect(out).toContain('<li class="md-check">\n<p><span class="md-check-box">☐</span> b</p>');
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

  it("decodes entities in link / image destinations and titles instead of double-escaping", () => {
    expect(md('[x](https://a.com/?a=1&amp;b=2 "Q&amp;A")')).toBe(
      '<p><a href="https://a.com/?a=1&amp;b=2" title="Q&amp;A" class="md-link">x</a></p>\n',
    );
    expect(md("![i](/i.png?w=1&#38;h=2)")).toContain('<img src="/i.png?w=1&amp;h=2"');
    expect(md('[r]\n\n[r]: /p?a&amp;b "T&#x26;U"')).toContain('<a href="/p?a&amp;b" title="T&amp;U"');
    // A backslash-escaped `&` is literal, unknown names stay verbatim.
    expect(md("[x](/p?\\&amp;q)")).toContain('href="/p?&amp;amp;q"');
    expect(md("[x](/p?&bogus;)")).toContain('href="/p?&amp;bogus;"');
    // Decoding happens before the scheme check.
    for (const src of ["[x](javascript&colon;alert(1))", "[x](&#106;avascript:alert(1))"]) {
      expect(md(src), src).not.toContain("href=");
    }
  });

  it("hides a mid-paragraph comment that spans blank lines", () => {
    expect(md("text <!-- start\n\nhidden\n\nend --> more\n\nnext")).toBe(
      "<p>text <!-- start\n\nhidden\n\nend --> more</p>\n<p>next</p>\n",
    );
    // Unclosed, or opened inside a code span: blank lines still split.
    expect(md("a <!-- open\n\nb")).toBe("<p>a &lt;!-- open</p>\n<p>b</p>\n");
    expect(md("`<!--` a\n\nb -->")).toBe("<p><code class=\"md-inline-code\">&lt;!--</code> a</p>\n<p>b --&gt;</p>\n");
  });

  it("linkifies bare URLs and autolinks, trimming trailing punctuation", () => {
    expect(md("see https://e.com/a.")).toBe('<p>see <a href="https://e.com/a" class="md-link">https://e.com/a</a>.</p>\n');
    expect(md("(www.e.com)")).toBe('<p>(<a href="http://www.e.com" class="md-link">www.e.com</a>)</p>\n');
    expect(md("<me@e.com>")).toBe('<p><a href="mailto:me@e.com" class="md-link">me@e.com</a></p>\n');
  });

  it("linkifies bare emails like GitHub, but not bare domains", () => {
    expect(md("mail a.b+c@e.co.uk.")).toBe(
      '<p>mail <a href="mailto:a.b+c@e.co.uk" class="md-link">a.b+c@e.co.uk</a>.</p>\n',
    );
    expect(md("@user and a@b and a@b.c-")).toBe("<p>@user and a@b and a@b.c-</p>\n");
    // Not inside link text or code spans.
    expect(md("[a@b.com](/p) `c@d.com`")).toBe(
      '<p><a href="/p" class="md-link">a@b.com</a> <code class="md-inline-code">c@d.com</code></p>\n',
    );
    // Narrower than markdown-it's fuzzy linkify, on purpose: GitHub doesn't link these either.
    expect(md("see example.com")).toBe("<p>see example.com</p>\n");
  });

  it("hides a comment spanning blank lines inside a list item", () => {
    // The comment stays one raw range (dropped by the sanitizer); the list stays tight.
    expect(md("- item <!-- TODO\n\nhidden\n\n-->\n- next")).toBe(
      "<ul>\n<li>item <!-- TODO\n\nhidden\n\n--></li>\n<li>next</li>\n</ul>\n",
    );
    // Unclosed: the item still ends at the blank line, nothing is swallowed.
    expect(md("- item <!-- open\n\nafter")).toContain("<p>after</p>");
    // Without a blank line, list markers inside the comment still start items.
    expect(md("- a <!-- note\n- b\n- c -->")).toBe(
      "<ul>\n<li>a &lt;!-- note</li>\n<li>b</li>\n<li>c --&gt;</li>\n</ul>\n",
    );
    // Unclosed: the blank line still separates two paragraphs, so the list is loose.
    expect(md("- a <!-- open\n\n  second\n- b")).toContain("<p>second</p>");
    // A fence line inside a comment does not hide the blank line after the
    // comment from the looseness check.
    expect(md("- a <!--\n  ```\n  -->\n\n  para")).toMatch(/^<ul>\n<li>\n<p>a/);
    // Inside a fence, `<!--` is code, not a comment.
    expect(md("- ```\n  <!--\n  ```\n\nafter -->")).toContain("<p>after --&gt;</p>");
  });

  it("does not linkify package@version specs as emails", () => {
    // Dependabot/Renovate PR bodies: the "domain" ends in a numeric label, not a TLD.
    expect(md("bump vue@3.5.42 and @types/node@25.9.5")).toBe(
      "<p>bump vue@3.5.42 and @types/node@25.9.5</p>\n",
    );
    expect(md("pkg@1.0.0-beta.1")).toBe("<p>pkg@1.0.0-beta.1</p>\n");
    expect(md("pkg@1.0.0-alpha.beta")).toBe("<p>pkg@1.0.0-alpha.beta</p>\n");
    expect(md("ops@team.example.io")).toContain('href="mailto:ops@team.example.io"');
  });

  it("keeps an unbalanced trailing ] or ) out of a bare URL", () => {
    expect(md("[see https://a.com]")).toBe('<p>[see <a href="https://a.com" class="md-link">https://a.com</a>]</p>\n');
    expect(md("https://a.com/x[1]")).toContain('href="https://a.com/x[1]"');
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
    md("a* ".repeat(30000));
    md("[a](".repeat(15000));
    md("a <!-- ".repeat(15000));
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("flattens nesting past the cap instead of overflowing the stack", () => {
    const out = md("> ".repeat(3000) + "x");
    expect(out.match(/<blockquote/g)?.length).toBeLessThanOrEqual(51);
    expect(out).toContain("x");
  });
});
