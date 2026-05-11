---
title: LLM Fallback — GitWand
description: Opt-in LLM fallback for unresolved merge conflicts. How to enable it across the desktop app, the CLI, and .gitwandrc; supported providers; validation policy; audit trail; and the browser-safe contract behind it.
---

# LLM fallback for unresolved conflicts

Introduced in `@gitwand/core@2.5.0`, the `llm_proposed` pattern is a last-resort fallback for the `complex` hunks that no deterministic pattern can resolve. It is **opt-in, off by default**, runs after every other pattern has failed, and every proposal is validated against the v2.4 post-merge checker before it is accepted.

This page documents how to turn it on, what it does, what it costs, and how to revoke a resolution that you don't trust.

---

## Why it is opt-in

The auto-resolution patterns shipped before v2.5 (`same_change`, `one_side_change`, `delete_no_change`, `non_overlapping`, the format-aware family, etc.) are deterministic. They produce the same output for the same input every time, the resolution is explainable line by line, and the failure mode is a false negative — a hunk that *could* have been resolved automatically is left as a marker for human review. Zero false positives by design.

The LLM fallback is the opposite. Four properties break, and you should know about all four before you flip the switch:

- **Non-determinism.** Even at temperature 0, two runs against different model snapshots, two endpoints, or two prompt revisions can produce different resolutions. GitWand records a stable prompt hash on every call, but it cannot guarantee a stable output.
- **Confidentiality.** Your code leaves the process. The hunk, the surrounding ±50 lines of context, and the partial DecisionTrace are sent to whichever endpoint you configure. If that endpoint is Anthropic, OpenAI, or any other hosted provider, your code reaches their servers under their terms of service. Ollama and self-hosted MCP keep it on your machine.
- **Cost.** Every fallback call is billed against your API key. A `complex` hunk with 50 lines of context lands around 2–5 K input tokens plus ~500 output tokens. At Claude Sonnet pricing (~$3 per million input tokens), that is roughly **$0.015 per hunk**. A messy rebase with twenty `complex` hunks costs about $0.30.
- **False positives are now possible.** A model can hallucinate a resolution that parses cleanly but is semantically wrong. The v2.4 validator catches a meaningful fraction of these (parse-tree validity, optional `tsc --noEmit` and `eslint`), but it is not a compiler proof. Review every LLM resolution before commit.

These trade-offs are real and your repo policy may forbid them. Off-by-default makes the policy explicit.

---

## How to enable

Three independent entry points, all gated on the same `.gitwandrc.llmFallback.enabled` setting.

### Desktop

Once the v2.6 desktop release lands, the toggle lives under **Settings → AI fallback**:

1. Open the Settings panel
2. Scroll to **AI fallback**
3. Flip **Enable LLM fallback for unresolved conflicts** to ON
4. Pick a provider in the dropdown (Claude API, Claude Code CLI, Codex CLI, OpenAI-compatible, Ollama, MCP self-hosted)
5. Adjust the validation threshold and context window if needed
6. Click **Save** — the settings are persisted to the current repo's `.gitwandrc`

The toggle is disabled when no repository is open (the config is per-repo, not global) and a warning is shown when the active resolution policy is `prefer-safety` or `strict`, because those policies skip the LLM fallback regardless of the toggle.

### CLI

Pass `--llm-fallback` to `gitwand resolve` (or any of its `--ci` / `--json` siblings). Pick a provider with `--llm-provider`. Provide credentials through the matching environment variable:

```bash
# Claude API
export ANTHROPIC_API_KEY=sk-ant-...
gitwand resolve --llm-fallback --llm-provider claude

# OpenAI-compatible (OpenAI, OpenRouter, Azure, etc.)
export OPENAI_API_KEY=sk-...
gitwand resolve --llm-fallback --llm-provider openai

# Ollama (local, nothing leaves your machine)
export OLLAMA_URL=http://localhost:11434
gitwand resolve --llm-fallback --llm-provider ollama
```

The flag is strictly opt-in. Running `gitwand resolve` without it preserves the v2.4 behaviour — `complex` hunks remain `complex`, no network call is made, exit codes are unchanged.

