/**
 * v3.11.0 — shared CodeMirror 6 loader.
 *
 * Design: docs/superpowers/specs/2026-09-12-v3.11.0-preview-to-apply-design.md §4.1
 *
 * Lives in `utils/` rather than `composables/` because it holds no reactive
 * state: same rationale as `utils/highlight.ts`, same memoized-dynamic-import
 * shape as `utils/coreEngine.ts`.
 *
 * **Every `@codemirror/*` import here is `import type`.** They are erased at
 * build time, so nothing in this module makes CodeMirror statically reachable
 * from whatever imports it. That matters: the merge editor and the diff viewer
 * are both reachable from eager paths, and `perf/bundle-check.mjs` guards a
 * main chunk with a finite budget. The libraries arrive only through the
 * dynamic `import()` calls inside `loadCodeMirror()`.
 *
 * Both the library promise and the per-extension grammar lookup are memoized.
 * The File Explorer used to re-import `language-data` and re-`load()` the
 * grammar for every tab; with three consumers that waste would have tripled.
 */

import type { Extension } from "@codemirror/state";

export interface CmLibs {
  EditorView: typeof import("@codemirror/view").EditorView;
  EditorState: typeof import("@codemirror/state").EditorState;
  Compartment: typeof import("@codemirror/state").Compartment;
  basicSetup: Extension;
  oneDark: Extension;
  undo: typeof import("@codemirror/commands").undo;
  redo: typeof import("@codemirror/commands").redo;
  gutter: typeof import("@codemirror/view").gutter;
  GutterMarker: typeof import("@codemirror/view").GutterMarker;
}

let _libs: Promise<CmLibs> | null = null;
let _resolved: CmLibs | null = null;

/**
 * Load (once) and return the CodeMirror pieces GitWand uses.
 *
 * Memoized on the promise, not the result, so concurrent callers share one
 * in-flight load instead of racing five dynamic imports each.
 */
export function loadCodeMirror(): Promise<CmLibs> {
  if (_libs) return _libs;
  _libs = (async () => {
    const [view, state, cmMeta, darkTheme, commands] = await Promise.all([
      import("@codemirror/view"),
      import("@codemirror/state"),
      import("codemirror"),
      import("@codemirror/theme-one-dark"),
      import("@codemirror/commands"),
    ]);
    const libs: CmLibs = {
      EditorView: view.EditorView,
      EditorState: state.EditorState,
      Compartment: state.Compartment,
      basicSetup: cmMeta.basicSetup,
      oneDark: darkTheme.oneDark,
      undo: commands.undo,
      redo: commands.redo,
      gutter: view.gutter,
      GutterMarker: view.GutterMarker,
    };
    _resolved = libs;
    return libs;
  })();
  return _libs;
}

/** Synchronous peek, for guards and tests. Null until the load resolves. */
export function peekCodeMirror(): CmLibs | null {
  return _resolved;
}

/** Memoized per file extension: the grammar for `a.ts` is the same every time. */
const _langCache = new Map<string, Promise<Extension[]>>();

/** Lowercased extension including the dot, or the bare filename when there is none. */
function langKey(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : base.toLowerCase();
}

/**
 * Resolve a language extension for `path`, or `[]` when no grammar matches.
 *
 * Never throws: an unknown or failing grammar degrades to plain text, which is
 * strictly better than refusing to show the file.
 */
export function detectLanguageExtension(path: string): Promise<Extension[]> {
  const key = langKey(path);
  const hit = _langCache.get(key);
  if (hit) return hit;

  const load = (async (): Promise<Extension[]> => {
    try {
      const [{ languages }, { LanguageDescription }] = await Promise.all([
        import("@codemirror/language-data"),
        import("@codemirror/language"),
      ]);
      const desc = LanguageDescription.matchFilename(languages, path);
      if (!desc) return [];
      return [await desc.load()];
    } catch {
      return [];
    }
  })();
  _langCache.set(key, load);
  return load;
}

/** Test seam: drop the memoized state so a suite can observe a cold load. */
export function __resetCodeMirrorCachesForTests(): void {
  _libs = null;
  _resolved = null;
  _langCache.clear();
}
