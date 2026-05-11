---
title: "Why we made LLM resolution opt-in (and how): GitWand v2.5"
description: "GitWand v2.5 introduces an opt-in LLM fallback for unresolved merge conflicts. Why it is the last pattern in the registry, why it stays off by default, how the validation harness keeps it honest, and the browser-safe contract that lets @gitwand/core ship to npm without a single fetch() call."
date: 2026-05-11
head:
  - - meta
    - property: og:title
      content: "Why we made LLM resolution opt-in (and how): GitWand v2.5"
  - - meta
    - property: og:description
      content: "GitWand v2.5 introduces an opt-in LLM fallback for unresolved merge conflicts — last pattern in the registry, off by default, validated by the v2.4 post-merge checker before any acceptance."
  - - meta
    - name: twitter:title
      content: "Why we made LLM resolution opt-in (and how): GitWand v2.5"
---

# Why we made LLM resolution opt-in (and how): GitWand v2.5

`@gitwand/core@2.5.0` shipped with a new pattern at the lowest priority of the resolution registry: `llm_proposed`. It sits at priority 998, immediately before `complex`, and it is **off by default**. When you turn it on, every `complex` hunk that survived the nine deterministic patterns before it gets a last attempt — an LLM proposes a resolution, the v2.4 post-merge validator scores the proposal, and only proposals above the configured threshold are accepted.

This post is about the design decisions behind that single line. Why "opt-in" and not "default on". Why "fallback" and not "the new default". Why we did not write a single `fetch()` call in `@gitwand/core` to ship it. And why, despite all of those constraints, the feature is still useful.

If you want the prior context, the [state-of-the-field survey from April](/blog/state-of-merge-conflict-resolution-2026) covers what the literature says about LLM-based merge resolution. This post is the implementation side of that thesis.

---

## The hunk that started it

Here is a conflict from a real refactor on a TypeScript codebase. Both branches modified the same `formatDuration` helper — one switched to seconds with rounding, the other kept the original unit but added a milliseconds-or-seconds branch:

```ts
<<<<<<< HEAD
export function formatDuration(value: number): string {
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}
=======
export function formatDuration(seconds: number): string {
  return `${Math.round(seconds)} s`;
}
>>>>>>> feat/round-seconds
```

Run v2.4 on it: every pattern fails. `same_change` no, `non_overlapping` no, `value_only_change` no, format-aware patterns not applicable. The classifier writes `complex` and walks away. The two intents are incompatible — one branch changed the *input unit*, the other refactored the *output format*. A deterministic pattern would have to guess which intent dominates, and guessing wrong is exactly what the v1.x [failure-modes post](/blog/auto-merge-failure-modes) warned against.

With v2.5 enabled, `llm_proposed` fires after `complex` would have. The hunk plus ±50 lines of context is serialised, the configured endpoint is called, a candidate resolution comes back, the v2.4 validator parses it, scores it 92/100. Above the 80 threshold — accepted, merge commits cleanly.

A single hunk does not justify a new pattern. The interesting question is what *fraction* of `complex` hunks are like it.

---

## What the literature says

Two data points anchor the v2.5 design.

