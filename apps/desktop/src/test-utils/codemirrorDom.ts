/**
 * jsdom shim for the one CodeMirror capability jsdom lacks.
 *
 * Established by the v3.11 T0 spike, which probed the real library against
 * this repo's Vitest config before any of the editor work was written:
 * CodeMirror 6 mounts, round-trips documents, flips facets, renders gutters,
 * reconfigures compartments and tears down cleanly in jsdom with no help at
 * all. The single casualty is `coordsAtPos`, because
 * `Range.prototype.getClientRects` is `undefined` here (not an empty stub), and
 * anything that measures layout goes through it.
 *
 * In practice that surfaces when the editor takes focus: the selection layer
 * measures the cursor rectangle, and a test that focuses an editor throws from
 * inside CodeMirror's own measure loop rather than from anything under test.
 *
 * **Import this from the individual test file that needs it, never from
 * `src/test-setup.ts`.** That setup file runs for all ~140 test files,
 * including the ones on the `node` environment where `document` does not
 * exist, and Vitest's default environment in this repo is deliberately `node`
 * for speed (jsdom measured at roughly 96s against 20s across the suite). A
 * global shim would also quietly paper over layout bugs in tests that have no
 * business touching layout.
 *
 * Returning an empty list is honest: jsdom performs no layout, so there are no
 * rectangles. CodeMirror handles the empty case, it just cannot handle the
 * method being absent.
 */

/** Make `coordsAtPos` and everything built on it survive under jsdom. */
export function installCodeMirrorDomShims(): void {
  const proto = Range.prototype as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };

  if (typeof proto.getClientRects !== "function") {
    const empty = Object.assign([] as unknown as DOMRectList, {
      item: () => null,
    });
    proto.getClientRects = () => empty;
  }

  if (typeof proto.getBoundingClientRect !== "function") {
    proto.getBoundingClientRect = () =>
      ({
        x: 0, y: 0, width: 0, height: 0,
        top: 0, right: 0, bottom: 0, left: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}
