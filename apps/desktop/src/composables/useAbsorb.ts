import { ref } from "vue";
import { gitExec } from "../utils/backend";

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
        }
        // If multiple commits, we could still offer per-hunk absorb in the future.
        // For now, skip files where hunks span multiple commits.
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
