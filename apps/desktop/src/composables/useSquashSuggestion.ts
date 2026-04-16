import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";
import type { RebaseTodoEntry } from "./useInteractiveRebase";

/**
 * Asks the configured AI provider to group a rebase-todo list into
 * semantic squash clusters. Each cluster is a contiguous run of commits
 * that share an intent ("4 fixups of the same test", "iterations on the
 * same refactor") and that it's safe to squash together.
 *
 * The composable is purely advisory: it returns a plan, and the UI
 * decides whether to apply it (by calling `setAction(idx, 'squash')`
 * on the right entries). No git command is run from here — we just
 * enrich the entries with their bodies so the LLM has the context it
 * needs to reason about intent.
 */

export interface SquashGroup {
  /** Contiguous list of entry indices to merge, in order. At least 2 items. */
  indices: number[];
  /** Short human-readable rationale (in the user's locale). */
  reason: string;
  /** Optional suggested combined subject line (<=72 chars). */
  combinedSubject?: string;
}

export interface SquashSuggestion {
  /** Suggested groups. May be empty if the LLM sees nothing to collapse. */
  groups: SquashGroup[];
  /** Plain-text summary from the LLM, one line. */
  summary: string;
}

export interface SquashSuggestionOptions {
  /** UI locale — drives the language of reason / summary fields. */
  locale?: string;
  /** Max number of body characters kept per commit (default 1500). */
  maxBodyChars?: number;
}

function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You are a senior engineer reviewing a Git rebase-todo list and
proposing which commits should be squashed together.

You will receive a numbered list of commits in rebase order
(oldest first). For each commit you get: subject, body (possibly empty),
author, short hash.

Your job: return a JSON plan identifying groups of CONTIGUOUS commits
that share a single intent and should be squashed into one. Examples
of good groups:
- Several "wip" / "fix typo" / "address review" commits on the same
  feature.
- Iterations of the same refactor ("extract helper", "rename helper",
  "inline helper").
- A feature commit followed immediately by its fixes or test updates.

Do NOT group commits that have distinct intents, even if they are
adjacent. Leave them as a single-commit "group" — or rather, don't
include them in the output at all. It's perfectly valid to return
zero groups.

Output format (strict JSON, no markdown fences, no preamble):
{
  "summary": "<one-line summary in ${lang}>",
  "groups": [
    {
      "indices": [<int>, <int>, ...],     // 0-based indices, contiguous, length >=2
      "reason": "<short rationale in ${lang}>",
      "combinedSubject": "<optional combined subject, <=72 chars>"
    }
  ]
}

Rules:
- Indices MUST be 0-based and strictly increasing.
- Each group's indices MUST be contiguous (e.g. [2,3,4] is valid,
  [2,4,5] is not).
- Groups MUST NOT overlap with each other.
- A single group MUST contain at least 2 indices (squashing 1 commit
  into nothing is meaningless).