**ConGra** ([Zhao et al., arXiv:2409.14121](https://arxiv.org/abs/2409.14121), September 2024) — the largest public benchmark on this task: 44,948 conflicts from 34 real-world C/C++/Java/Python projects, graded by complexity. Finding: general-purpose LLMs (Llama3-8B, DeepSeek-V2) resolve roughly 50–60 % of medium-complexity conflicts zero-shot, longer context does not help, and code-specialised variants do not beat their general-purpose siblings of similar size.

**Project Harmony** ([Source.dev](https://www.source.dev/journal/harmony-preview)) reports 88 % automatic resolution on Android codebases using a domain-specialised SLM about 20× smaller than the general-purpose leaders. That validates the thesis that fine-tuned narrow models beat zero-shot large ones for merge.

GitWand sits between those: we do not train a model, and we do not even know which model the user will pick. We can only capture a fraction of the ConGra gain. The right framing:

> The LLM is not the resolution engine. It is a safety net under it, with a harness as strict as the one for the deterministic patterns.

---

## Why opt-in

Four properties of LLM resolution differ from the deterministic patterns, and each one is a reason for explicit consent.

**Non-determinism.** Even at `temperature: 0`, two runs against two model snapshots can produce different resolutions. The deterministic patterns from v1.0 to v2.4 give the same answer forever — a property users have come to rely on.

**Confidentiality.** The hunk, the ±50 lines of context, and the partial DecisionTrace leave the process. With Claude or OpenAI as provider, they reach the vendor's servers under the vendor's terms. With Ollama or self-hosted MCP they do not. The safe default is "do not send code anywhere without asking".

**Cost.** A `complex` hunk with 50 lines of context lands at ~2–5 K input tokens plus ~500 output. At Claude Sonnet pricing (~$3/MTok input) that is **about $0.015 per hunk**. Twenty hunks per rebase ≈ $0.30. Small but real — and the user is the one paying.

**False positives become possible.** A model can hallucinate a resolution that parses cleanly but is semantically wrong. The v2.4 validator catches a meaningful fraction, but it is not a compiler proof. v2.4 had zero false positives by design — turning the fallback on trades that property for coverage.

Off-by-default surprises nobody. On-by-default surprises everybody. The toggle is a deliberate gate.

---

## Architecture

Four pieces, none of them surprising on its own.

### The pattern slot

The resolution registry was built in v1.4 around prioritised pattern plugins. Adding the LLM fallback meant adding one more plugin at the bottom of the priority list:

```ts
// packages/core/src/patterns/llm-proposed.ts
const llmProposed: PatternPlugin = {
  type: "llm_proposed",
  priority: 998,                       // just before complex (999)
  requires: "both",
  detect(h, options) {
    return options.llmFallback?.enabled === true
      && options.llmFallback.endpoint != null;
  },
  confidence(_h) {
    // Deliberately mediocre — the decision depends on the
    // post-merge validation score, not on the pattern confidence
    return { typeClassification: 50, dataRisk: 60, scopeImpact: 30 };
  },
};
```

`detect()` returns false unless the toggle is on *and* an endpoint was injected. `complex` keeps priority 999. With the fallback disabled the behaviour is byte-identical to v2.4.

### The injected endpoint

`@gitwand/core` does not call any API. It cannot — the package ships with browser support (VS Code webviews and the desktop's preview iframe consume it), and bundling a `fetch()` would either break in the browser or pull in a polyfill that breaks something else. So the core exposes one interface:

```ts
// packages/core/src/types.ts
export interface LlmEndpoint {
  call(prompt: string): Promise<string>;
}
```

The consumer implements it. The CLI builds an endpoint from the `--llm-provider` flag (Anthropic SDK, OpenAI SDK, Ollama HTTP). The desktop builds one from the configured AI provider in Settings. The MCP variant routes the call through a `resolve_hunk` tool, inverting the loop so the LLM agent already connected to your editor is the one doing the work — no API key required on our side.

The core never knows what is on the other side. Same browser-safe contract that has let `@gitwand/core` live on npm since v0.0.1.

### The validation harness

Every proposal is validated by the v2.4 post-merge checker before it is written:

1. The candidate file (original conflicted content with the LLM's resolution substituted in place of the hunk) is reparsed by the same structural parser used by v2.3 — tree-sitter for the covered languages, the format-aware family for JSON/YAML/TOML.
2. The parser produces a validation score from 0 to 100.
3. `minPostMergeScore` (default **80**) is the floor. Below it, the proposal is rejected and the hunk falls back to `complex`.
4. The recommended validation level is **`strict`**, which adds `tsc --noEmit` for TypeScript and `eslint` for JS/TS on top of the parse-tree check.

The model proposes; the validator decides.

### The audit trail

Every fallback resolution — accepted or rejected — writes a `LlmTrace` entry into that hunk's DecisionTrace:

```ts
interface LlmTrace {
  calledAt: string;              // ISO 8601
  model: string;
  latencyMs: number;
  promptHash: string;            // FNV-1a 64-bit hex
  rawResponseTruncated: string;  // first 500 chars
  validationScore: number;
  accepted: boolean;
}
```

The prompt hash uses FNV-1a 64-bit rather than SHA-256: small, deterministic, stable across platforms, computable in the browser without `crypto.subtle`, and collision-resistant enough for a single user's resolution history. The hash is an audit identifier, not a cryptographic seal — that distinction is what made FNV-1a the right choice (`926ef88 refactor: SHA-256 → FNV-1a`).

The trace surfaces in the desktop above the merge editor for every `llm_proposed` hunk, and in the CLI under the `llmTrace` field of each hunk in `--json` output.

---

## A CLI walkthrough

A representative session on a repo with one `complex` conflict the deterministic patterns refused:

```bash
$ export ANTHROPIC_API_KEY=sk-ant-...
$ gitwand resolve --llm-fallback --llm-provider claude --verbose
GitWand — Git's magic wand

  src/utils/format.ts
    hunk 1 (lines 12–24)  llm_proposed  validation 92/100  accepted
      model: claude-sonnet-4-6
      latency: 2.4s
      prompt hash: 7c3a91f4
    hunk 2 (lines 31–35)  same_change                       resolved

  Summary: 2/2 conflict(s) resolved across 1 file(s)
```

The `--json` form returns the same information machine-readably:

```json
{
  "files": [
    {
      "path": "src/utils/format.ts",
      "hunks": [
        {
          "lines": [12, 24],
          "type": "llm_proposed",
          "resolved": true,
          "llmTrace": {
            "calledAt": "2026-05-11T14:22:01.000Z",
            "model": "claude-sonnet-4-6",
            "latencyMs": 2412,
            "promptHash": "7c3a91f4d8e2b105",
            "validationScore": 92,
            "accepted": true,
            "rawResponseTruncated": "export function formatDuration(value: number)..."
          }
        }
      ]
    }
  ]
}
```

The audit trail makes the resolution reproducible (or at least *recognisable* as the same prompt that resolved it last time), and a quick `git diff` after the run lets the reviewer see the actual proposed text before commit.

---

## A rejection, by design

Run the same flow on a hunk where the LLM proposes something half-right:

```bash
$ gitwand resolve --llm-fallback --llm-provider claude --verbose
  src/auth/token.ts
    hunk 1 (lines 44–62)  llm_proposed  validation 65/100  rejected
      model: claude-sonnet-4-6  latency: 3.1s  prompt hash: 9a14fc02
    fallback: complex (manual resolution required)

  Summary: 0/1 conflict(s) resolved across 1 file(s)
  1 conflict remaining
```

The LLM produced a candidate. The validator scored it 65 — below the 80 threshold. GitWand refused it and left the conflict markers in place. Without the rejection gate, the fallback would be a quick way to write incorrect merges fast; with it, the worst case is "I paid one API call for a hunk I had to resolve manually anyway" — a reasonable price for a 50–60 % win rate on hunks that would otherwise be 0 %.

---

## Roadmap: MCP self-hosted

The most interesting integration of v2.5 is the one that does not require an API key at all.

GitWand already ships a public MCP server (`@gitwand/mcp`). Today, agents connected to that server — Claude Code, Cursor, Windsurf — can inspect pending hunks and read the DecisionTrace. v2.5 closes the loop by adding a `resolve_hunk` tool that the agent itself implements, and a `mcp` provider option in the desktop and CLI that routes the fallback prompt through the stdio transport instead of an external API.

The inversion is the point. With API providers, GitWand calls a model and pays for tokens. With MCP, the agent (which is already a model, already in your editor, already paid for) is the one being called by GitWand. No API key, no new vendor relationship. GitWand both exposes itself as an MCP server *and* consumes MCP as the resolution backend — both ends of the same protocol.

---

## What this does not change

Three framing principles we did not break:

- **The deterministic patterns are still the default.** Nine of them resolve the easy cases with zero false positives. The LLM fallback runs *after* all of them have refused — it cannot pre-empt them.
- **`resolve()` is still synchronous.** The new path is exposed through `resolveAsync()` (the v2.3 entry point for structural resolution). Calling `resolve()` continues to work, skips the LLM even if enabled, and is byte-compatible with v2.4.
- **The user still decides.** Every LLM resolution can be rejected from the merge editor. The CLI can be re-run without the flag. A repo can ship `.gitwandrc` with `"enabled": false` and the fallback is off by policy for the whole team.

---

## Closing

The LLM is not the future of merge resolution. The future is the same as the past: deterministic algorithms where they work, structural parsers where text fails, a last-resort fallback where structure fails too, and a human in front of every change that matters. v2.5 adds only the third item — the first two still do most of the work.

Full feature documented in the [LLM fallback guide](/guide/llm-fallback). Implementation lives in `packages/core/src/patterns/llm-proposed.ts`, `packages/core/src/resolvers/llm-fallback.ts`, and `packages/core/src/resolver/llm-pipeline.ts`. Spec in [`CORE-V2-ROADMAP.md`](https://github.com/devlint/GitWand/blob/main/CORE-V2-ROADMAP.md) section v2.5.0.

If you have used it on a real merge and the rejection rate surprised you in either direction, [open a discussion](https://github.com/devlint/GitWand/discussions) — the threshold defaults are what we expect to tune next.

---

*Curious about GitWand? [Download it here](https://gitwand.devlint.fr/) — it is free, open-source, and shipping monthly.*

*Background reading: [The state of automatic merge conflict resolution in 2026](/blog/state-of-merge-conflict-resolution-2026), [ConGra benchmark (arXiv:2409.14121)](https://arxiv.org/abs/2409.14121), [Project Harmony preview](https://www.source.dev/journal/harmony-preview).*
