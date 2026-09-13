/**
 * v3.11.0 — the pure layer under the editable diff.
 *
 * Two functions, deliberately knowing nothing about Vue, CodeMirror or the
 * backend: turn a hunk into the text that is actually on disk right now
 * (`hunkPostImage`), and put edited text back into the file at exactly that
 * hunk's position (`spliceHunk`). Everything risky about editing a diff in
 * place lives here, which is why it ships and is tested before any UI.
 *
 * The failure mode that matters is not "the edit did not apply". It is "the
 * edit applied one line off", which silently corrupts a file the user believes
 * they only touched cosmetically. So the tests care most about the boundaries:
 * the first and last line of the range, a hunk at the very start or end of a
 * file, CRLF, and the presence or absence of a trailing newline.
 *
 * `spliceHunk` reconstructs from the original string rather than round-tripping
 * through `split("\n")`, because a bare split loses whether the file ended with
 * a newline and rewrites every CRLF to LF. A diff editor that silently
 * normalises line endings across a whole file would produce a diff nobody
 * asked for.
 */

import { describe, it, expect } from "vitest";
import { hunkPostImage, spliceHunk } from "../useDiffEdit";
import type { DiffHunk, DiffLine } from "../../utils/backend";

const line = (type: DiffLine["type"], content: string, oldNo?: number, newNo?: number): DiffLine => ({
  type,
  content,
  oldLineNo: oldNo,
  newLineNo: newNo,
});

/**
 * A hunk over a 5-line file that replaces line 3.
 *
 *   1 alpha     context
 *   2 beta      context
 *   3 GAMMA     delete  -> gamma-new   add
 *   4 delta     context
 */
function midFileHunk(): DiffHunk {
  return {
    header: "@@ -1,4 +1,4 @@",
    oldStart: 1,
    oldCount: 4,
    newStart: 1,
    newCount: 4,
    lines: [
      line("context", "alpha", 1, 1),
      line("context", "beta", 2, 2),
      line("delete", "GAMMA", 3, undefined),
      line("add", "gamma-new", undefined, 3),
      line("context", "delta", 4, 4),
    ],
  };
}

const FILE = ["alpha", "beta", "gamma-new", "delta", "epsilon"].join("\n") + "\n";

describe("hunkPostImage", () => {
  it("returns what is on disk now: context plus adds, deletes dropped", () => {
    expect(hunkPostImage(midFileHunk())).toBe("alpha\nbeta\ngamma-new\ndelta");
  });

  it("keeps line order, not type order", () => {
    // An add before a delete must not be reordered; the post-image is the
    // file's own sequence.
    const h: DiffHunk = {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
      lines: [
        line("add", "first-added", undefined, 1),
        line("context", "kept", 1, 2),
        line("delete", "gone", 2, undefined),
      ],
    };
    expect(hunkPostImage(h)).toBe("first-added\nkept");
  });

  it("is empty for a hunk that only deletes", () => {
    const h: DiffHunk = {
      header: "@@ -1,2 +0,0 @@",
      oldStart: 1, oldCount: 2, newStart: 1, newCount: 0,
      lines: [line("delete", "a", 1), line("delete", "b", 2)],
    };
    expect(hunkPostImage(h)).toBe("");
  });

  it("preserves blank lines rather than collapsing them", () => {
    const h: DiffHunk = {
      header: "@@ -1,3 +1,3 @@",
      oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
      lines: [line("context", "a", 1, 1), line("context", "", 2, 2), line("context", "b", 3, 3)],
    };
    expect(hunkPostImage(h)).toBe("a\n\nb");
  });
});

