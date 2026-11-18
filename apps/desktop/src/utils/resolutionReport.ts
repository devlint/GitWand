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
import type { ConflictHunk, HunkResolution } from "@gitwand/core";
import { codeBlock, codeSpan, cutUtf16, issueTitle, type IssuePrefill } from "./issuePrefill";

/** Which proposal panel the report comes from. */
export type ProposalKind = "engine" | "ai" | "token";

export interface ResolutionReport {
  kind: ProposalKind;
  /** The file's path in the repository (only the repository variant prints it). */
  path: string;
  hunk: ConflictHunk;
  /** What GitWand proposed (or applied) for the hunk; `null` for an AI
   *  proposal that failed validation (its raw answer is reported instead). */
  resolvedLines: string[] | null;
}

/**
 * The generated description's budget. With the answer field (`ANSWER_MAX`)
 * and its heading on top, the sent body stays under GitHub's 65,536
 * characters, with room left for the user's edits.
 */
export const REPORT_BODY_MAX = 50_000;

/** The "What should it have been?" field's limit. */
export const ANSWER_MAX = 10_000;

/**
 * The answer on top of a report's description (the one place that writes
 * it). `inert` (a public report on GitWand's repository) puts it in a code
 * block, like everything else there: no `@mention` pings anyone, no `#N`
 * links into another project's issues.
 */
export function withAnswer(answer: string, body: string, inert = false): string {
  const a = answer.trim();
  if (!a) return body;
  return `### What it should have been\n\n${inert ? codeBlock(a) : a}\n\n${body}`;
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

/** Extensions common enough to say nothing about whose file it is. */
const KNOWN_EXTENSIONS = new Set(
  (
    ".ts .tsx .js .jsx .mjs .cjs .vue .svelte .json .jsonc .json5 .yaml .yml .toml .ini .cfg .conf .xml " +
    ".html .htm .css .scss .sass .less .md .mdx .rst .txt .csv .sql .graphql .gql .proto " +
    ".py .rb .php .java .kt .kts .scala .groovy .gradle .go .rs .c .h .cc .cpp .hpp .cs .fs .swift .m .mm " +
    ".dart .lua .pl .r .ex .exs .erl .hs .clj .elm .zig .nim .sh .bash .zsh .fish .ps1 .bat .cmd " +
    ".tf .hcl .nix .lock .env .properties .plist .csproj .sln .xcodeproj .pbxproj .tex .bib .svg"
  ).split(" "),
);

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
  if (dot <= 0) return "no extension";
  const ext = name.slice(dot).toLowerCase();
  // A made-up extension can name the project: only common ones are printed.
  return KNOWN_EXTENSIONS.has(ext) ? ext : "other extension";
}

interface Block {
  label: string;
  lines: string[];
  /** How many lines are kept (cut from the end when the body is too long). */
  kept: number;
  /** How many characters of those lines are kept (one enormous line). */
  maxChars: number;
}

function shownText(b: Block): string {
  const text = b.lines.slice(0, b.kept).join("\n");
  return text.length > b.maxChars ? cutUtf16(text, b.maxChars) : text;
}

function renderBlock(b: Block, withLabel = true): string {
  const full = b.lines.slice(0, b.kept).join("\n");
  const shown = shownText(b);
  // Cut inside the block, so its fence always closes.
  const notes: string[] = [];
  if (b.kept < b.lines.length) notes.push(`_(cut to its first ${b.kept} of ${b.lines.length} lines)_`);
  if (shown.length < full.length) notes.push(`_(cut to its first ${shown.length} characters)_`);
  // A base that is known but empty (both sides inserted) is not a missing one.
  if (b.lines.length === 0) notes.push("_(empty)_");
  const note = notes.length ? `\n\n${notes.join(" ")}` : "";
  return `${withLabel ? `**${b.label}**\n\n` : ""}${codeBlock(shown)}${note}`;
}

const NO_ANSWER = "No result: the AI fallback gave no answer (no endpoint configured, an error, or a refusal).";

/** An engine sentence can quote code: never let one line outgrow the budget. */
const REASON_LINE_MAX = 1_000;

function confidenceLine(h: ConflictHunk): string {
  return `${codeSpan(h.type)}, confidence ${h.confidence.score} (${h.confidence.label})`;
}

