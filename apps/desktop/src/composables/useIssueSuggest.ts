/**
 * `#` in a commit field lists the repository's open issues (#301, part 4).
 *
 * One instance per field. The text logic is in `utils/issueRefs`; this holds
 * the list's state, a per-repository cache (refreshed after 60 s) and the key
 * handling. Nothing is fetched until a `#` opens the list.
 */
import { computed, nextTick, ref, type ComputedRef, type Ref } from "vue";
import type { Issue } from "../utils/backend";
import { filterIssues, hashTokenAt, insertRef, issueRef, repoSlugFromUrl } from "../utils/issueRefs";

export const ISSUE_CACHE_TTL_MS = 60_000;
/** Repositories whose issues stay cached; the least recently used goes first. */
export const ISSUE_CACHE_MAX_REPOS = 8;

export interface IssueSuggestDeps {
  cwd: () => string | null;
  /** null when the forge cannot list issues (then there is no list at all). */
  loadIssues: (cwd: string) => Promise<Issue[]> | null;
  /** `owner/repo` of the repository the commit is pushed to, or null. */
  pushRepo: (cwd: string) => Promise<string | null>;
  now?: () => number;
  /** Shared between fields so a repository is fetched once (default: this instance's own). */
  cache?: IssueCache;
}

export type SuggestStatus = "idle" | "loading" | "ready" | "error";

export interface Entry {
  at: number;
  status: "loading" | "ready" | "error";
  issues: Issue[];
  pushRepo: string | null;
}

export type Picked = { text: string; caret: number };

/** Issues per repository, with a counter the computeds read to see changes. */
export interface IssueCache {
  map: Map<string, Entry>;
  version: Ref<number>;
}

export function createIssueCache(): IssueCache {
  return { map: new Map(), version: ref(0) };
}

/** The cache the commit fields share for the app's lifetime (#301). */
export const sharedIssueCache = createIssueCache();

/** Forget `cwd`'s issues (one was just created): the next `#` fetches them again. */
export function invalidateIssues(cache: IssueCache, cwd: string): void {
  if (cache.map.delete(cwd)) cache.version.value++;
}

/** Store `cwd`'s entry as the most recently used, dropping the oldest beyond the cap. */
function remember(cache: IssueCache, cwd: string, e: Entry): void {
  cache.map.delete(cwd);
  cache.map.set(cwd, e);
  while (cache.map.size > ISSUE_CACHE_MAX_REPOS) cache.map.delete(cache.map.keys().next().value as string);
  cache.version.value++;
}

