import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Suggests a Git branch name from:
 *   - a short description typed by the user (e.g. "user auth oauth pkce")
 *   - and/or the current working-tree diff (if there is any WIP)
 *
 * Reuses the same multi-provider plumbing as {@link useAIProvider.rawPrompt}
 * (Claude API, Claude Code CLI, OpenAI-compat, Ollama).
 *
 * The model is asked to emit a single kebab-case branch name with a
 * conventional type prefix (`feat/…`, `fix/…`, `chore/…`, `docs/…`,
 * `refactor/…`, `test/…`). The composable strips any stray punctuation,
 * quotes, or trailing explanations before returning.
 */

export interface BranchNameOptions {
  /** Max number of diff characters sent to the model (default 6k). */
  maxDiffChars?: number;
  /** Soft cap on the total branch name length (default 60). */
  maxLen?: number;
}

const ALLOWED_PREFIXES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "build", "ci", "style"] as const;

function buildSystemPrompt(): string {
  return `You are a senior engineer proposing a Git branch name.

Rules:
1. Output ONE line only — the branch name, nothing else.
2. Use kebab-case (lowercase, words separated by hyphens).
3. Start with a conventional type prefix followed by "/":
   ${ALLOWED_PREFIXES.join(", ")}.
4. Keep the whole branch name under 60 characters.
5. Focus on INTENT, not mechanics. "feat/oauth2-pkce" beats
   "feat/change-12-files".
6. Never wrap in quotes, code fences, or add explanations.
7. If the user's description already looks like a valid kebab-case
   branch name with a type prefix, return it (lightly cleaned up) —
   don't reinvent what's good enough.`;
}

function buildUserPrompt(description: string, diff: string, diffstat: string): string {
  const parts: string[] = [];
  if (description.trim()) {
    parts.push(`User description / hint: ${description.trim()}`);
  } else {
    parts.push("(No user description — infer the branch name from the diff.)");
  }
  if (diff) {
    parts.push("");
    parts.push("--- git diff (working tree, may be empty) ---");
    parts.push(diff);
  }
  if (diffstat) {
    parts.push("");
    parts.push("--- diffstat ---");
    parts.push(diffstat);
  }
  parts.push("");
  parts.push("Output the branch name.");
  return parts.join("\n");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}

/** Turn whatever the model returned into a clean git-ref-safe branch name. */
function sanitizeBranchName(raw: string, maxLen: number): string {
  let name = (raw ?? "").trim();
  // Keep only the first line.
  name = name.split(/\r?\n/)[0] ?? "";
  // Strip code fences / quotes / trailing punctuation.
  name = name.replace(/^```.*?$/g, "").replace(/```$/g, "");
  name = name.replace(/^["'`]+|["'`]+$/g, "");
  name = name.replace(/^branch(\s*name)?:\s*/i, "");
  name = name.trim();
  // Lowercase, replace whitespace + underscores by hyphens.
  name = name.toLowerCase().replace(/[\s_]+/g, "-");
  // Drop characters Git refuses in ref names.
  name = name.replace(/[~^:?*\[\]\\]/g, "");
  // Collapse consecutive slashes and hyphens.
  name = name.replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-");
  // Trim leading/trailing slashes and hyphens on each path segment.
  name = name
    .split("/")
    .map((seg) => seg.replace(/^[-.]+|[-.]+$/g, ""))
    .filter(Boolean)
    .join("/");
  if (name.length > maxLen) name = name.slice(0, maxLen).replace(/-+$/g, "");
  return name;
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);

export function useBranchName() {
  const ai = useAIProvider();

  async function suggest(
    cwd: string,
    description: string,
    options: BranchNameOptions = {},
  ): Promise<string> {
    const { maxDiffChars = 6_000, maxLen = 60 } = options;

    isGenerating.value = true;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!description.trim() && !cwd) {
        throw new Error(
          "Donne une description ou ouvre un repo — rien à proposer sinon.",
        );
      }

      // Pull a small slice of the WIP diff for context — tolerant of
      // repos with no cwd or no changes.
      let diff = "";
      let diffstat = "";
      if (cwd) {
        try {
          const [diffRes, statRes] = await Promise.all([
            gitExec(cwd, ["diff", "HEAD", "--no-color"]),
            gitExec(cwd, ["diff", "HEAD", "--stat", "--no-color"]),
          ]);
          diff = clip((diffRes.stdout ?? "").trim(), maxDiffChars);
          diffstat = (statRes.stdout ?? "").trim();
        } catch {
          // Ignore — work from the description alone.
        }
      }

      if (!description.trim() && !diff) {
        throw new Error(
          "Aucune description et aucune modification locale — tape quelques mots pour guider la suggestion.",
        );
      }

      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt(description, diff, diffstat);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }

      const clean = sanitizeBranchName(raw, maxLen);
      if (!clean) {
        throw new Error(
          "La réponse du provider IA n'a pas pu être convertie en nom de branche valide.",
        );
      }
      return clean;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.value = msg;
      throw err;
    } finally {
      isGenerating.value = false;
    }
  }

  return {
    isGenerating,
    lastError,
    suggest,
  };
}
