import { ref } from "vue";
import type { SnapshotMeta } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Optional AI one-line labels for Time Machine snapshots (v3.8).
 *
 * Opt-in and lazy: nothing runs unless the user asks for a label on a
 * specific snapshot, matching the Quick Stash label pattern (v2.15.1).
 *
 * Stored in `localStorage`, keyed by repo path, like the other ancillary
 * per-user state in this app (`useResolutionMemory`, `useLaunchpadPins`,
 * `useTierStats`). An earlier draft wrote a sidecar file under `.git/`, which
 * silently never worked in a linked worktree: there `.git` is a FILE, not a
 * directory, so every read and write failed with ENOTDIR and the error was
 * swallowed. GitWand treats worktrees as first-class (tab = worktree since
 * v2.7.0, plus scratch and AI-task worktrees), so that was a normal state,
 * not an edge case.
 *
 * Losing this store costs nothing but a repeat model call: a missing label
 * falls back to the mechanical one.
 */

const STORAGE_KEY = "gitwand-snapshot-labels";

const SYSTEM_PROMPT = `You are a senior software engineer labelling a repository snapshot.

Rules:
1. Output ONE line only, 72 characters maximum.
2. No quotes, no code fences, no explanations, no trailing period.
3. Describe what state is being preserved, not the mechanics.
4. Write in English.`;

function buildPrompt(snapshot: SnapshotMeta): string {
  return `Summarise this repository snapshot as one line.

Trigger: ${snapshot.kind}
Mechanical label: ${snapshot.label}
Branch: ${snapshot.headRef ?? "(detached)"}`;
}

/** `{ [repoPath]: { [snapshotId]: label } }` */
type LabelStore = Record<string, Record<string, string>>;

function readStore(): LabelStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Guard the shape: a hand-edited or truncated entry must not poison the
    // panel with non-object values.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LabelStore)
      : {};
  } catch {
    return {};
  }
}

function writeStore(store: LabelStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota or a locked store: one extra model call, nothing more.
  }
}

const labels = ref<Record<string, string>>({});
const pending = ref<Set<string>>(new Set());

export function useSnapshotLabels() {
  const ai = useAIProvider();

  async function load(cwd: string): Promise<void> {
    const forRepo = readStore()[cwd];
    labels.value =
      forRepo && typeof forRepo === "object" && !Array.isArray(forRepo) ? forRepo : {};
  }

  function persist(cwd: string): void {
    const store = readStore();
    store[cwd] = labels.value;
    writeStore(store);
  }

  async function generate(cwd: string, snapshot: SnapshotMeta): Promise<string | null> {
    const cached = labels.value[snapshot.id];
    if (cached) return cached;
    if (!ai.isAvailable.value) return null;

    pending.value = new Set([...pending.value, snapshot.id]);
    try {
      const raw = await ai.rawPrompt(SYSTEM_PROMPT, buildPrompt(snapshot));
      const text = (raw ?? "").trim().split("\n")[0].trim();
      if (!text) return null;
      labels.value = { ...labels.value, [snapshot.id]: text };
      persist(cwd);
      return text;
    } catch {
      return null;
    } finally {
      const next = new Set(pending.value);
      next.delete(snapshot.id);
      pending.value = next;
    }
  }

  return { labels, pending, load, generate };
}