describe("spliceHunk — replacing the right lines", () => {
  it("replaces exactly the hunk's range and leaves the rest alone", () => {
    const r = spliceHunk(FILE, midFileHunk(), "alpha\nbeta\nGAMMA-EDITED\ndelta");
    expect(r.ok).toBe(true);
    expect(r.ok && r.text).toBe("alpha\nbeta\nGAMMA-EDITED\ndelta\nepsilon\n");
  });

  it("is an exact no-op when the replacement equals the post-image", () => {
    // The strongest single guarantee: confirming without typing must not
    // change one byte of the file.
    const r = spliceHunk(FILE, midFileHunk(), hunkPostImage(midFileHunk()));
    expect(r.ok && r.text).toBe(FILE);
  });

  it("handles a hunk at the very start of the file", () => {
    const h: DiffHunk = {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
      lines: [line("context", "alpha", 1, 1), line("context", "beta", 2, 2)],
    };
    const r = spliceHunk(FILE, h, "ALPHA\nBETA");
    expect(r.ok && r.text).toBe("ALPHA\nBETA\ngamma-new\ndelta\nepsilon\n");
  });

  it("handles a hunk at the very end of the file", () => {
    const h: DiffHunk = {
      header: "@@ -5,1 +5,1 @@",
      oldStart: 5, oldCount: 1, newStart: 5, newCount: 1,
      lines: [line("context", "epsilon", 5, 5)],
    };
    const r = spliceHunk(FILE, h, "EPSILON");
    expect(r.ok && r.text).toBe("alpha\nbeta\ngamma-new\ndelta\nEPSILON\n");
  });

  it("can grow the file", () => {
    const r = spliceHunk(FILE, midFileHunk(), "alpha\nbeta\none\ntwo\nthree\ndelta");
    expect(r.ok && r.text).toBe("alpha\nbeta\none\ntwo\nthree\ndelta\nepsilon\n");
  });

  it("can shrink the file, including to nothing", () => {
    const r = spliceHunk(FILE, midFileHunk(), "");
    expect(r.ok && r.text).toBe("\nepsilon\n");
  });
});

describe("spliceHunk — line endings and the trailing newline", () => {
  it("preserves CRLF instead of normalising the whole file to LF", () => {
    const crlf = ["alpha", "beta", "gamma-new", "delta", "epsilon"].join("\r\n") + "\r\n";
    const r = spliceHunk(crlf, midFileHunk(), "alpha\nbeta\nEDITED\ndelta");
    expect(r.ok).toBe(true);
    const text = r.ok ? r.text : "";
    expect(text, "untouched lines keep their CRLF").toContain("epsilon\r\n");
    expect(text, "the edited region adopts the file's ending").toContain("EDITED\r\n");
    expect(text.includes("\n\n"), "no stray bare LF introduced").toBe(false);
  });

  it("preserves a file that does NOT end with a newline", () => {
    const noTrailing = ["alpha", "beta", "gamma-new", "delta", "epsilon"].join("\n");
    const r = spliceHunk(noTrailing, midFileHunk(), "alpha\nbeta\nEDITED\ndelta");
    expect(r.ok && r.text!.endsWith("epsilon")).toBe(true);
    expect(r.ok && r.text!.endsWith("\n")).toBe(false);
  });

  it("preserves a file that DOES end with a newline", () => {
    const r = spliceHunk(FILE, midFileHunk(), "alpha\nbeta\nEDITED\ndelta");
    expect(r.ok && r.text!.endsWith("epsilon\n")).toBe(true);
  });
});

describe("spliceHunk — a hunk that only deletes", () => {
  /**
   * `newCount === 0`: the hunk covers no lines on the new side at all. Its
   * post-image is the empty string, and `"".split("\n")` is `[""]` rather than
   * `[]`, so the length check compared one empty line against an empty slice
   * and reported a perfectly fresh hunk as stale. The user would have been
   * told "the file changed since this diff was computed" about a file nothing
   * had touched.
   */
  const deleteOnly = (): DiffHunk => ({
    header: "@@ -2,2 +1,0 @@",
    oldStart: 2, oldCount: 2, newStart: 2, newCount: 0,
    lines: [line("delete", "beta", 2, undefined), line("delete", "gamma", 3, undefined)],
  });
  const AFTER_DELETE = "alpha\ndelta\n";

  it("is not mistaken for a stale hunk", () => {
    const r = spliceHunk(AFTER_DELETE, deleteOnly(), "");
    expect(r.ok, "nothing has changed under us").toBe(true);
  });

  it("re-inserting text lands at the right place", () => {
    const r = spliceHunk(AFTER_DELETE, deleteOnly(), "restored");
    expect(r.ok && r.text).toBe("alpha\nrestored\ndelta\n");
  });

  it("splicing its own (empty) post-image is still a no-op", () => {
    const r = spliceHunk(AFTER_DELETE, deleteOnly(), hunkPostImage(deleteOnly()));
    expect(r.ok && r.text).toBe(AFTER_DELETE);
  });
});

