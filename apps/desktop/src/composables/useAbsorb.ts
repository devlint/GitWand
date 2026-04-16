import { ref } from "vue";
import { gitExec } from "../utils/backend";
import { useAIProvider } from "./useAIProvider";

/**
 * Absorb — automatically amend unstaged/staged changes into the commit
 * that last touched the modified lines, inspired by GitButler's absorb
 * and `git absorb`.
 *
 * Flow:
 * 1. `git diff` (or `git diff --cached`) → find changed line ranges per file
 * 2. `git blame -L <range>` on the original version → find candidate commits
 * 3. If a single commit owns all changed lines in a hunk, it's a candidate
 * 4. Create fixup commits: `git commit --fixup=<hash>`
 * 5. Optionally autosquash: `git rebase -i --autosquash <base>`
 *
 * The composable exposes `analyze` (find candidates) and `absorb` (execute).
 */

// ─── Types ──────────────────────────────────────────────

export interface AbsorbCandidate {
  /** File path relative to repo root. */
  filePath: string;
  /** Target commit hash to absorb into. */
  targetHash: string;
  /** Short hash for display. */
  targetShortHash: string;
  /** Target commit subject line. */
  targetMessage: string;
  /** Number of hunks that would be absorbed. */
  hunkCount: number;
  /** Changed line ranges (for display). */
  lineRanges: string[];
  /**
   * True when the target was picked by the AI provider because multiple
   * commits own the modified lines. UI should surface this so the user
   * knows to double-check before confirming.
   */
  aiRanked?: boolean;
  /** Short rationale from the AI (only set when aiRanked=true). */
  aiReason?: string;
  /** Other candidate commits the AI saw (excluding the top-ranked one). */
  alternates?: Array<{
    targetHash: string;
    targetShortHash: string;
    targetMessage: string;
    reason?: string;
  }>;
}

export interface AbsorbResult {
  /** Files that were absorbed. */
  absorbed: AbsorbCandidate[];
  /** Files that could not be absorbed (multi-commit hunks, etc.). */
  skipped: { filePath: string; reason: string }[];
}

// ─── Helpers ────────────────────────────────────────────

interface DiffHunk {
  filePath: string;
  /** Original file line start. */
  origStart: number;
  /** Number of lines in original. */
  origCount: number;
}

/**
 * Parse `git diff` output to extract per-file hunk ranges.
 */
function parseDiffHunks(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentFile = "";

  for (const line of diffOutput.split("\n")) {
    // --- a/path or +++ b/path
    if (line.startsWith("--- a/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("@@ ")) {
      // @@ -origStart,origCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match && currentFile) {
        const origStart = parseInt(match[1], 10);
        const origCount = parseInt(match[2] ?? "1", 10);
        if (origCount > 0) {
          hunks.push({ filePath: currentFile, origStart, origCount });
        }
      }
    }
  }

  return hunks;
}

/**
 * Run `git blame -L start,end --porcelain` and extract the commit hash
 * for each line. Returns the set of unique hashes.
 */
async function blameRange(
  cwd: string,
  filePath: string,
  start: number,
  end: number,
): Promise<Set<string>> {
  const result = await gitExec(cwd, [
    "blame",
    "-L",
    `${start},${end}`,
    "--porcelain",
    "HEAD",
    "--",
    filePath,
  ]);

  if (result.exitCode !== 0) return new Set();

  const hashes = new Set<string>();
  for (const line of (result.stdout ?? "").split("\n")) {
    // Porcelain format: first field of header lines is the full hash
    const match = line.match(/^([0-9a-f]{40})\s/);
    if (match) {
      // Ignore uncommitted lines (all zeros)
      if (match[1] !== "0".repeat(40)) {
        hashes.add(match[1]);
      }
    }
  }

  return hashes;
}

/**
 * Get the short hash and subject for a commit.
 */
async function commitInfo(
  cwd: string,
  hash: string,
): Promise<{ shortHash: string; message: string }> {
  const result = await gitExec(cwd, [
    "log",
    "-1",
    "--format=%h\t%s",
    hash,
  ]);
  if (result.exitCode !== 0) return { shortHash: hash.slice(0, 7), message: "" };
  const parts = (result.stdout ?? "").trim().split("\t");
  return { shortHash: parts[0] ?? hash.slice(0, 7), message: parts[1] ?? "" };
}

/**
 * Extract the per-file slice of a multi-file diff.
 * Returns `""` if the file isn't in the diff.
 */
function extractFileDiff(diffOutput: string, filePath: string): string {
  // Diff headers look like `diff --git a/<path> b/<path>`
  const marker = `diff --git a/${filePath}`;
  const start = diffOutput.indexOf(marker);
  if (start === -1) return "";
  const next = diffOutput.indexOf("\ndiff --git ", start + marker.length);
  return next === -1 ? diffOutput.slice(start) : diffOutput.slice(start, next + 1);
}

