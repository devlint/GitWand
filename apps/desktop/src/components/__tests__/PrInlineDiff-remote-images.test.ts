// @vitest-environment jsdom
/**
 * Remote images in inline review threads (Files tab of a PR). They are
 * withheld like every PR markdown body, and must be revealable: the threads
 * follow the PR's "Show images" choice through `PR_REMOTE_IMAGES_KEY`, and
 * PrDetailView offers the button above the diff when one of the file's
 * comments withholds an image (`commentsWithheldImages`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, provide, ref, type App } from "vue";
import PrInlineDiff from "../PrInlineDiff.vue";
import { PR_REMOTE_IMAGES_KEY, commentsWithheldImages } from "../../composables/useRemoteImages";
import type { GitDiff, PrReviewComment } from "../../utils/backend";

const IMG = "https://tracker.example/pixel.png";

function diff(): GitDiff {
  return {
    path: "src/foo.ts",
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
        lines: [
          { type: "context", content: "a", oldLineNo: 1, newLineNo: 1 },
          { type: "add", content: "b", newLineNo: 2 },
        ],
      },
    ],
  } as GitDiff;
}

function comment(body: string): PrReviewComment {
  return {
    id: 1, body, author: "someone", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    path: "src/foo.ts", line: 2, original_line: null, side: "RIGHT", start_line: null, start_side: null,
    in_reply_to_id: null, diff_hunk: "", url: "",
  } as PrReviewComment;
}

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("inline review threads — remote images", () => {
  it("withhold remote images until the PR's choice is provided as shown", async () => {
    const shown = ref(false);
    const Host = defineComponent({
      setup() {
        provide(PR_REMOTE_IMAGES_KEY, shown);
        return () => h(PrInlineDiff as any, {
          diff: diff(),
          filePath: "src/foo.ts",
          comments: [comment(`look ![x](${IMG})`)],
        });
      },
    });
    const el = document.createElement("div");
    document.body.appendChild(el);
    app = createApp(Host);
    app.mount(el);
    await nextTick();

    expect(el.querySelectorAll(".md-img-blocked").length).toBe(1);
    expect(el.querySelector(`img[src="${IMG}"]`)).toBeNull();

    shown.value = true;
    await nextTick();
    expect(el.querySelector(".md-img-blocked")).toBeNull();
    expect(el.querySelector(`img[src="${IMG}"]`)).not.toBeNull();
  });

  it("commentsWithheldImages drives the button above the diff", () => {
    const withImage = [comment("plain"), comment(`![x](${IMG})`)];
    expect(commentsWithheldImages(withImage, false)).toBe(true);
    expect(commentsWithheldImages(withImage, true)).toBe(false);
    expect(commentsWithheldImages([comment("no image"), comment("![local](img/a.png)")], false)).toBe(false);
    expect(commentsWithheldImages([], false)).toBe(false);
  });
});

describe("commentsWithheldImages — cached by body", () => {
  it("renders each distinct body once, and follows the global setting", async () => {
    const safe = await import("../../composables/useSafeHtml");
    const { useSettings } = await import("../../composables/useSettings");
    const spy = vi.spyOn(safe, "renderMarkdown");
    const body = `cached ![x](${IMG}) ${Math.random()}`;
    const list = [comment(body), comment(body)];
    expect(commentsWithheldImages(list, false)).toBe(true);
    expect(commentsWithheldImages(list, false)).toBe(true);
    const renders = spy.mock.calls.filter((c) => c[0] === body).length;
    expect(renders).toBe(1);
    useSettings().settings.value.allowRemoteImages = true;
    try {
      expect(commentsWithheldImages(list, false)).toBe(false);
    } finally {
      useSettings().settings.value.allowRemoteImages = false;
    }
    spy.mockRestore();
  });
});