export function useIssueSuggest(deps: IssueSuggestDeps): {
  open: Ref<boolean>;
  status: ComputedRef<SuggestStatus>;
  rows: ComputedRef<Issue[]>;
  active: Ref<number>;
  update(text: string, caret: number): void;
  keydown(e: KeyboardEvent, text: string): Picked | "handled" | null;
  pick(index: number, fixes: boolean, text: string): Picked | null;
  close(): void;
  sync(text: string): void;
} {
  const now = deps.now ?? (() => Date.now());
  const store = deps.cache ?? createIssueCache();
  const { map: cache, version } = store;
  const open = ref(false);
  const query = ref("");
  const active = ref(0);
  let start = 0;
  let caret = 0;
  /** The text `update` last read; a different one (set by code) closes the list. */
  let lastText = "";

  const entry = (): Entry | undefined => {
    void version.value;
    const cwd = deps.cwd();
    return cwd ? cache.get(cwd) : undefined;
  };

  const status = computed<SuggestStatus>(() => (open.value ? entry()?.status ?? "loading" : "idle"));
  const rows = computed<Issue[]>(() => {
    const e = entry();
    // While a refresh is loading, the issues it replaces are still offered.
    return open.value && e && e.status !== "error" ? filterIssues(e.issues, query.value) : [];
  });

  /**
   * Fetch the issues for `cwd` unless fresh ones are cached. A failed fetch is
   * retried when the list opens again, not on each key while it is open.
   * false: this forge has no list.
   */
  function ensureLoaded(cwd: string, opening: boolean): boolean {
    const cached = cache.get(cwd);
    const fresh = cached && now() - cached.at <= ISSUE_CACHE_TTL_MS && (cached.status !== "error" || !opening);
    if (cached && (cached.status === "loading" || fresh)) return true;
    const pending = deps.loadIssues(cwd);
    if (!pending) return false;
    remember(store, cwd, { at: now(), status: "loading", issues: cached?.issues ?? [], pushRepo: cached?.pushRepo ?? null });
    Promise.all([pending, deps.pushRepo(cwd).catch(() => null)]).then(
      ([issues, push]) => remember(store, cwd, { at: now(), status: "ready", issues, pushRepo: push }),
      () => remember(store, cwd, { at: now(), status: "error", issues: [], pushRepo: null }),
    );
    return true;
  }

  function close() {
    open.value = false;
    query.value = "";
    active.value = 0;
  }

  function update(text: string, at: number) {
    const token = hashTokenAt(text, at);
    const cwd = deps.cwd();
    if (!token || !cwd) return close();
    if (!ensureLoaded(cwd, !open.value)) return close();
    if (!open.value || token.query !== query.value) active.value = 0;
    start = token.start;
    caret = at;
    lastText = text;
    query.value = token.query;
    open.value = true;
  }

  function pick(index: number, fixes: boolean, text: string): Picked | null {
    const chosen = rows.value[index];
    if (!open.value || !chosen) return null;
    const ref = issueRef(chosen.number, repoSlugFromUrl(chosen.url), entry()?.pushRepo ?? null);
    const out = insertRef(text, start, caret, ref, fixes);
    close();
    return out;
  }

  function keydown(e: KeyboardEvent, text: string): Picked | "handled" | null {
    // keyCode 229: WebKit ends a composition before the Enter that confirms it.
    if (!open.value || e.isComposing || e.keyCode === 229) return null;
    // Cmd/Ctrl+Enter commits; a modified key is never the list's.
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key === "Escape") {
      close();
      return "handled";
    }
    const n = rows.value.length;
    if (n === 0) return null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      active.value = (active.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      return "handled";
    }
    if (e.key === "Enter" || e.key === "Tab") return pick(Math.min(active.value, n - 1), e.key === "Enter" && e.shiftKey, text);
    return null;
  }

  /** The field's value as rendered: a change no `update` saw closes the list. */
  function sync(text: string) {
    if (open.value && text !== lastText) close();
  }

  return { open, status, rows, active, update, keydown, pick, close, sync };
}

export type IssueSuggest = ReturnType<typeof useIssueSuggest>;
type Field = HTMLInputElement | HTMLTextAreaElement;

/** Re-read the `#token` at the field's caret (on input, click, caret keys). */
export function refreshIssueSuggest(s: IssueSuggest, el: Field): void {
  s.update(el.value, el.selectionStart ?? el.value.length);
}

/** Put the caret at `at` once the new value is rendered. */
function placeCaret(el: Field, at: number): void {
  void nextTick(() => {
    if (document.activeElement === el) el.setSelectionRange(at, at);
  });
}

/**
 * The field's keydown, before its own handling. Returns true when the list
 * took the key: it is then stopped here, so App's Escape ladder never sees it.
 */
export function handleIssueKeydown(s: IssueSuggest, e: KeyboardEvent, el: Field, write: (text: string) => void): boolean {
  if (!s.open.value) return false;
  // The caret may have moved with no refresh (Cmd+Right, PageDown, a drag):
  // re-read it, so a list left behind never takes the key.
  refreshIssueSuggest(s, el);
  const out = s.keydown(e, el.value);
  if (out === null) return false;
  e.preventDefault();
  e.stopPropagation();
  if (out !== "handled") {
    write(out.text);
    placeCaret(el, out.caret);
  }
  return true;
}

/** A row picked with the mouse. */
export function pickIssueRow(s: IssueSuggest, index: number, fixes: boolean, el: Field | null, write: (text: string) => void): void {
  if (!el) return;
  const out = s.pick(index, fixes, el.value);
  if (!out) return;
  write(out.text);
  placeCaret(el, out.caret);
}
