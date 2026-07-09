/**
 * usePrPreReview.ts
 *
 * Local, multi-hop AI pre-review engine (C1, v3.6.0) — Greptile-style,
 * opt-in, background pass over a PR's touched files:
 *   1. Diff hop    — hunks from the already-parsed `GitDiff` (A1).
 *   2. Dependency hop — import specifiers extracted from the file's touched
 *      lines (`extractImportSources` from `@gitwand/core`, extraction only —
 *      no resolved graph, that's v4.0), cross-referenced against the *other*
 *      files in the same diff to flag "imported by N diff files".
 *   3. History hop — `git blame` on the changed lines (`getGitBlame`,
 *      forge-agnostic — works identically on all 4 forges).
 *   4. Findings    — one LLM call per file, strict JSON, defensively parsed.
 *
 * `usePrReviewQueue` (C3) sequences `analyzeFile` across a PR's files;
 * `useReviewIntelligence` (E2) composes this engine into the unified
 * Intelligence surface.
 */
import { extractImportSources } from "@gitwand/core";
import type { GitDiff, BlameLine } from "../utils/backend";
import { getGitBlame } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

export interface ReviewFinding {
  /** Stable hash of path+line+title — used for dismissal (C2) and nav (C4). */
  id: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: "risk" | "suggestion" | "nit";
  /** 0-100. */
  confidence: number;
  title: string;
  detail: string;
}

export interface AnalyzeFileOptions {
  cwd: string;
  /** UI locale — drives the response language. */
  locale?: string;
  /** The other files touched in this PR (excluding `file`) — used for the
   *  dependency-hop cross-reference. */
  otherDiffFiles: GitDiff[];
  /** Max characters of hunk text sent per file (default 6 000 — files get
   *  a bigger budget than the single-hunk critique since findings are
   *  file-scoped, not hunk-scoped). */
  maxFileChars?: number;
}

// ─── Hop 2: dependency (extraction + cross-reference, no graph) ───────────

/** Import specifiers touched by `file`'s hunks (added/context lines only —
 *  deleted lines carry no signal about the *current* state of the file). */
export function importSourcesForFile(file: GitDiff): string[] {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.type !== "delete") lines.push(dl.content);
    }
  }
  return extractImportSources(lines.join("\n"));
}

/** True when a relative import `specifier` (as written in another file)
 *  plausibly resolves to `path` — basename match, extension-insensitive.
 *  Bare package specifiers (no leading `.`) never match a repo-local path. */
function specifierMatchesPath(specifier: string, path: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const stripExt = (s: string) => s.replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue)$/, "");
  const specBase = stripExt(specifier.split("/").pop() ?? "");
  const pathBase = stripExt(path.split("/").pop() ?? "");
  return !!specBase && specBase === pathBase;
}

/** How many of `otherFiles` import `file` — the "imported by N diff files"
 *  signal. Heuristic basename matching, not a resolved graph (v4.0). */
export function computeImportedByCount(file: GitDiff, otherFiles: GitDiff[]): number {
  let count = 0;
  for (const other of otherFiles) {
    if (other.path === file.path) continue;
    const sources = importSourcesForFile(other);
    if (sources.some((s) => specifierMatchesPath(s, file.path))) count++;
  }
  return count;
}

// ─── Hop 3: history (blame on changed lines) ──────────────────────────────

/** Line numbers (new side) touched by `file`'s hunks — add + context, since
 *  a context line's surrounding history can still be relevant, but capped
 *  to the lines the diff actually shows to keep the blame summary tight. */
function changedNewLineNumbers(file: GitDiff): Set<number> {
  const nums = new Set<number>();
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.type === "add" && dl.newLineNo != null) nums.add(dl.newLineNo);
    }
  }
  return nums;
}

/** Deduped "author: summary" lines for the blame entries covering `file`'s
 *  added lines. Best-effort — `getGitBlame` reflects the current checkout,
 *  which may already include this PR's own commits if the branch is
 *  checked out locally (no base-relative blame command exists yet). */
export function summarizeBlameForFile(blame: BlameLine[], file: GitDiff): string[] {
  const lineNos = changedNewLineNumbers(file);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of blame) {
    if (!lineNos.has(b.finalLine)) continue;
    const key = `${b.author}::${b.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${b.author}: ${b.summary}`);
  }
  return out;
}

// ─── Hop 4: findings (strict JSON, defensive parse) ───────────────────────

function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You are a senior engineer doing a pre-review pass on one file of a pull request.

You will receive:
- The file path.
- The file's touched hunks (unified-diff content).
- A dependency signal: how many other files in this same PR import this file.
- A brief history signal: recent commit summaries that touched the lines
  now being changed.

