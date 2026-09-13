/**
 * v3.11.0 — one CodeMirror `EditorView`, per instance.
 *
 * Design: docs/superpowers/specs/2026-09-12-v3.11.0-preview-to-apply-design.md §4.1-4.2
 *
 * `buildState` and `mount` are deliberately **separate**. That is what lets the
 * File Explorer keep its per-tab `EditorState` cache and its "did the active
 * tab change while we awaited?" re-checks in the component, where the tab
 * concept belongs. If this composable owned mounting end to end, either it
 * would have to learn about tabs (wrong) or the File Explorer would lose its
 * cache (a regression).
 *
 * The doc is imperative here (`setDoc` / `getDoc`). `v-model` semantics live
 * one layer up in `CodeEditor.vue`; mixing reactive and imperative at this
 * level produces the classic echo loop where each side keeps re-applying the
 * other's value.
 *
 * `reconfigure` stays generic so the blame gutter can live in the component
 * that knows what blame is. `useBlameGutter.ts` is deliberately
 * CodeMirror-free, and that boundary is worth keeping.
 */

import { ref, shallowRef, watch, type Ref } from "vue";
import type { EditorView } from "@codemirror/view";
import type { Compartment, EditorState, Extension } from "@codemirror/state";
import { loadCodeMirror, detectLanguageExtension, type CmLibs } from "../utils/codemirrorLibs";
import { useTheme } from "./useTheme";

export interface UseCodeMirrorOptions {
  /** Element the view mounts into. */
  host: Ref<HTMLElement | null>;
  /** Whether the document is editable. Defaults to editable. */
  editable?: Ref<boolean>;
  /** Fires on every document change, with the new text. */
  onDocChange?: (doc: string) => void;
  /** Extra extensions baked into every state this instance builds. */
  extraExtensions?: Extension[];
}

export function useCodeMirror(options: UseCodeMirrorOptions) {
  const view = shallowRef<EditorView | null>(null);
  const ready = ref(false);
  const { theme } = useTheme();

  let libs: CmLibs | null = null;
  let editableCompartment: Compartment | null = null;
  let themeCompartment: Compartment | null = null;

  const editable = options.editable ?? ref(true);

  /**
   * Chrome for the light theme.
   *
   * `basicSetup` already includes `syntaxHighlighting(defaultHighlightStyle)`,
   * so token colours come for free once `oneDark` is simply not added. Only
   * the frame needs describing, and it is written in the app's own custom
   * properties so it tracks the design tokens instead of duplicating them.
   */
  function lightTheme(cm: CmLibs): Extension {
    return cm.EditorView.theme(
      {
        "&": {
          color: "var(--color-text)",
          backgroundColor: "var(--color-bg-secondary)",
        },
        ".cm-content": { caretColor: "var(--color-text)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-text)" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: "var(--color-accent-soft, rgba(0, 120, 215, 0.2))",
        },
        ".cm-gutters": {
          backgroundColor: "var(--color-bg-secondary)",
          color: "var(--color-text-muted)",
          border: "none",
          borderRight: "1px solid var(--color-border)",
        },
        ".cm-activeLine": { backgroundColor: "var(--color-bg-secondary)" },
        ".cm-activeLineGutter": { backgroundColor: "var(--color-bg-secondary)" },
      },
      { dark: false },
    );
  }

  function themeExtension(cm: CmLibs): Extension {
    return theme.value === "dark" ? cm.oneDark : lightTheme(cm);
  }

  /** Load the libraries, creating this instance's compartments once. */
  async function ensure(): Promise<CmLibs> {
    if (libs) return libs;
    const loaded = await loadCodeMirror();
    libs = loaded;
    editableCompartment ??= new loaded.Compartment();
    themeCompartment ??= new loaded.Compartment();
    return loaded;
  }

  /**
   * Build a state without mounting it, so a caller can cache states itself.
   * `filePath` drives language detection; pass null to skip it.
   */
  async function buildState(
    doc: string,
    filePath: string | null,
    extras: Extension[] = [],
  ): Promise<EditorState> {
    const cm = await ensure();
    const langExt = filePath ? await detectLanguageExtension(filePath) : [];
    return cm.EditorState.create({
      doc,
      extensions: [
        cm.basicSetup,
        themeCompartment!.of(themeExtension(cm)),
        langExt,
        cm.EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onDocChange?.(update.state.doc.toString());
        }),
        editableCompartment!.of(cm.EditorView.editable.of(editable.value)),
        ...(options.extraExtensions ?? []),
        ...extras,
      ],
    });
  }

  /** Mount a state, creating the view on first call and swapping it after. */
  function mount(state: EditorState): void {
    if (!libs || !options.host.value) return;
    if (!view.value) {
      view.value = new libs.EditorView({ state, parent: options.host.value });
    } else {
      view.value.setState(state);
    }
    ready.value = true;
    // A cached state may predate the current lock or theme; re-assert both so
    // the view is consistent with the app rather than with when it was built.
    applyEditable();
    applyTheme();
  }

  /** Convenience: build and mount in one step. */
  async function open(doc: string, filePath: string | null): Promise<void> {
    const state = await buildState(doc, filePath);
    mount(state);
  }

  function getDoc(): string {
    return view.value?.state.doc.toString() ?? "";
  }

  /** Replace the whole document. No-op when the text is already identical. */
  function setDoc(text: string): void {
    const v = view.value;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === text) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }

  function applyEditable(): void {
    const v = view.value;
    if (!v || !libs || !editableCompartment) return;
    v.dispatch({
      effects: editableCompartment.reconfigure(libs.EditorView.editable.of(editable.value)),
    });
  }

  function applyTheme(): void {
    const v = view.value;
    if (!v || !libs || !themeCompartment) return;
    v.dispatch({ effects: themeCompartment.reconfigure(themeExtension(libs)) });
  }

  /** Reconfigure a caller-owned compartment (the blame gutter, for instance). */
  function reconfigure(compartment: Compartment, ext: Extension): void {
    view.value?.dispatch({ effects: compartment.reconfigure(ext) });
  }

  function focus(): void {
    view.value?.focus();
  }

  function destroy(): void {
    view.value?.destroy();
    view.value = null;
    ready.value = false;
  }

  watch(editable, applyEditable);
  watch(theme, applyTheme);

  return {
    view,
    ready,
    ensure,
    buildState,
    mount,
    open,
    getDoc,
    setDoc,
    applyEditable,
    applyTheme,
    reconfigure,
    focus,
    destroy,
  };
}
