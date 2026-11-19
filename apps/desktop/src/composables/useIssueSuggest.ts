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
  /** `owner/repo` of the repository the commit is pushed to, or null; read at pick time. */
  pushRepo: (cwd: string) => string | null;
  now?: () => number;
  /** Shared between fields so a repository is fetched once (default: this instance's own). */
  cache?: IssueCache;
}

export type SuggestStatus = "idle" | "loading" | "ready" | "error";

export interface Entry {
  at: number;
  status: "loading" | "ready" | "error";
  issues: Issue[];
  /** The request this entry belongs to; an answer for another one is dropped. */
  req: number;
  /** The pushed repository when fetched: a remote changed since makes it stale. */
  slug: string | null;
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

let nextRequest = 0;

/** The cache the commit fields share for the app's lifetime (#301). */
export const sharedIssueCache = createIssueCache();

/**
 * Forget the issues of `cwd`, and of every folder holding `repo`'s (another
 * worktree, a fork listing its parent's): one was just created there. An
 * answer still in flight goes with its entry, so it is dropped.
 */
export function invalidateIssues(cache: IssueCache, target: { cwd?: string; repo?: string | null }): void {
  const repo = target.repo?.toLowerCase();
  const holds = (e: Entry) =>
    !!repo && (e.slug?.toLowerCase() === repo || e.issues.some((i) => repoSlugFromUrl(i.url)?.toLowerCase() === repo));
  let changed = false;
  for (const [key, e] of [...cache.map]) {
    if (key === target.cwd || holds(e)) changed = cache.map.delete(key) || changed;
  }
  if (changed) cache.version.value++;
}

/**
 * Store `cwd`'s entry as the most recently used, dropping the oldest beyond
 * the cap. `changed: false` only marks it used (a read), without a re-render.
 */
function remember(cache: IssueCache, cwd: string, e: Entry, changed = true): void {
  cache.map.delete(cwd);
  cache.map.set(cwd, e);
  while (cache.map.size > ISSUE_CACHE_MAX_REPOS) cache.map.delete(cache.map.keys().next().value as string);
  if (changed) cache.version.value++;
}

export function useIssueSuggest(deps: IssueSuggestDeps): {
  open: Ref<boolean>;
  status: ComputedRef<SuggestStatus>;
  rows: ComputedRef<Issue[]>;
  active: Ref<number>;
  armed: ComputedRef<boolean>;
  query: Ref<string>;
  update(text: string, caret: number): void;
  refresh(text: string, caret: number): void;
  retry(text: string, caret: number): void;
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
  let end = 0;
  /** A `#` was typed while the forge was not known yet: `retry` opens it then. */
  let missed = false;
  /** The text `update` last read; a different one (set by code) closes the list. */
  let lastText = "";
  /** An arrow chose a row (`armed` explains when Enter and Tab pick). */
  const navigated = ref(false);

  const entry = (): Entry | undefined => {
    void version.value;
    const cwd = deps.cwd();
    return cwd ? cache.get(cwd) : undefined;
  };

  /**
   * Whether Enter and Tab pick the highlighted row: only once an arrow chose
   * it. A typed `#12` already is the reference, and a word (`#android`) or a
   * bare `#` must keep Enter (a newline) and Tab (the next field).
   */
  const armed = computed(() => navigated.value && rows.value.length > 0);

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
    // Within the TTL: a loading entry is in flight (one that never settles is
    // retried after it), a ready one is fresh, an error waits for a reopening.
    const slug = deps.pushRepo(cwd);
    const young = !!cached && now() - cached.at <= ISSUE_CACHE_TTL_MS && cached.slug === slug;
    if (cached && young && (cached.status !== "error" || !opening)) {
      remember(store, cwd, cached, false);
      return true;
    }
    const pending = deps.loadIssues(cwd);
    if (!pending) return false;
    const req = ++nextRequest;
    // A refresh offers the issues it replaces, never another remote's.
    const previous = cached?.slug === slug ? cached.issues : [];
    remember(store, cwd, { at: now(), status: "loading", issues: previous, req, slug });
    // Only the answer to the entry's own request lands: one that an
    // invalidation, an eviction or a newer request replaced would bring back
    // an older list (without the issue just created, say).
    const settle = (status: "ready" | "error", issues: Issue[]) => {
      if (cache.get(cwd)?.req === req) remember(store, cwd, { at: now(), status, issues, req, slug });
    };
    // A failed refresh keeps offering the issues it would have replaced
    // (retried after the TTL); with none, the list says it is unavailable.
    pending.then(
      (issues) => settle("ready", issues),
      () => settle(previous.length ? "ready" : "error", previous),
    );
    return true;
  }

  function close() {
    open.value = false;
    query.value = "";
    active.value = 0;
    navigated.value = false;
  }

  function update(text: string, at: number) {
    const token = hashTokenAt(text, at);
    const cwd = deps.cwd();
    missed = false;
    if (!token || !cwd) return close();
    if (!ensureLoaded(cwd, !open.value)) {
      missed = true;
      return close();
    }
    if (!open.value || token.query !== query.value) {
      active.value = 0;
      navigated.value = false;
    }
    start = token.start;
    end = token.end;
    lastText = text;
    query.value = token.query;
    open.value = true;
  }

  function pick(index: number, fixes: boolean, text: string): Picked | null {
    const chosen = rows.value[index];
    if (!open.value || !chosen) return null;
    const cwd = deps.cwd();
    const ref = issueRef(chosen.number, repoSlugFromUrl(chosen.url), cwd ? deps.pushRepo(cwd) : null);
    const out = insertRef(text, start, end, ref, fixes);
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
    // On a bare `#` (a Markdown heading) the arrows still move through the text.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && query.value !== "") {
      active.value = (active.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      navigated.value = true;
      return "handled";
    }
    if (!armed.value) return null;
    if (e.key === "Tab" && e.shiftKey) return null; // moving focus back, not a pick
    if (e.key === "Enter" || e.key === "Tab") return pick(Math.min(active.value, n - 1), e.key === "Enter" && e.shiftKey, text);
    return null;
  }

  /** A caret move (click, arrows): follows an open list, never opens one. */
  function refresh(text: string, at: number) {
    if (open.value) update(text, at);
  }

  /** The forge just became known: open the list a typed `#` could not. */
  function retry(text: string, at: number) {
    if (missed) update(text, at);
  }

  /** The field's value as rendered: a change no `update` saw closes the list. */
  function sync(text: string) {
    if (open.value && text !== lastText) close();
  }

  return { open, status, rows, active, armed, query, update, refresh, retry, keydown, pick, close, sync };
}

export type IssueSuggest = ReturnType<typeof useIssueSuggest>;
type Field = HTMLInputElement | HTMLTextAreaElement;

/** Read the `#token` at the field's caret after typing: may open the list. */
export function refreshIssueSuggest(s: IssueSuggest, el: Field): void {
  s.update(el.value, el.selectionStart ?? el.value.length);
}

/** The forge just became known: open the list a `#` typed before could not. */
export function retryIssueSuggest(s: IssueSuggest, el: Field): void {
  s.retry(el.value, el.selectionStart ?? el.value.length);
}

/** Follow a caret move (click, caret keys): only an open list is updated. */
export function followIssueCaret(s: IssueSuggest, el: Field): void {
  s.refresh(el.value, el.selectionStart ?? el.value.length);
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
  followIssueCaret(s, el);
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