type Scrub = ((text: string) => string) & { isPublic?: boolean };

/** Public model families, each optionally followed by its version digits. */
const MODEL_FAMILY = /^(claude|gpt|o\d|chatgpt|gemini|gemma|llama|codellama|mistral|mixtral|codestral|qwen|deepseek|phi|command|grok)[\d.]*$/i;
/** Words a public model id is made of after its family. */
const MODEL_WORDS = new Set(
  (
    "sonnet opus haiku mini nano turbo preview latest instruct chat coder code pro flash lite exp " +
    "vision large medium small tiny base it r plus omni reasoner v r1 r2 o"
  ).split(" "),
);

/**
 * A public model id: a known family, then only version numbers, sizes
 * (`70b`, `4o`) and the vocabulary of public releases. Anything else — a
 * private deployment or fine-tune (`gpt-4o-acmecorp-internal`) — can name
 * its owner.
 */
function isPublicModel(model: string): boolean {
  const [family, ...rest] = model.split(/[-:_/]/);
  if (!MODEL_FAMILY.test(family ?? "")) return false;
  return rest.every((w) => /^[\d.]+[a-z]?$/i.test(w) || /^\d+[a-z]\d*$/i.test(w) || MODEL_WORDS.has(w.toLowerCase()));
}

/** The model as a public report may show it (the repository report shows it as is). */
function modelName(model: string, scrub: Scrub): string {
  if (!scrub.isPublic) return `model ${codeSpan(model)}`;
  return isPublicModel(model) ? `model ${codeSpan(model)}` : "a custom model";
}

/**
 * Engine prose can carry what a public report must not: a `.gitwandrc`
 * glob ("user pattern: clients/acme/**") and, defensively, the file's own
 * path or name. Both are replaced.
 */
function scrubberFor(path: string): Scrub {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  // Every folder name, short ones too (`ibm`), except words that say nothing
  // about the project and that the engine's own prose uses (`json`, `src`).
  const folders = parts.slice(0, -1).filter((x) => x.length > 1 && !GENERIC_FOLDERS.has(x.toLowerCase()));
  // The name without its extensions (`acme-billing` of `acme-billing.config.ts`).
  const stem = name.split(".")[0] ?? "";
  const stems = stem.length > 2 && !GENERIC_FOLDERS.has(stem.toLowerCase()) ? [stem] : [];
  const secrets = [...new Set([path, name, ...folders, ...stems])].filter((x) => x.length > 1).sort((a, b) => b.length - a.length);
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = secrets.length ? new RegExp(`(?<![\\w-])(?:${secrets.map(escape).join("|")})(?![\\w-])`, "gi") : null;
  const scrub: Scrub = (text) => {
    // A glob may hold parentheses: drop up to the line's last one (and the
    // whole rest of the line when it has none). Saying too little is safe.
    let out = text.replace(/user pattern: [^\n]*\)/g, "user pattern)").replace(/user pattern: [^\n)]*$/gm, "user pattern");
    if (pattern) out = out.replace(pattern, "<file>");
    // An endpoint's error can name a private host: URLs, host:port, and
    // names under a private suffix.
    out = out
      .replace(/\bhttps?:\/\/\S+/gi, "<url>")
      .replace(/\b[\w-]+(?:\.[\w-]+)+:\d+\b/g, "<host>")
      .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:internal|corp|local|lan|intranet|home)\b/gi, "<host>");
    return out;
  };
  scrub.isPublic = true;
  return scrub;
}

/** Folder names too common to identify a project. */
const GENERIC_FOLDERS = new Set(
  (
    "src lib app apps api bin build dist out test tests spec specs docs doc packages package pkg cmd internal " +
    "components component utils util helpers common shared core config configs scripts public static assets " +
    "resources res main java kotlin js ts json yaml yml vendor modules node_modules web server client frontend " +
    "backend tools tool examples example fixtures data types models views controllers services resolver resolvers " +
    "index mod readme changelog license cargo makefile dockerfile setup settings gitignore tsconfig vite webpack"
  ).split(" "),
);