interface AiRankOutcome {
  topHash: string;
  topReason?: string;
  alternates: Array<{ hash: string; reason?: string }>;
}

/**
 * Ask the configured AI provider which of several commits is the most
 * likely absorb target for a given diff. Returns `null` on any failure
 * (missing provider, invalid JSON, empty list), so callers can fall back
 * to the deterministic "skip" behaviour.
 */
async function rankAbsorbCandidatesWithAI(
  cwd: string,
  filePath: string,
  fileDiff: string,
  candidateHashes: string[],
): Promise<AiRankOutcome | null> {
  if (candidateHashes.length === 0) return null;

  const ai = useAIProvider();
  if (!ai.isAvailable.value) return null;

  // Pull subject + body for each candidate so the LLM can reason about
  // intent rather than hashes.
  const commits: Array<{ hash: string; shortHash: string; subject: string; body: string }> = [];
  for (const h of candidateHashes) {
    const res = await gitExec(cwd, ["log", "-1", "--format=%h%x09%s%x09%b", h]);
    if (res.exitCode !== 0) continue;
    const raw = (res.stdout ?? "").trim();
    const [shortHash = h.slice(0, 7), subject = "", body = ""] = raw.split("\t");
    commits.push({ hash: h, shortHash, subject, body });
  }
  if (commits.length === 0) return null;

  const systemPrompt = `You are a senior engineer picking the most likely
"absorb" target for a small change.

You will receive:
- A unified diff hunk for a single file.
- A numbered list of commits that each touched the modified lines at
  some point in history (subject + body + short hash).

Choose the ONE commit whose intent best matches the diff — the commit
that, in a tidy history, would naturally have contained these changes
from the start. Consider the subject wording, the body, and which
concern each commit was addressing.

Output strict JSON, no markdown fences, no preamble:
{
  "topHash": "<full hash of the best candidate>",
  "topReason": "<1 short sentence, in English or French depending on the commit subjects>",
  "alternates": [
    { "hash": "<full hash>", "reason": "<1 short sentence>" }
  ]
}

Rules:
- topHash MUST be one of the provided full hashes, verbatim.
- If alternates exist, rank them from most to least likely.
- Do NOT invent commits.`;

  const userLines: string[] = [];
  userLines.push(`File: ${filePath}`);
  userLines.push("");
  userLines.push("--- diff ---");
  userLines.push(fileDiff.length > 4000 ? fileDiff.slice(0, 4000) + "\n... (truncated)" : fileDiff);
  userLines.push("");
  userLines.push("--- candidate commits ---");
  commits.forEach((c, idx) => {
    userLines.push(`[${idx}] ${c.hash}  (${c.shortHash})`);
    userLines.push(`    subject: ${c.subject}`);
    if (c.body && c.body.trim()) {
      userLines.push("    body:");
      for (const bl of c.body.trim().split(/\r?\n/)) userLines.push(`      ${bl}`);
    }
  });
  userLines.push("");
  userLines.push("Pick the top absorb target.");

  let raw: string;
  try {
    raw = await ai.rawPrompt(systemPrompt, userLines.join("\n"));
  } catch {
    return null;
  }
  if (!raw) return null;

  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (brace !== -1 && lastBrace > brace) s = s.slice(brace, lastBrace + 1);

  try {
    const obj = JSON.parse(s);
    const top = typeof obj?.topHash === "string" ? obj.topHash : "";
    const allowed = new Set(candidateHashes);
    if (!allowed.has(top)) return null;
    const alt: AiRankOutcome["alternates"] = Array.isArray(obj?.alternates)
      ? obj.alternates
          .map((a: unknown) => {
            if (!a || typeof a !== "object") return null;
            const o = a as Record<string, unknown>;
            const h = typeof o.hash === "string" ? o.hash : "";
            if (!allowed.has(h) || h === top) return null;
            return { hash: h, reason: typeof o.reason === "string" ? o.reason : undefined };
          })
          .filter(Boolean) as AiRankOutcome["alternates"]
      : [];
    return {
      topHash: top,
      topReason: typeof obj?.topReason === "string" ? obj.topReason : undefined,
      alternates: alt,
    };
  } catch {
    return null;
  }
}

// ─── Composable ─────────────────────────────────────────

const isAnalyzing = ref(false);
const isAbsorbing = ref(false);
const lastError = ref<string | null>(null);
const candidates = ref<AbsorbCandidate[]>([]);

