import { ref } from "vue";
import { readFile, writeFile, type SnapshotMeta } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Optional AI one-line labels for Time Machine snapshots (v3.8).
 *
 * Opt-in and lazy: nothing runs unless the user asks for a label on a
 * specific snapshot, matching the Quick Stash label pattern (v2.15.1).
 *
 * Labels live in a sidecar file rather than the snapshot commit message,
 * which is immutable. A desync there is harmless: a missing label just falls
 * back to the mechanical one.
 */

/**
 * Flat, not nested: `write_file` is a bare `std::fs::write` with no
 * `create_dir_all` (see `commands/files.rs`). `.git/` is inside the repo
 * root so it passes `safe_repo_path`, and nothing there shows up as an
 * untracked file.
 */
const LABEL_FILE = ".git/gitwand-snapshot-labels.json";

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

const labels = ref<Record<string, string>>({});
const pending = ref<Set<string>>(new Set());

export function useSnapshotLabels() {
  const ai = useAIProvider();

  async function load(cwd: string): Promise<void> {
    try {
      const raw = await readFile(cwd, LABEL_FILE);
      const parsed = JSON.parse(raw) as unknown;
      // Guard the shape: a hand-edited or truncated file must not poison the
      // panel with non-string values.
      labels.value =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      // No sidecar yet, or unreadable, or not JSON: labels are optional by
      // construction, so this is never worth surfacing.
      labels.value = {};
    }
  }

  async function persist(cwd: string): Promise<void> {
    try {
      await writeFile(cwd, LABEL_FILE, JSON.stringify(labels.value, null, 2));
    } catch {
      // Losing a cached label costs one extra model call, nothing more.
    }
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
      await persist(cwd);
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