Produce a JSON array of findings — an empty array \`[]\` when there is
nothing worth flagging:
[
  {
    "line": <number, the new-file line number>,
    "side": "LEFT" | "RIGHT",
    "severity": "risk" | "suggestion" | "nit",
    "confidence": <0-100>,
    "title": "<short title>",
    "detail": "<1-3 sentences in ${lang}>"
  }
]

Severity scale:
- "risk"       → likely bug, security issue, breaking change.
- "suggestion" → concrete improvement (edge case, missing test, naming).
- "nit"        → minor style/readability, non-blocking.

Rules:
- confidence reflects how sure you are this is a real, actionable issue —
  not how severe it is. A risky-looking but uncertain guess should have a
  LOW confidence, not a high one.
- Weigh the dependency signal: a file imported by many other diff files in
  this PR deserves more scrutiny (its bugs have wider blast radius).
- Never invent symbols or behaviour not shown in the hunks.
- Write "detail" in ${lang}. Output ONLY the JSON array, no prose, no code
  fences.`;
}

function fileToHunkText(file: GitDiff, maxChars: number): string {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    for (const dl of hunk.lines) {
      const marker = dl.type === "add" ? "+" : dl.type === "delete" ? "-" : " ";
      const lineNo = dl.type === "delete" ? dl.oldLineNo : dl.newLineNo;
      lines.push(`${marker}[${lineNo ?? "?"}] ${dl.content}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars) + "\n... (truncated)";
}

export function buildUserPrompt(
  file: GitDiff,
  importedByCount: number,
  blameSummaries: string[],
  maxFileChars: number,
): string {
  const parts: string[] = [];
  parts.push(`File: ${file.path}`);
  parts.push(`Imported by ${importedByCount} other file(s) in this diff.`);
  if (blameSummaries.length) {
    parts.push("Recent history on the changed lines:");
    for (const s of blameSummaries.slice(0, 10)) parts.push(`- ${s}`);
  }
  parts.push("");
  parts.push("--- hunks ---");
  parts.push(fileToHunkText(file, maxFileChars));
  return parts.join("\n");
}

/** Simple string hash (djb2) — stable across runs for the same input, used
 *  as the finding's dismissal/nav id. Not cryptographic; collisions are an
 *  acceptable risk for this UI-only identity. */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Defensive JSON-array parse — recovers from a ```json fence or surrounding
 * prose (mirrors `usePrHunkCritique.ts`'s object parse, generalized to an
 * array). Clamps confidence to 0-100, coerces an unknown severity to
 * "suggestion", and drops entries missing `line`/`title`.
 */
export function parseFindings(raw: string, path: string): ReviewFinding[] {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ReviewFinding[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const line = typeof r.line === "number" ? r.line : NaN;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!Number.isFinite(line) || !title) continue;
    const side: "LEFT" | "RIGHT" = r.side === "LEFT" ? "LEFT" : "RIGHT";
    const severityRaw = r.severity;
    const severity: ReviewFinding["severity"] =
      severityRaw === "risk" || severityRaw === "nit" ? severityRaw : "suggestion";
    const confidenceRaw = typeof r.confidence === "number" ? r.confidence : 50;
    const confidence = Math.max(0, Math.min(100, Math.round(confidenceRaw)));
    const detail = typeof r.detail === "string" ? r.detail.trim() : "";
    out.push({
      id: hashId(`${path}:${line}:${title}`),
      path,
      line,
      side,
      severity,
      confidence,
      title,
      detail,
    });
  }
  return out;
}

export function usePrPreReview() {
  const ai = useAIProvider();

  /** Analyze one file — the concurrency-1 unit `usePrReviewQueue` (C3)
   *  sequences over a PR's touched files. Returns `[]` gracefully on any
   *  failure (AI unavailable, malformed response, blame lookup failure) —
   *  a single file's issue must never abort the whole pre-review pass. */
  async function analyzeFile(file: GitDiff, opts: AnalyzeFileOptions): Promise<ReviewFinding[]> {
    if (!ai.isAvailable.value || !file.hunks.length) return [];
    try {
      const importedByCount = computeImportedByCount(file, opts.otherDiffFiles);
      const blame = await getGitBlame(opts.cwd, file.path).catch(() => [] as BlameLine[]);
      const blameSummaries = summarizeBlameForFile(blame, file);

      const systemPrompt = buildSystemPrompt(opts.locale ?? "en");
      const userPrompt = buildUserPrompt(file, importedByCount, blameSummaries, opts.maxFileChars ?? 6000);
      const raw = await ai.rawPrompt(systemPrompt, userPrompt);
      if (!raw) return [];
      return parseFindings(raw, file.path);
    } catch {
      return [];
    }
  }

  return { analyzeFile };
}