- If you are uncertain, err on the side of NOT grouping.`;
}

function buildUserPrompt(entries: Array<RebaseTodoEntry & { body?: string }>, maxBodyChars: number): string {
  const lines: string[] = [];
  lines.push(`Rebase plan, ${entries.length} commits (oldest first):`);
  lines.push("");
  entries.forEach((e, idx) => {
    const body = (e.body ?? "").trim();
    const clippedBody = body.length > maxBodyChars
      ? body.slice(0, maxBodyChars) + "\n... (truncated)"
      : body;
    lines.push(`[${idx}] ${e.hash} — ${e.message}`);
    lines.push(`    author: ${e.author}, ${e.date}`);
    if (clippedBody) {
      lines.push("    body:");
      for (const bl of clippedBody.split(/\r?\n/)) {
        lines.push(`      ${bl}`);
      }
    }
  });
  lines.push("");
  lines.push("Propose squash groups.");
  return lines.join("\n");
}

function parseResponse(raw: string): SquashSuggestion {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (brace !== -1 && lastBrace > brace) s = s.slice(brace, lastBrace + 1);
  const obj = JSON.parse(s);
  const rawGroups: unknown[] = Array.isArray(obj?.groups) ? obj.groups : [];
  const groups: SquashGroup[] = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== "object") continue;
    const ginst = g as Record<string, unknown>;
    const indices = Array.isArray(ginst.indices)
      ? ginst.indices.filter((n): n is number => Number.isInteger(n))
      : [];
    if (indices.length < 2) continue;
    // Ensure strictly increasing + contiguous
    let contiguous = true;
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) { contiguous = false; break; }
    }
    if (!contiguous) continue;
    groups.push({
      indices,
      reason: typeof ginst.reason === "string" ? ginst.reason : "",
      combinedSubject: typeof ginst.combinedSubject === "string" ? ginst.combinedSubject : undefined,
    });
  }
  // Reject overlapping groups (keep earlier ones, drop later overlaps).
  const used = new Set<number>();
  const filtered: SquashGroup[] = [];
  for (const g of groups) {
    if (g.indices.some((i) => used.has(i))) continue;
    for (const i of g.indices) used.add(i);
    filtered.push(g);
  }
  return {
    summary: typeof obj?.summary === "string" ? obj.summary : "",
    groups: filtered,
  };
}

const isGenerating = ref(false);
const lastError = ref<string | null>(null);
const lastSuggestion = ref<SquashSuggestion | null>(null);

export function useSquashSuggestion() {
  const ai = useAIProvider();

  /**
   * Fetch the body of every commit in the todo list and ask the LLM
   * for a squash plan. Returns `null` if the LLM proposes no groups.
   */
  async function suggest(
    cwd: string,
    entries: RebaseTodoEntry[],
    options: SquashSuggestionOptions = {},
  ): Promise<SquashSuggestion> {
    const { locale = "fr", maxBodyChars = 1500 } = options;

    isGenerating.value = true;
    lastError.value = null;
    lastSuggestion.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (entries.length < 2) {
        throw new Error("Au moins deux commits sont nécessaires pour suggérer un squash.");
      }
      if (!cwd) throw new Error("Aucun repo ouvert (cwd vide).");

      // Fetch full bodies for all commits. Using a rare delimiter so we
      // can parse reliably even when bodies contain blank lines.
      const DELIM = "---GITWAND-REBASE-AI---";
      const hashes = entries.map((e) => e.fullHash);
      const format = `%H%n%B%n${DELIM}`;
      const args = ["show", "-s", `--format=${format}`, ...hashes];
      let logOut = "";
      try {
        const res = await gitExec(cwd, args);
        if (res.exitCode !== 0) {
          throw new Error(res.stderr || `git show failed (exit ${res.exitCode})`);
        }
        logOut = res.stdout ?? "";
      } catch (execErr: unknown) {
        throw new Error(
          `git exec failed: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        );
      }

      // Split by delimiter; each chunk starts with the full hash.
      const bodies = new Map<string, string>();
      for (const chunk of logOut.split(DELIM)) {
        const c = chunk.trim();
        if (!c) continue;
        const nlIdx = c.indexOf("\n");
        const fullHash = (nlIdx === -1 ? c : c.slice(0, nlIdx)).trim();
        const body = nlIdx === -1 ? "" : c.slice(nlIdx + 1).trim();
        bodies.set(fullHash, body);
      }

      // Strip the subject (first line of %B) from the body so we don't
      // duplicate it in the prompt.
      const enriched = entries.map((e) => {
        const fullBody = bodies.get(e.fullHash) ?? "";
        const lines = fullBody.split(/\r?\n/);
        const body = lines.slice(1).join("\n").trim();
        return { ...e, body };
      });

      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(enriched, maxBodyChars);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }

      let suggestion: SquashSuggestion;
      try {
        suggestion = parseResponse(raw);
      } catch {
        throw new Error(
          "La réponse du provider IA n'a pas pu être interprétée (JSON invalide).",
        );
      }

      // Final sanity: every index must be in range.
      suggestion.groups = suggestion.groups.filter((g) =>
        g.indices.every((i) => i >= 0 && i < entries.length),
      );

      lastSuggestion.value = suggestion;
      return suggestion;
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
    lastSuggestion,
    suggest,
  };
}
