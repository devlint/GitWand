import { ref } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Natural-language commit search.
 *
 * The composable ships two modes:
 *
 * 1. `filterLocal` — instant substring/word match on subject + body +
 *    author. Runs entirely in memory, no API call. Good for quick
 *    "who-touched-this" lookups.
 *
 * 2. `searchAI` — sends the query + the commit list (subjects, bodies,
 *    authors, dates) to the configured AI provider, which returns the
 *    subset of commit hashes that match the intent of the query.
 *    Great for questions like "when did we introduce log pagination?"
 *    that a substring match would miss.
 *
 * Both methods return **the same GitLogEntry objects**, so the caller
 * can keep its rendering path unchanged.
 */

export interface CommitSearchOptions {
  /** Max number of commits sent to the AI (default 200). */
  maxCommits?: number;
  /** Max characters kept from each commit body (default 800). */
  maxBodyChars?: number;
  /** Optional locale used to hint the LLM on response language for reasons. */
  locale?: string;
}

export interface CommitMatch {
  entry: GitLogEntry;
  /** Optional one-line rationale, present only for AI mode. */
  reason?: string;
}

function normalize(s: string): string {
  return s.toLowerCase();
}

/**
 * Quick substring match across subject / body / author / hash.
 * Returns a filtered list in the original order.
 */
export function filterCommitsLocal(
  entries: GitLogEntry[],
  query: string,
): GitLogEntry[] {
  const q = query.trim();
  if (!q) return entries;
  const needle = normalize(q);
  return entries.filter((e) => {
    return (
      normalize(e.message).includes(needle)
      || (e.body && normalize(e.body).includes(needle))
      || normalize(e.author).includes(needle)
      || e.hash.startsWith(q)
      || e.hashFull.startsWith(q)
    );
  });
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}

function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You help a developer search a Git commit log in natural language.

You will receive:
- A user query in ${lang} or English.
- A numbered list of commits (short hash, subject, author, date,
  optional body).

Return the commits that MATCH the intent of the query. Support
questions like "when did we add pagination?", "who touched the
authentication flow last month?", "find all hotfixes", etc.

Output strict JSON, no markdown fences, no preamble:
{
  "matches": [
    { "hash": "<full hash, exactly as provided>", "reason": "<one short sentence in ${lang}>" }
  ]
}

Rules:
- hash MUST be one of the provided full hashes, verbatim.
- Prefer recall but cap the list at 25 entries — pick the most
  relevant if there are more.
- If nothing matches, return { "matches": [] } (no error).`;
}

function buildUserPrompt(
  query: string,
  entries: GitLogEntry[],
  maxBodyChars: number,
): string {
  const lines: string[] = [];
  lines.push(`Query: ${query.trim()}`);
  lines.push("");
  lines.push(`Commits (${entries.length}, newest first):`);
  entries.forEach((e, idx) => {
    const body = (e.body ?? "").trim();
    lines.push(`[${idx}] ${e.hashFull}`);
    lines.push(`    subject: ${e.message}`);
    lines.push(`    author: ${e.author} <${e.email}>, ${e.date}`);
    if (body) {
      lines.push(`    body: ${clip(body, maxBodyChars).replace(/\n/g, " / ")}`);
    }
  });
  lines.push("");
  lines.push("Return the matches.");
  return lines.join("\n");
}

function parseResponse(raw: string, allowedHashes: Set<string>): Array<{ hash: string; reason?: string }> {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (brace !== -1 && lastBrace > brace) s = s.slice(brace, lastBrace + 1);
  try {
    const obj = JSON.parse(s);
    const rawMatches: unknown[] = Array.isArray(obj?.matches) ? obj.matches : [];
    const out: Array<{ hash: string; reason?: string }> = [];
    const seen = new Set<string>();
    for (const m of rawMatches) {
      if (!m || typeof m !== "object") continue;
      const o = m as Record<string, unknown>;
      const h = typeof o.hash === "string" ? o.hash : "";
      if (!allowedHashes.has(h) || seen.has(h)) continue;
      seen.add(h);
      out.push({ hash: h, reason: typeof o.reason === "string" ? o.reason : undefined });
    }
    return out;
  } catch {
    return [];
  }
}

const isSearching = ref(false);
const lastError = ref<string | null>(null);

export function useCommitSearch() {
  const ai = useAIProvider();

  /**
   * Natural-language AI search. Returns the matched commits in the
   * order the LLM listed them (typically most-relevant first), with
   * an optional short rationale per match.
   */
  async function searchAI(
    query: string,
    entries: GitLogEntry[],
    options: CommitSearchOptions = {},
  ): Promise<CommitMatch[]> {
    const { maxCommits = 200, maxBodyChars = 800, locale = "fr" } = options;

    isSearching.value = true;
    lastError.value = null;

    try {
      if (!ai.isAvailable.value) {
        throw new Error(
          "Aucun provider IA configuré. Ouvre les paramètres pour en activer un.",
        );
      }
      if (!query.trim()) {
        throw new Error("Saisis une requête avant de lancer la recherche IA.");
      }
      if (entries.length === 0) {
        return [];
      }

      const slice = entries.slice(0, maxCommits);
      const systemPrompt = buildSystemPrompt(locale);
      const userPrompt = buildUserPrompt(query, slice, maxBodyChars);

      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) {
        throw new Error("Le provider IA n'a retourné aucune réponse.");
      }

      const allowed = new Set(slice.map((e) => e.hashFull));
      const matches = parseResponse(raw, allowed);

      // Map back to entries, preserving the LLM order.
      const byHash = new Map(slice.map((e) => [e.hashFull, e] as const));
      const out: CommitMatch[] = [];
      for (const m of matches) {
        const entry = byHash.get(m.hash);
        if (!entry) continue;
        out.push(m.reason === undefined ? { entry } : { entry, reason: m.reason });
      }
      return out;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.value = msg;
      throw err;
    } finally {
      isSearching.value = false;
    }
  }

  return {
    isSearching,
    lastError,
    searchAI,
    filterLocal: filterCommitsLocal,
  };
}
