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