/** The engine's reasoning: explanation, trace summary, and the proposal's own trace. */
function reasoning(r: ResolutionReport, scrub: Scrub): string[] {
  const h = r.hunk;
  const clip = (t: string) => (t.length > REASON_LINE_MAX ? `${cutUtf16(t, REASON_LINE_MAX)}…` : t);
  const out = [`- Conflict type: ${confidenceLine(h)}`, `- Explanation: ${clip(scrub(h.explanation))}`];
  if (h.trace.summary) out.push(`- Decision: ${clip(scrub(h.trace.summary))}`);
  const llm = h.trace.llmTrace;
  if (r.kind === "ai" && llm) {
    out.push(`- AI proposal: ${modelName(llm.model, scrub)}, validation ${llm.validationScore}`);
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
function assemble(r: ResolutionReport, head: string[], scrub: Scrub = (t) => t, inert = false): string {
  const h = r.hunk;
  const blocks: Block[] = [
    { label: "ours", lines: h.oursLines, kept: h.oursLines.length, maxChars: Infinity },
    { label: "theirs", lines: h.theirsLines, kept: h.theirsLines.length, maxChars: Infinity },
  ];
  // A 2-way conflict has no base: say nothing rather than show an empty one.
  if (h.trace.hasBase) blocks.push({ label: "base", lines: h.baseLines, kept: h.baseLines.length, maxChars: Infinity });
  // An AI proposal with no result: report its answer, or say there was none.
  // A public report leaves the answer out: the model was given the file's
  // path, the branches and the code around, and may echo any of them.
  const raw = inert ? "" : h.trace.llmTrace?.rawResponseTruncated ?? "";
  const noAnswer = r.resolvedLines === null && !(h.trace.llmTrace?.rawResponseTruncated ?? "").trim();
  const answerOmitted = r.resolvedLines === null && !noAnswer && inert;
  const resultLines = r.resolvedLines ?? raw.split("\n");
  const result: Block = { label: "GitWand's result", lines: resultLines, kept: resultLines.length, maxChars: Infinity };
  const failed = `No result: the AI proposal failed validation (score ${h.trace.llmTrace?.validationScore ?? "?"}).`;
  const resultIntro = r.resolvedLines === null && !noAnswer ? `${failed} Its answer (first 500 characters):\n\n` : "";
  // In a public report the engine's prose is inert too: it can quote code
  // (`@user`, `#N`) or an endpoint's error.
  const why = () => (inert ? codeBlock(reasoning(r, scrub).join("\n")) : reasoning(r, scrub).join("\n"));

  const render = () => {
    const parts: string[] = [];
    parts.push(head.join("\n"));
    parts.push(`### The conflict\n\n${blocks.map((b) => renderBlock(b)).join("\n\n")}`);
    const resultSection = noAnswer
      ? NO_ANSWER
      : answerOmitted
        ? `${failed} Its answer is not included in a public report.`
        : `${resultIntro}${renderBlock(result, false)}`;
    parts.push(`### GitWand's result\n\n${resultSection}`);
    parts.push(`### Why\n\n${why()}`);
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
    body: assemble(r, [`File: ${codeSpan(r.path)}, the conflict that started at line ${r.hunk.startLine} of the conflicted file.`]),
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
    body: assemble(r, head, scrubberFor(r.path), true),
  };
}

/**
 * The report a proposal panel files for its hunk: the engine's or the AI's
 * resolved lines, a token-level merge's own merged lines. An AI proposal
 * that failed validation has no lines and is reported with its answer
 * (`resolvedLines: null`); anything else without lines has nothing to report.
 */
export function reportFor(
  kind: ProposalKind,
  path: string,
  hunk: ConflictHunk,
  resolution: HunkResolution | undefined,
): ResolutionReport | null {
  const resolvedLines = kind === "token" ? hunk.trace.tokenMergeTrace?.mergedLines : resolution?.resolvedLines;
  if (resolvedLines) return { kind, path, hunk, resolvedLines };
  return kind === "ai" && hunk.trace.llmTrace ? { kind, path, hunk, resolvedLines: null } : null;
}

/**
 * An accepted copy's label: its conflict type and the first line written
 * (a line number would be stale as soon as another hunk is resolved).
 */
export function acceptedLabel(r: ResolutionReport): [string, string] {
  const first = ((r.resolvedLines ?? []).find((l) => l.trim()) ?? "").trim();
  return [r.hunk.type, first.length > 40 ? `${cutUtf16(first, 40)}…` : first];
}

