/**
 * `#` in a commit field lists the repository's open issues (#301, part 4).
 *
 * One instance per field. The text logic is in `utils/issueRefs`; this holds
 * the list's state, a per-repository cache (refreshed after 60 s) and the key
 * handling. Nothing is fetched until a `#` opens the list.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { Issue } from "../utils/backend";
import { filterIssues, hashTokenAt, insertRef, issueRef, repoSlugFromUrl } from "../utils/issueRefs";

export const ISSUE_CACHE_TTL_MS = 60_000;

export interface IssueSuggestDeps {
  cwd: () => string | null;
  /** null when the forge cannot list issues (then there is no list at all). */
  loadIssues: (cwd: string) => Promise<Issue[]> | null;
  /** `owner/repo` of the repository the commit is pushed to, or null. */
  pushRepo: (cwd: string) => Promise<string | null>;
  now?: () => number;
}

export type SuggestStatus = "idle" | "loading" | "ready" | "error";

interface Entry {
  at: number;
  status: "loading" | "ready" | "error";
  issues: Issue[];
  pushRepo: string | null;
}

export type Picked = { text: string; caret: number };

export function useIssueSuggest(deps: IssueSuggestDeps): {
  open: Ref<boolean>;
  status: ComputedRef<SuggestStatus>;
  rows: ComputedRef<Issue[]>;
  active: Ref<number>;
  update(text: string, caret: number): void;
  keydown(e: KeyboardEvent, text: string): Picked | "handled" | null;
  pick(index: number, fixes: boolean, text: string): Picked | null;
  close(): void;
} {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, Entry>();
  /** Bumped whenever the cache changes, so the computeds re-read it. */
  const version = ref(0);
  const open = ref(false);
  const query = ref("");
  const active = ref(0);
  let start = 0;
  let caret = 0;

  const entry = (): Entry | undefined => {
    void version.value;
    const cwd = deps.cwd();
    return cwd ? cache.get(cwd) : undefined;
  };

  const status = computed<SuggestStatus>(() => (open.value ? entry()?.status ?? "loading" : "idle"));
  const rows = computed<Issue[]>(() => {
    const e = entry();
    return open.value && e?.status === "ready" ? filterIssues(e.issues, query.value) : [];
  });

  /** Fetch the issues for `cwd` unless fresh ones are cached. false: this forge has no list. */
  function ensureLoaded(cwd: string): boolean {
    const cached = cache.get(cwd);
    if (cached && (cached.status === "loading" || now() - cached.at <= ISSUE_CACHE_TTL_MS)) return true;
    const pending = deps.loadIssues(cwd);
    if (!pending) return false;
    const e: Entry = { at: now(), status: "loading", issues: cached?.issues ?? [], pushRepo: cached?.pushRepo ?? null };
    cache.set(cwd, e);
    version.value++;
    Promise.all([pending, deps.pushRepo(cwd).catch(() => null)]).then(
      ([issues, push]) => {
        cache.set(cwd, { at: now(), status: "ready", issues, pushRepo: push });
        version.value++;
      },
      () => {
        cache.set(cwd, { at: now(), status: "error", issues: [], pushRepo: null });
        version.value++;
      },
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
    if (!ensureLoaded(cwd)) return close();
    if (!open.value || token.query !== query.value) active.value = 0;
    start = token.start;
    caret = at;
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
    if (!open.value || e.isComposing) return null;
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

  return { open, status, rows, active, update, keydown, pick, close };
}
