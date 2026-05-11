/**
 * v2.5 — Tool `gitwand_resolve_hunk` (inversion-of-loop endpoint).
 *
 * Purpose
 * -------
 * This tool is the inverse of the CLI `--llm-fallback` flag.
 *
 * - With `--llm-fallback`, GitWand (desktop/cli) holds the loop: it calls
 *   *out* to an `LlmEndpoint` (Claude API, OpenAI, Ollama…) to resolve a
 *   complex hunk.
 * - With this MCP tool, the loop is reversed: an AI agent (Claude Code,
 *   Cursor, Windsurf…) is the LLM, and it asks GitWand to *format* the
 *   resolution prompt for a specific hunk. The agent then answers the
 *   prompt itself — no external API key, no extra hop.
 *
 * Contract
 * --------
 * Input  : { base, ours, theirs, filePath, context?, language? }
 * Output : { resolution: string, reasoning: string }
 *
 * The server returns a *structured prompt* in the standard MCP `content`
 * channel. The MCP client (the agent) reads it, performs the merge
 * inference itself, and replies through the normal tool-call response
 * flow with the {resolution, reasoning} JSON object — exactly as if it
 * had been instructed by a system prompt.
 *
 * The server does NOT call any LLM. It is a pure prompt formatter +
 * shape contract — keeping `@gitwand/mcp` browser-safe and dependency-
 * free (no `fetch`, no Anthropic SDK, no API key handling).
 *
 * Pair this tool with `gitwand_apply_resolution` or
 * `gitwand_resolve_hunk_llm` to write the agent's answer back to disk.
 */

// ─── Tool definition ──────────────────────────────────────────

export const resolveHunkToolDefinition = {
  name: "gitwand_resolve_hunk",
  description:
    "Ask the connected AI agent (the caller of this MCP server) to propose a resolution for a single Git merge conflict hunk. " +
    "Returns a fully-formed prompt with the base/ours/theirs versions and asks the agent to reply with a JSON object " +
    '{ "resolution": "<merged code>", "reasoning": "<short explanation>" }. ' +
    "This tool does NOT call any external LLM — the agent that called the tool IS the LLM. " +
    "Use it when GitWand (desktop/cli) wants to delegate the resolution of a `complex` hunk to the agent driving the session, " +
    "instead of calling Anthropic/OpenAI directly. Pair the agent's answer with `gitwand_apply_resolution` to write it to disk.",
  inputSchema: {
    type: "object" as const,
    properties: {
      base: {
        type: "string",
        description:
          "Content of the hunk in the merge base (common ancestor). May be empty for hunks with no shared ancestor.",
      },
      ours: {
        type: "string",
        description: "Content of the hunk from the current branch (HEAD / ours side).",
      },
      theirs: {
        type: "string",
        description: "Content of the hunk from the incoming branch (theirs side).",
      },
      filePath: {
        type: "string",
        description:
          "Path of the file containing the hunk (used by the agent to infer language and apply format-aware reasoning).",
      },
      context: {
        type: "string",
        description:
          "Optional surrounding code (a few lines above and below the hunk) so the agent can reason about intent.",
      },
      language: {
        type: "string",
        description:
          "Optional language hint (e.g. \"typescript\", \"python\", \"rust\"). If omitted, the agent infers it from `filePath`.",
      },
    },
    required: ["base", "ours", "theirs", "filePath"],
  },
};

// ─── Prompt builder ───────────────────────────────────────────

/**
 * Builds the structured prompt that will be returned to the agent.
 * Kept as a pure function so it can be unit-tested without spinning up
 * an MCP transport.
 */
export function buildResolveHunkPrompt(args: {
  base: string;
  ours: string;
  theirs: string;
  filePath: string;
  context?: string;
  language?: string;
}): string {
  const { base, ours, theirs, filePath, context, language } = args;

  const langLine = language
    ? `Language hint: ${language}`
    : `Language: infer from the file path (${filePath}).`;

  const contextBlock = context && context.trim().length > 0
    ? `\nSurrounding context (read-only, do NOT include in your output):\n----- CONTEXT -----\n${context}\n----- END CONTEXT -----\n`
    : "";

  return [
    "You are resolving a Git merge conflict.",
    "The base, ours, and theirs versions of a single hunk are shown below.",
    "Produce the most likely correct merged version that preserves intent from both sides:",
    "  - keep changes from `ours` that are not contradicted by `theirs`",
    "  - keep changes from `theirs` that are not contradicted by `ours`",
    "  - when both sides edit the same logical statement, combine them coherently",
    "  - never invent code that is unrelated to base/ours/theirs",
    "",
    `File: ${filePath}`,
    langLine,
    contextBlock,
    "----- BASE (common ancestor) -----",
    base,
    "----- OURS (HEAD) -----",
    ours,
    "----- THEIRS (incoming) -----",
    theirs,
    "----- END -----",
    "",
    "Reply with a single JSON object on stdout, no markdown fences, no commentary outside the JSON:",
    "{",
    '  "resolution": "<the merged code that replaces the hunk — raw text, newlines preserved, no conflict markers>",',
    '  "reasoning":  "<one or two sentences explaining the merge decision>"',
    "}",
    "",
    "Hard constraints:",
    "  - `resolution` MUST NOT contain any of the markers `<<<<<<<`, `=======`, `>>>>>>>`, `|||||||`.",
    "  - `resolution` MUST be valid for the file's format (compilable / parseable when applicable).",
    "  - Output ONLY the JSON object. No prose before, no prose after, no markdown code fences.",
  ].join("\n");
}

// ─── Tool handler ─────────────────────────────────────────────

export async function handleResolveHunk(args: Record<string, unknown>) {
  const base = args.base as string | undefined;
  const ours = args.ours as string | undefined;
  const theirs = args.theirs as string | undefined;
  const filePath = args.filePath as string | undefined;
  const context = args.context as string | undefined;
  const language = args.language as string | undefined;

  // Validate required fields. `base` may be empty string (no ancestor),
  // so we check for `undefined` explicitly rather than truthiness.
  const missing: string[] = [];
  if (base === undefined) missing.push("base");
  if (ours === undefined) missing.push("ours");
  if (theirs === undefined) missing.push("theirs");
  if (!filePath) missing.push("filePath");

  if (missing.length > 0) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          {
            error: `Missing required argument(s): ${missing.join(", ")}.`,
            required: ["base", "ours", "theirs", "filePath"],
            optional: ["context", "language"],
          },
          null,
          2,
        ),
      }],
      isError: true,
    };
  }

  const prompt = buildResolveHunkPrompt({
    base: base as string,
    ours: ours as string,
    theirs: theirs as string,
    filePath: filePath as string,
    context,
    language,
  });

  // The MCP response carries the prompt back to the agent. The agent is
  // expected to read it, perform the inference itself, and reply with
  // a JSON object of shape { resolution: string, reasoning: string }.
  return {
    content: [{
      type: "text" as const,
      text: prompt,
    }],
  };
}
