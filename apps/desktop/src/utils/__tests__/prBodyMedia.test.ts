import { describe, it, expect } from "vitest";
import { maskMedia, restoreMedia } from "../prBodyMedia";

describe("maskMedia", () => {
  it("replaces markdown, html and bare-attachment media with numbered placeholders", () => {
    const body = [
      "## Summary",
      "Before:",
      "![before](https://example.com/a.png)",
      '<img width="300" alt="after" src="https://example.com/b.png">',
      "https://github.com/user-attachments/assets/1234-abcd",
      "See [the docs](https://example.com/docs).",
    ].join("\n");

    const { text, media } = maskMedia(body);

    expect(media).toEqual([
      "![before](https://example.com/a.png)",
      '<img width="300" alt="after" src="https://example.com/b.png">',
      "https://github.com/user-attachments/assets/1234-abcd",
    ]);
    expect(text).toBe(
      ["## Summary", "Before:", "[[IMAGE_1]]", "[[IMAGE_2]]", "[[IMAGE_3]]", "See [the docs](https://example.com/docs)."].join("\n"),
    );
  });

  it("keeps a linked image and a <picture> as one unit", () => {
    const linked = "[![shot](https://x.test/s.png)](https://x.test/full)";
    const picture = '<picture>\n  <source srcset="d.png">\n  <img src="l.png">\n</picture>';
    const { text, media } = maskMedia(`${linked}\n\n${picture}`);
    expect(media).toEqual([linked, picture]);
    expect(text).toBe("[[IMAGE_1]]\n\n[[IMAGE_2]]");
  });

  it("leaves a body without media untouched", () => {
    const body = "## Summary\nNo screenshots, see https://example.com/page.";
    expect(maskMedia(body)).toEqual({ text: body, media: [] });
  });
});

describe("maskMedia edge cases", () => {
  it("protects a literal [[IMAGE_n]] already in the body (round trip)", () => {
    const body = "Use the `[[IMAGE_1]]` token.\n![a](https://x.test/a.png)\nAnd [[IMAGE_2]] again.";
    const { text, media } = maskMedia(body);
    // None of the original placeholder text survives in what the model sees.
    expect(text).toBe("Use the [[IMAGE_1]] token.\n[[IMAGE_2]]\nAnd [[IMAGE_3]] again.");
    expect(media).toEqual(["`[[IMAGE_1]]`", "![a](https://x.test/a.png)", "[[IMAGE_2]]"]);
    expect(restoreMedia(text, media)).toBe(body);
  });

  it("does not let an unclosed <video> swallow text up to a later </video>", () => {
    const body = "<video src=a.mp4>\nSome text that must stay\n<video src=b.mp4></video>";
    const { text, media } = maskMedia(body);
    expect(media).toEqual(["<video src=b.mp4></video>"]);
    expect(text).toContain("Some text that must stay");
    expect(restoreMedia(text, media)).toBe(body);
  });

  it("handles a self-closed <video /> and <picture /> without spanning", () => {
    const body = '<video src="a.mp4" />\nKeep me\n<picture />\nAlso keep\n<video src="b.mp4"></video>';
    const { text, media } = maskMedia(body);
    expect(media).toEqual(['<video src="a.mp4" />', "<picture />", '<video src="b.mp4"></video>']);
    expect(text).toBe("[[IMAGE_1]]\nKeep me\n[[IMAGE_2]]\nAlso keep\n[[IMAGE_3]]");
  });

  it("keeps an image URL with balanced parentheses whole", () => {
    const img = "![a](https://x.test/a_(1).png)";
    const linked = "[![b](https://x.test/b_(2).png)](https://x.test/page_(3))";
    const { text, media } = maskMedia(`${img}\ntext after\n${linked}`);
    expect(media).toEqual([img, linked]);
    expect(text).toBe("[[IMAGE_1]]\ntext after\n[[IMAGE_2]]");
  });

  it("leaves media inside fenced code blocks untouched", () => {
    const body = [
      "Example:",
      "```md",
      "![demo](https://x.test/demo.png)",
      "[[IMAGE_1]]",
      "```",
      "~~~~",
      '<img src="x.png">',
      "~~~~",
      "![real](https://x.test/real.png)",
    ].join("\n");
    const { text, media } = maskMedia(body);
    expect(media).toEqual(["[[IMAGE_1]]", "![real](https://x.test/real.png)"]);
    expect(text).toContain("![demo](https://x.test/demo.png)");
    expect(text).toContain('<img src="x.png">');
    expect(text).not.toContain("![real]");
    expect(restoreMedia(text, media)).toBe(body);
  });

  it("treats an unclosed fence as running to the end of the body", () => {
    const body = "![a](https://x.test/a.png)\n```\n![b](https://x.test/b.png)";
    const { text, media } = maskMedia(body);
    expect(media).toEqual(["![a](https://x.test/a.png)"]);
    expect(text).toBe("[[IMAGE_1]]\n```\n![b](https://x.test/b.png)");
  });
});

describe("restoreMedia", () => {
  const media = ["![a](https://x.test/a.png)", '<img src="https://x.test/b.png">'];

  it("restores every placeholder to its exact original snippet", () => {
    const out = restoreMedia("Intro\n\n[[IMAGE_2]]\n\nMiddle\n\n[[IMAGE_1]]", media);
    expect(out).toBe(`Intro\n\n${media[1]}\n\nMiddle\n\n${media[0]}`);
  });

  it("tolerates spacing, case and backtick drift in placeholders", () => {
    const out = restoreMedia("x `[[ image_1 ]]` y [[IMAGE_2 ]]", media);
    expect(out).toBe(`x ${media[0]} y ${media[1]}`);
  });

  it("appends media whose placeholder the model dropped", () => {
    const out = restoreMedia("## Summary\nRewritten.\n\n[[IMAGE_2]]", media);
    expect(out).toBe(`## Summary\nRewritten.\n\n${media[1]}\n\n${media[0]}`);
  });

  it("drops duplicate and unknown placeholders", () => {
    const out = restoreMedia("[[IMAGE_1]] [[IMAGE_1]] [[IMAGE_9]]", media);
    expect(out).toBe(`${media[0]}\n\n${media[1]}`);
  });

  it("round-trips a body the model returned unchanged", () => {
    const body = "Text\n![a](https://x.test/a.png)\nMore\n<video src=\"v.mp4\"></video>";
    const { text, media: m } = maskMedia(body);
    expect(restoreMedia(text, m)).toBe(body);
  });
});
