/**
 * v2.5 — Mock LLM endpoint for deterministic bench / integration tests.
 *
 * `@gitwand/core` never makes a network call: it consumes an injected
 * `LlmEndpoint` whose `call(prompt)` returns the model output as a string.
 * For tests, we want a reproducible endpoint that returns a pre-recorded
 * response for each fixture without any randomness.
 *
 * ## Lookup strategy
 *
 * The pipeline serialises the conflict hunk (ours / base / theirs) verbatim
 * inside the prompt — so we can match a fixture by searching the prompt for
 * a unique substring. Two keys are supported, in order:
 *
 *   1. A literal `[FIXTURE: <name>]` marker injected by the caller (used by
 *      future prompt builders that want explicit tagging).
 *   2. The `ours` snippet of the fixture — the prompt always contains the
 *      ours block verbatim between `<<<<<<< ours` and `||||||| base` (or
 *      `=======` for diff2). A unique substring of `oursLines` is therefore
 *      enough to disambiguate.
 *
 * If neither match yields a hit, the endpoint returns the empty string —
 * which the pipeline treats as `CANNOT_RESOLVE` (lines: null, rejected).
 * This is the expected behaviour for "the LLM has nothing useful to say".
 */

import type { LlmEndpoint } from "../../types.js";

/**
 * Build a deterministic mock endpoint that returns pre-recorded responses
 * keyed by a unique substring of the prompt.
 *
 * @param responses - Map of `lookupKey → rawResponseBody`. The raw response
 *                    is returned as-is to the pipeline, which then parses
 *                    fenced blocks / detects `CANNOT_RESOLVE` / etc.
 *                    Wrap the resolution in triple backticks like a real
 *                    LLM would.
 */
export function buildMockEndpoint(
  responses: Map<string, string>,
): LlmEndpoint {
  return {
    async call(prompt: string): Promise<string> {
      // First pass — explicit fixture tag (future-proof).
      const tagMatch = prompt.match(/\[FIXTURE: ([^\]]+)\]/);
      if (tagMatch) {
        const direct = responses.get(tagMatch[1]);
        if (direct !== undefined) return direct;
      }

      // Second pass — first key whose substring appears in the prompt wins.
      // The fixture loader stores the ours-snippet as the key, which the
      // pipeline serialises verbatim into the conflict block.
      for (const [key, response] of responses) {
        if (key && prompt.includes(key)) return response;
      }

      // No match — return empty string. The pipeline treats this as
      // CANNOT_RESOLVE, leaving the hunk unresolved (audit trail kept).
      return "";
    },
  };
}

/**
 * Wrap a raw resolution body in a fenced code block, matching what a real
 * LLM would output. The pipeline's `parseResponse()` extracts the first
 * fenced block and uses it as the resolved lines.
 */
export function fenced(body: string): string {
  return "```\n" + body + "\n```";
}