describe("spliceHunk — git's own CRLF shape", () => {
  /**
   * Modelled on what the dev-server's parser actually returns, not on what a
   * hand-written fixture feels like: git keeps the CR of a CRLF file INSIDE
   * each line's content, so a hunk over such a file has lines like "one\r".
   *
   * Both bugs this pins were found by the real-git round trip in
   * `tests/parity/diff-edit-roundtrip.test.mjs`, because every fixture above
   * puts the CR in the terminator where the splitter does, and so could never
   * have disagreed with it.
   */
  const crlfHunk = (): DiffHunk => ({
    header: "@@ -1,3 +1,3 @@",
    oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
    lines: [
      line("context", "one\r", 1, 1),
      line("delete", "two\r", 2, undefined),
      line("add", "TWO\r", undefined, 2),
      line("context", "three\r", 3, 3),
    ],
  });
  const CRLF_FILE = "one\r\nTWO\r\nthree\r\n";

  it("does not mistake a CRLF file for a stale hunk", () => {
    // The CR lives in the content on one side and in the terminator on the
    // other; comparing them naively refuses every CRLF edit.
    const r = spliceHunk(CRLF_FILE, crlfHunk(), hunkPostImage(crlfHunk()));
    expect(r.ok, "a CRLF hunk must not read as stale").toBe(true);
  });

  it("round-trips a CRLF file byte for byte, without doubling the CR", () => {
    // `split(/\r?\n/)` only consumes a CR followed by a LF, so the final line
    // keeps its own and the terminator was appended on top: "three\r\r\n".
    const r = spliceHunk(CRLF_FILE, crlfHunk(), hunkPostImage(crlfHunk()));
    expect(r.ok && r.text).toBe(CRLF_FILE);
  });

  it("keeps CRLF when the text is actually edited", () => {
    const r = spliceHunk(CRLF_FILE, crlfHunk(), "one\nEDITED\nthree");
    expect(r.ok && r.text).toBe("one\r\nEDITED\r\nthree\r\n");
  });
});

describe("spliceHunk — refusing a stale hunk", () => {
  it("refuses when the file no longer matches the hunk's post-image", () => {
    // The guard that matters. The diff was computed at some earlier moment; if
    // the file changed underneath (an external edit, a branch switch, the
    // watcher racing us) the line range now points somewhere else, and writing
    // would corrupt a region the user never looked at.
    const moved = "PREPENDED\n" + FILE;
    const r = spliceHunk(moved, midFileHunk(), "anything");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("stale");
  });

  it("refuses when the file got shorter than the hunk's range", () => {
    const r = spliceHunk("alpha\n", midFileHunk(), "anything");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("stale");
  });

  it("refuses on an empty file", () => {
    const r = spliceHunk("", midFileHunk(), "anything");
    expect(r.ok).toBe(false);
  });

  it("accepts when only lines OUTSIDE the hunk changed", () => {
    // Conservative but not paranoid: the check is scoped to the range being
    // written, so an unrelated edit further down the file is not a reason to
    // refuse.
    const changedTail = ["alpha", "beta", "gamma-new", "delta", "CHANGED-TAIL"].join("\n") + "\n";
    const r = spliceHunk(changedTail, midFileHunk(), "alpha\nbeta\nEDITED\ndelta");
    expect(r.ok).toBe(true);
    expect(r.ok && r.text).toContain("CHANGED-TAIL");
  });
});