export function useAbsorb() {
  /**
   * Analyze modified files to find absorb candidates.
   *
   * @param staged - If true, analyze staged changes; otherwise unstaged.
   */
  async function analyze(
    cwd: string,
    filePaths?: string[],
    staged = false,
  ): Promise<AbsorbCandidate[]> {
    isAnalyzing.value = true;
    lastError.value = null;
    candidates.value = [];

    try {
      // Get the diff
      const diffArgs = staged
        ? ["diff", "--cached", "--no-color"]
        : ["diff", "--no-color"];
      if (filePaths?.length) diffArgs.push("--", ...filePaths);

      const diffResult = await gitExec(cwd, diffArgs);
      if (diffResult.exitCode !== 0) {
        throw new Error((diffResult.stderr ?? "").trim() || "git diff failed");
      }

      const diffOutput = diffResult.stdout ?? "";
      if (!diffOutput.trim()) {
        return [];
      }

      const hunks = parseDiffHunks(diffOutput);
      if (hunks.length === 0) return [];

      // Group hunks by file
      const byFile = new Map<string, DiffHunk[]>();
      for (const h of hunks) {
        const list = byFile.get(h.filePath) ?? [];
        list.push(h);
        byFile.set(h.filePath, list);
      }

      const result: AbsorbCandidate[] = [];

      for (const [file, fileHunks] of byFile) {
        // Blame each hunk range to find which commit(s) own those lines
        const allHashes = new Set<string>();
        const lineRanges: string[] = [];

        for (const hunk of fileHunks) {
          const end = hunk.origStart + hunk.origCount - 1;
          const hashes = await blameRange(cwd, file, hunk.origStart, end);
          for (const h of hashes) allHashes.add(h);
          lineRanges.push(`${hunk.origStart}-${end}`);
        }

        // If all hunks point to a single commit → clean absorb candidate
        if (allHashes.size === 1) {
          const targetHash = [...allHashes][0];
          const info = await commitInfo(cwd, targetHash);
          result.push({
            filePath: file,
            targetHash,
            targetShortHash: info.shortHash,
            targetMessage: info.message,
            hunkCount: fileHunks.length,
            lineRanges,
          });
        } else if (allHashes.size > 1) {
          // Multiple commits own the modified lines. Ask the AI provider
          // (if any) to pick the semantically best target. Fall back to
          // "skip" when the provider isn't configured or the ranking
          // fails — deterministic behaviour is preserved.
          const candidateHashes = [...allHashes];
          const fileDiff = extractFileDiff(diffOutput, file);
          const ranked = await rankAbsorbCandidatesWithAI(
            cwd,
            file,
            fileDiff,
            candidateHashes,
          );
          if (ranked) {
            const topInfo = await commitInfo(cwd, ranked.topHash);
            const altInfos = await Promise.all(
              ranked.alternates.map(async (a) => {
                const info = await commitInfo(cwd, a.hash);
                return {
                  targetHash: a.hash,
                  targetShortHash: info.shortHash,
                  targetMessage: info.message,
                  reason: a.reason,
                };
              }),
            );
            result.push({
              filePath: file,
              targetHash: ranked.topHash,
              targetShortHash: topInfo.shortHash,
              targetMessage: topInfo.message,
              hunkCount: fileHunks.length,
              lineRanges,
              aiRanked: true,
              aiReason: ranked.topReason,
              alternates: altInfos,
            });
          }
          // If AI unavailable / response invalid: fall through (skip).
        }
      }

      candidates.value = result;
      return result;
    } catch (err: unknown) {
      lastError.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      isAnalyzing.value = false;
    }
  }

  /**
   * Execute the absorb: stage the file, create a fixup commit, then
   * optionally autosquash.
   *
   * @param autoSquash - If true, run `git rebase -i --autosquash` after.
   *                     Default false (safer — user can squash later).
   */
  async function absorb(
    cwd: string,
    candidate: AbsorbCandidate,
    autoSquash = false,
  ): Promise<void> {
    isAbsorbing.value = true;
    lastError.value = null;

    try {
      // Stage the file
      const addResult = await gitExec(cwd, ["add", "--", candidate.filePath]);
      if (addResult.exitCode !== 0) {
        throw new Error((addResult.stderr ?? "").trim() || "git add failed");
      }

      // Create fixup commit
      const fixupResult = await gitExec(cwd, [
        "commit",
        `--fixup=${candidate.targetHash}`,
      ]);
      if (fixupResult.exitCode !== 0) {
        throw new Error(
          (fixupResult.stderr ?? "").trim() || "git commit --fixup failed",
        );
      }

      // Optionally autosquash
      if (autoSquash) {
        // Find merge-base to limit the rebase range
        const baseResult = await gitExec(cwd, [
          "merge-base",
          "HEAD",
          candidate.targetHash + "~1",
        ]);

        if (baseResult.exitCode === 0 && (baseResult.stdout ?? "").trim()) {
          const base = (baseResult.stdout ?? "").trim();
          const rebaseResult = await gitExec(cwd, [
            "-c",
            "sequence.editor=true",
            "rebase",
            "--autosquash",
            base,
          ]);
          if (rebaseResult.exitCode !== 0) {
            throw new Error(
              (rebaseResult.stderr ?? "").trim() ||
                "git rebase --autosquash failed",
            );
          }
        }
      }
    } catch (err: unknown) {
      lastError.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      isAbsorbing.value = false;
    }
  }

  return {
    isAnalyzing,
    isAbsorbing,
    lastError,
    candidates,
    analyze,
    absorb,
  };
}
