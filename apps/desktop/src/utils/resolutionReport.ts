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

/**
 * The generated description's budget. With the answer field (`ANSWER_MAX`)
 * and its heading on top, the sent body stays under GitHub's 65,536
 * characters, with room left for the user's edits.
 */
export const REPORT_BODY_MAX = 50_000;

/** The "What should it have been?" field's limit. */
export const ANSWER_MAX = 10_000;

/** The answer on top of a report's description (the one place that writes it). */
export function withAnswer(answer: string, body: string): string {
  const a = answer.trim();
  return a ? `### What it should have been\n\n${a}\n\n${body}` : body;
}

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
  // Either separator: a Windows path must not let its folders into the kind.
  const name = path.split(/[\\/]/).pop() ?? "";
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
  /** How many characters of those lines are kept (one enormous line). */
  maxChars: number;
}

/** `text` cut to `n` UTF-16 units, never splitting a surrogate pair. */
function cutChars(text: string, n: number): string {
  let cut = text.slice(0, n);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

function shownText(b: Block): string {
  const text = b.lines.slice(0, b.kept).join("\n");
  return text.length > b.maxChars ? cutChars(text, b.maxChars) : text;
}

function renderBlock(b: Block, withLabel = true): string {
  const full = b.lines.slice(0, b.kept).join("\n");
  const shown = shownText(b);
  // Cut inside the block, so its fence always closes.
  const notes: string[] = [];
  if (b.kept < b.lines.length) notes.push(`_(cut to its first ${b.kept} of ${b.lines.length} lines)_`);
  if (shown.length < full.length) notes.push(`_(cut to its first ${shown.length} characters)_`);
  const note = notes.length ? `\n\n${notes.join(" ")}` : "";
  return `${withLabel ? `**${b.label}**\n\n` : ""}${codeBlock(shown)}${note}`;
}

/** An engine sentence can quote code: never let one line outgrow the budget. */
const REASON_LINE_MAX = 1_000;

function confidenceLine(h: ConflictHunk): string {
  return `${codeSpan(h.type)}, confidence ${h.confidence.score} (${h.confidence.label})`;
}

type Scrub = (text: string) => string;

/**
 * Engine prose can carry what a public report must not: a `.gitwandrc`
 * glob ("user pattern: clients/acme/**") and, defensively, the file's own
 * path or name. Both are replaced.
 */
function scrubberFor(path: string): Scrub {
  const name = path.split(/[\\/]/).pop() ?? "";
  const secrets = [path, name].filter((x) => x.length > 2).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text.replace(/user pattern: [^)\n]*/g, "user pattern");
    for (const s of secrets) out = out.split(s).join("<file>");
    return out;
  };
}

/** The engine's reasoning: explanation, trace summary, and the proposal's own trace. */
function reasoning(r: ResolutionReport, scrub: Scrub): string[] {
  const h = r.hunk;
  const clip = (t: string) => (t.length > REASON_LINE_MAX ? `${cutChars(t, REASON_LINE_MAX)}…` : t);
  const out = [`- Conflict type: ${confidenceLine(h)}`, `- Explanation: ${clip(scrub(h.explanation))}`];
  if (h.trace.summary) out.push(`- Decision: ${clip(scrub(h.trace.summary))}`);
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
 * The description: `head` lines, the three versions and the result, then the
 * reasoning — the longest block halved (by lines, then by characters) until
 * the whole fits `REPORT_BODY_MAX`. The answer goes on top separately
 * (`withAnswer`).
 */
function assemble(r: ResolutionReport, head: string[], scrub: Scrub = (t) => t): string {
  const h = r.hunk;
  const blocks: Block[] = [
    { label: "ours", lines: h.oursLines, kept: h.oursLines.length, maxChars: Infinity },
    { label: "theirs", lines: h.theirsLines, kept: h.theirsLines.length, maxChars: Infinity },
  ];
  // A 2-way conflict has no base: say nothing rather than show an empty one.
  if (h.trace.hasBase && h.baseLines.length > 0) blocks.push({ label: "base", lines: h.baseLines, kept: h.baseLines.length, maxChars: Infinity });
  const result: Block = { label: "GitWand's result", lines: r.resolvedLines, kept: r.resolvedLines.length, maxChars: Infinity };

  const render = () => {
    const parts: string[] = [];
    parts.push(head.join("\n"));
    parts.push(`### The conflict\n\n${blocks.map((b) => renderBlock(b)).join("\n\n")}`);
    parts.push(`### GitWand's result\n\n${renderBlock(result, false)}`);
    parts.push(`### Why\n\n${reasoning(r, scrub).join("\n")}`);
    return parts.join("\n\n") + "\n";
  };

  let body = render();
  const all = [...blocks, result];
  while (body.length > REPORT_BODY_MAX) {
    const longest = all.reduce((a, b) => (shownText(b).length > shownText(a).length ? b : a));
    const len = shownText(longest).length;
    if (longest.kept > 1) longest.kept = Math.max(1, Math.floor(longest.kept / 2));
    else if (len > 200) longest.maxChars = Math.floor(len / 2);
    else break;
    body = render();
  }
  return body;
}

/** A report on the repository being worked on: names the file. */
export function repoReportPrefill(r: ResolutionReport): IssuePrefill {
  return {
    title: issueTitle(`Bad merge resolution in ${codeSpan(r.path)}`),
    body: assemble(r, [`File: ${codeSpan(r.path)}, conflict starting at line ${r.hunk.startLine}.`]),
  };
}

/**
 * A resolver report for GitWand's repository: the file's kind instead of its
 * path, the GitWand version and platform; nothing that names the project.
 */
export function gitwandReportPrefill(
  r: ResolutionReport,
  env: { version: string; platform: string },
): IssuePrefill {
  const kind = fileKind(r.path);
  const head = [`GitWand ${env.version} on ${env.platform}.`, `File kind: ${codeSpan(kind)}.`];
  if (r.hunk.formatResolver) head.push(`Format resolver: ${codeSpan(r.hunk.formatResolver)}.`);
  return {
    title: issueTitle(`Resolver: bad ${codeSpan(r.hunk.type)} resolution (${codeSpan(kind)})`),
    body: assemble(r, head, scrubberFor(r.path)),
  };
}
