/**
 * @file resolutionReport.ts
 *
 * The issue a "Report bad resolution" files (#301): the conflict GitWand saw
 * (ours, theirs, base), what it made of it, and why. Two variants:
 *
 * - for the repository being worked on: names the file;
 * - for GitWand's own repository (a public resolver report): describes the
 *   file by its kind only — never its path, its name, the repository, the
 *   branches or the remote — and adds the GitWand version and platform.
 *
 * The text is English, as it is read on GitHub.
 */
import type { ConflictHunk } from "@gitwand/core";
import { codeBlock, codeSpan, issueTitle, type IssuePrefill } from "./issuePrefill";

/** Which proposal panel the report comes from. */
export type ProposalKind = "engine" | "ai" | "token";

export interface ResolutionReport {
  kind: ProposalKind;
  /** The file's path in the repository (only the repository variant prints it). */
  path: string;
  hunk: ConflictHunk;
  /** What GitWand proposed (or applied) for the hunk. */
  resolvedLines: string[];
}

/** Under GitHub's 65,536-character body limit, with room for the user's edits. */
export const REPORT_BODY_MAX = 60_000;

/** Files without an extension whose name says their kind (and nothing private). */
const KNOWN_NAMES = new Set([
  "Dockerfile",
  "Makefile",
  "Gemfile",
  "Gemfile.lock",
  "Cargo.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "composer.lock",
  "poetry.lock",
]);

/**
 * The file's kind for a public report: a known name (`Cargo.lock`,
 * `Dockerfile`), else its extension, `.env` for any `.env.*`, else
 * "no extension" — never the file's own name.
 */
export function fileKind(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (KNOWN_NAMES.has(name)) return name;
  if (name === ".env" || name.startsWith(".env.")) return ".env";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "no extension";
}

interface Block {
  label: string;
  lines: string[];
  /** How many lines are kept (cut from the end when the body is too long). */
  kept: number;
}

function renderBlock(b: Block, withLabel = true): string {
  const shown = b.lines.slice(0, b.kept).join("\n");
  const note = b.kept < b.lines.length ? `\n\n_(cut to its first ${b.kept} of ${b.lines.length} lines)_` : "";
  return `${withLabel ? `**${b.label}**\n\n` : ""}${codeBlock(shown)}${note}`;
}

function confidenceLine(h: ConflictHunk): string {
  return `${codeSpan(h.type)}, confidence ${h.confidence.score} (${h.confidence.label})`;
}

/** The engine's reasoning: explanation, trace summary, and the proposal's own trace. */
function reasoning(r: ResolutionReport): string[] {
  const h = r.hunk;
  const out = [`- Conflict type: ${confidenceLine(h)}`, `- Explanation: ${h.explanation}`];
  if (h.trace.summary) out.push(`- Decision: ${h.trace.summary}`);
  const llm = h.trace.llmTrace;
  if (r.kind === "ai" && llm) {
    out.push(`- AI proposal: model ${codeSpan(llm.model)}, validation ${llm.validationScore}`);
    if (llm.history) out.push(`- history: ${llm.history.commitCount} commits (${llm.history.status})`);
  }
  const tok = h.trace.tokenMergeTrace;
  if (r.kind === "token" && tok) {
    const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
    out.push(`- Token-level merge: pass 1: ${lines(tok.pass1Count)}, pass 2: ${lines(tok.pass2Count)}`);
  }
  return out;
}

/**
 * The body: the user's answer first (when given), `head` lines, the three
 * versions and the result, then the reasoning — the longest block cut by half
 * until the whole fits `REPORT_BODY_MAX`.
 */
function assemble(r: ResolutionReport, answer: string, head: string[]): string {
  const h = r.hunk;
  const blocks: Block[] = [
    { label: "ours", lines: h.oursLines, kept: h.oursLines.length },
    { label: "theirs", lines: h.theirsLines, kept: h.theirsLines.length },
  ];
  // A 2-way conflict has no base: say nothing rather than show an empty one.
  if (h.trace.hasBase && h.baseLines.length > 0) blocks.push({ label: "base", lines: h.baseLines, kept: h.baseLines.length });
  const result: Block = { label: "GitWand's result", lines: r.resolvedLines, kept: r.resolvedLines.length };

  const render = () => {
    const parts: string[] = [];
    if (answer.trim()) parts.push(`### What it should have been\n\n${answer.trim()}`);
    parts.push(head.join("\n"));
    parts.push(`### The conflict\n\n${blocks.map((b) => renderBlock(b)).join("\n\n")}`);
    parts.push(`### GitWand's result\n\n${renderBlock(result, false)}`);
    parts.push(`### Why\n\n${reasoning(r).join("\n")}`);
    return parts.join("\n\n") + "\n";
  };

  let body = render();
  const all = [...blocks, result];
  while (body.length > REPORT_BODY_MAX) {
    const longest = all.reduce((a, b) => (b.lines.slice(0, b.kept).join("\n").length > a.lines.slice(0, a.kept).join("\n").length ? b : a));
    if (longest.kept <= 1) break;
    longest.kept = Math.max(1, Math.floor(longest.kept / 2));
    body = render();
  }
  // A few enormous lines can still overflow: cut the text itself.
  if (body.length > REPORT_BODY_MAX) {
    const note = `\n\n_(cut to its first ${REPORT_BODY_MAX - 200} characters)_\n`;
    body = body.slice(0, REPORT_BODY_MAX - 200) + note;
  }
  return body;
}

/** A report on the repository being worked on: names the file. */
export function repoReportPrefill(r: ResolutionReport, answer: string): IssuePrefill {
  return {
    title: issueTitle(`Bad merge resolution in ${codeSpan(r.path)}`),
    body: assemble(r, answer, [`File: ${codeSpan(r.path)}, conflict starting at line ${r.hunk.startLine}.`]),
  };
}

/**
 * A resolver report for GitWand's repository: the file's kind instead of its
 * path, the GitWand version and platform; nothing that names the project.
 */
export function gitwandReportPrefill(
  r: ResolutionReport,
  answer: string,
  env: { version: string; platform: string },
): IssuePrefill {
  const kind = fileKind(r.path);
  const head = [`GitWand ${env.version} on ${env.platform}.`, `File kind: ${codeSpan(kind)}.`];
  if (r.hunk.formatResolver) head.push(`Format resolver: ${codeSpan(r.hunk.formatResolver)}.`);
  return {
    title: issueTitle(`Resolver: bad ${codeSpan(r.hunk.type)} resolution (${codeSpan(kind)})`),
    body: assemble(r, answer, head),
  };
}