When `--json` is combined with `--llm-fallback`, the JSON output includes an `llmTrace` object inside each hunk resolved by the fallback (see [Audit trail](#audit-trail) below).

### `.gitwandrc`

The config-file path is the most reproducible: it lives next to your repo, it can be committed, and it applies to every consumer (desktop, CLI, MCP) automatically.

```jsonc
{
  // .gitwandrc — committed at repo root
  "llmFallback": {
    "enabled": true,                 // master switch, default false
    "model": "claude-sonnet-4-6",    // informational hint, passed to the endpoint
    "maxTokens": 4000,               // upper bound on the response
    "temperature": 0.0,              // 0.0 = deterministic, recommended
    "contextLines": 50,              // ±N lines around the hunk in the prompt
    "minPostMergeScore": 80,         // reject proposals scoring below this
    "minMode": "strict"              // validation level for the proposal
  }
}
```

The `endpoint` field is **never** present in `.gitwandrc`. It is injected programmatically by the consumer at runtime (the desktop app builds it from the configured AI provider, the CLI builds it from the `--llm-provider` flag and env vars). This is what keeps `@gitwand/core` free of HTTP code and browser-safe — see [Browser-safe contract](#browser-safe-contract).

A repo administrator who wants to **forbid** the fallback across the team can ship a `.gitwandrc` with `"enabled": false`. Individual developers can still override it locally by editing their checkout, but the committed default is "off" and that is what new clones see.

---

## Supported providers

`@gitwand/core` itself is agnostic — it calls a single `endpoint.call(prompt): Promise<string>` injected by the consumer. The matrix below describes what each provider needs to work and where the traffic goes.

| Provider           | Credentials                              | Where the code goes              | Notes                                          |
|--------------------|------------------------------------------|----------------------------------|------------------------------------------------|
| Claude API         | `ANTHROPIC_API_KEY`                      | Anthropic                        | Default model: `claude-sonnet-4-6`             |
| OpenAI-compatible  | `OPENAI_API_KEY` + endpoint URL          | OpenAI / Azure / OpenRouter / …  | Any chat-completions endpoint                  |
| Ollama             | `OLLAMA_URL` (default `localhost:11434`) | Your machine                     | Local, no external network                     |
| Claude Code CLI    | `claude login` already run               | Anthropic, through your Max/Pro  | Subscription, no separate API key              |
| Codex CLI          | Codex CLI logged in                      | OpenAI, through your account     | Subscription, no separate API key              |
| MCP (self-hosted)  | None — uses `@gitwand/mcp` stdio         | Whatever LLM is connected        | Inverts the loop (see [Roadmap](#roadmap))     |

The MCP option is the most interesting trade-off: instead of GitWand calling an LLM, the LLM agent (Claude Code, Cursor, Windsurf) is the one calling GitWand through the `resolve_hunk` MCP tool. No API key to provision, and the provider boundary is wherever your agent already lives.

---

## Validation policy

A proposal from the LLM is **not** accepted on its word. Every fallback resolution goes through the v2.4 post-merge validator before it is written to disk:

1. **Parse-tree validity.** The candidate merged content is reparsed with the same structural parser used by v2.3 (tree-sitter for the covered languages, JSON/YAML/TOML for the format-aware family). A proposal that does not parse is rejected outright.
2. **`minPostMergeScore`.** The validation produces a score from 0 to 100. The default cut-off is **80** — anything below is rejected and the hunk falls back to `complex` (the user resolves it manually).
3. **`minMode: "strict"`.** The recommended (and default) validation level activates the strictest checks available for the file's language: `tsc --noEmit` for TypeScript, `eslint` for JavaScript/TypeScript, etc. Loosening this is allowed but heavily discouraged for the LLM path — strict validation is the main defence against hallucinations.

Policies `prefer-safety` and `strict` skip the fallback entirely at the core level. If you want LLM resolutions you must relax the resolution policy first; the UI surfaces this explicitly rather than silently overriding it.

---

## Audit trail

Every accepted (or rejected) fallback resolution writes a `LlmTrace` entry into that hunk's DecisionTrace. The trace is a plain object, serialisable, and exposed unchanged by every consumer:

```ts
interface LlmTrace {
  calledAt: string;              // ISO 8601 timestamp of the call
  model: string;                 // model name as configured / returned
  latencyMs: number;             // round-trip time
  promptHash: string;            // FNV-1a 64-bit hex hash of the full prompt
  rawResponseTruncated: string;  // first 500 chars of the raw response
  validationScore: number;       // 0–100 post-merge score
  accepted: boolean;             // false if rejected and fell back to complex
}
```

The hash uses **FNV-1a** rather than a cryptographic digest. It is small, deterministic, and stable across platforms — enough to recognise that two runs hit the model with the same prompt, not enough to be cryptographic. That is the right trade-off for an audit field that has to be cheap to compute in the browser and in Node.

In the desktop app, the trace is rendered inline above the merge editor for every `llm_proposed` hunk, with a click-to-copy on the prompt hash and a collapsable `<details>` panel for the truncated raw response. In the CLI, it appears in the `--json` output under each hunk's `llmTrace` field. There is no separate log — the trace lives where the resolution lives.

---

## Revoking a resolution

The LLM is wrong sometimes. GitWand assumes you will catch it before commit.

- **Desktop.** Open the merge editor. Every hunk with `selectedType === "llm_proposed"` shows the `LlmTracePanel` above the diff with two buttons: **Accept** (default if the validation score met the threshold) and **Reject → manual**. Reject downgrades the hunk to `complex` and reopens the standard 3-way merge editor for that hunk only — sibling `llm_proposed` hunks in the same file are unaffected.
- **CLI.** Rerun the resolve without the `--llm-fallback` flag. The `complex` hunks come back as conflict markers and you resolve them manually like any pre-v2.5 conflict.
- **`.gitwandrc`.** Flip `"enabled": false` and commit. The fallback is now off for everyone on the repo until the flag is flipped again.

---

## FAQ

### Will my code be sent to Anthropic, OpenAI, or anyone else?

Only if you pick one of those as your provider, and only the hunks that GitWand could not resolve with deterministic patterns. The payload is the conflict (base, ours, theirs) plus ±50 lines of surrounding context. No file paths outside the hunk, no other files in the repo, no Git history, no credentials. If you pick Ollama or self-hosted MCP, nothing leaves your machine.

### How much does it cost?

A representative `complex` hunk with 50 lines of context is roughly 2–5 K input tokens plus ~500 output tokens. At Claude Sonnet pricing (~$3 per million input tokens), that is **about $0.015 per hunk**. A rebase with twenty `complex` hunks therefore costs around $0.30. A monorepo merge with two hundred conflicts where half are `complex` is in the low single-digit dollars. Ollama and MCP-through-your-agent are free at the API level.

### Can I review every LLM resolution before commit?

Yes. The merge editor surfaces an Accept / Reject UI for every `llm_proposed` hunk and stages the change only after explicit acceptance. In CLI mode, run with `--dry-run --verbose` first to inspect the proposals without touching the working tree.

### What about confidentiality in a team?

Each developer chooses their own provider locally — there is no team-wide LLM endpoint provisioned by GitWand. Two members of the same team can resolve conflicts with two different models on two different vendors. If your repo policy is "no code leaves our network", commit a `.gitwandrc` with `"llmFallback": { "enabled": false }` and the fallback is off everywhere by default.

### What happens if the LLM proposes something that does not parse?

It is rejected automatically by the v2.4 post-merge validator and the hunk falls back to `complex`. The `LlmTrace` still gets written with `accepted: false` so you can see in the audit log that the model was called, that it returned something, and that GitWand refused it.

### Why FNV-1a and not SHA-256 for the prompt hash?

The hash is an audit identifier, not a cryptographic seal. It needs to be cheap to compute in both Node and the browser without pulling in `crypto.subtle`. FNV-1a 64-bit is small, deterministic, stable across platforms, and collision-resistant enough at the scale of a single user's resolution history. The trade-off was made deliberately when the v2.5 implementation was simplified before tagging.

---

## Browser-safe contract

`@gitwand/core` ships to npm, runs in browsers (the in-app preview, the VS Code extension's webview), in Node (CLI, MCP), and in Rust (the parity probe, the desktop's structural pipeline). It can do none of those things if it imports `node:fetch`, `node:fs`, `node:https`, or any other Node-only module.

The fallback was designed around that constraint. The core exposes a single TypeScript interface:

```ts
export interface LlmEndpoint {
  call(prompt: string): Promise<string>;
}
```

The consumer (CLI, desktop, MCP server, third-party integration) implements that interface however it likes — `fetch()` against the Anthropic API, an Ollama HTTP call, an MCP stdio transport, a mocked function in a unit test. The core receives the function, calls it with the prompt, validates the response. It never knows what is on the other side.

This is the same architectural decision that lets `@gitwand/core` run in the browser today. The LLM fallback does not break it.

---

## Further reading

- [Why we made LLM resolution opt-in (and how)](/blog/v2-5-llm-fallback) — the v2.5 release post
- [The state of automatic merge conflict resolution in 2026](/blog/state-of-merge-conflict-resolution-2026) — survey of where the field is and where GitWand fits
- [Conflict Resolution Engine](/guide/conflict-resolution) — the deterministic pattern engine the fallback sits behind
- [AI Integrations](/guide/ai) — how to set up the underlying AI provider used by the desktop fallback
