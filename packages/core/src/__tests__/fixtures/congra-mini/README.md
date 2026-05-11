# ConGra-mini — synthetic LLM-fallback regression dataset

This directory holds ~15 hand-crafted conflict fixtures inspired by the ConGra
dataset (arXiv:2409.14121). Each fixture represents a `complex` conflict that
the deterministic GitWand engine cannot resolve — i.e. both sides modify
overlapping content in non-trivial ways.

## Layout

Each subdirectory is one fixture:

```
fixture-name/
  conflict.txt                 # input file with <<<<<<<, |||||||, =======, >>>>>>> markers
  expected-llm-resolution.txt  # the resolution the mock LLM will return
  meta.json                    # { filePath, description, difficulty, category }
```

The `filePath` in `meta.json` is the path passed to `resolveAsync()` — it
controls language detection (TS/JS/Py/Go/Rust/JSON/MD) for both the format
resolver and the validation layer.

## Done criterion

CORE-V2-ROADMAP v2.5: "résout au moins 80 % des hunks `complex` du ConGra-mini
sans régression sur le reste". The bench (`congra-mini.bench.ts`) checks
`successRate >= 0.80` and fails the build below that.

## How fixtures are loaded

`congra-mini.bench.ts` reads each fixture, builds a deterministic mock endpoint
keyed by the **ours-block** of `conflict.txt`, calls `resolveAsync()` with
`llmFallback.enabled = true`, and tallies the resolutions by their
`decisions[i].type`:

- `llm_proposed` → success (counted toward the 80 % target)
- anything else  → failure (counted as regression)

`validationLevel: "off"` is used to bypass tree-sitter (not available in unit
tests) — same trick as `__tests__/patterns/llm-proposed.test.ts`.
