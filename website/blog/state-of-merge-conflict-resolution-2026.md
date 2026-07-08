---
title: "The state of automatic merge conflict resolution in 2026: a survey, and where GitWand is headed"
description: "Where the field actually is in 2026 — textual diff, AST-based structural merge, semantic merge, refactoring-aware tools, and LLMs. A tour of the literature, what's in GitWand today, and the v2 roadmap."
date: 2026-04-26
---

# The state of automatic merge conflict resolution in 2026: a survey, and where GitWand is headed

Most articles on this blog are about something I just shipped. This one is different. It's grounded in the papers, blog posts, and open-source merge tools I've worked through to figure out what GitWand should learn from. The output is a clearer picture of where the field actually is — and a concrete roadmap for the next six releases of `@gitwand/core`. This post is the public version of both.

If you've used [GitWand](https://gitwand.app/), you know that the headline feature is automatic conflict resolution: a pattern-based engine that auto-resolves trivial Git conflicts and explains its reasoning step by step. I [wrote about how the engine works](/blog/automatic-merge-conflict-resolution) when I first shipped it, and [cataloged its failure modes](/blog/auto-merge-failure-modes) a few weeks later. The engine has been in production for several months and the published metric is real: it resolves a meaningful fraction of conflicts in monorepos and config files, and it tells you exactly why every time.

But it's also a textual engine. It compares lines. It doesn't parse code. Once you've shipped that, the natural question is: *what would it take to make it parse?*

This post answers that question by stepping back and surveying the field. Five families of techniques, from 1986 to 2026. Where GitWand sits today. Where v2 is going.

---

## Why merge conflicts are still a research topic in 2026

Three-way merge has been a solved-on-paper problem since RCS in 1986. The algorithm fits on a napkin: compute the diff between base and ours, compute the diff between base and theirs, apply both if they don't overlap, otherwise emit conflict markers. Git uses a more elaborate variant called **ORT** (default since 2.34, replacing the older `recursive`), but the core idea is the same.

So why is there an entire research community publishing papers on this every year, with venues like ICSE, FSE, TSE, ASE? Why did Microsoft Research spend two years building MergeBERT? Why did GitKraken add LLM-powered merge resolution in their April 2026 release? Why are tools like [Mergiraf](https://mergiraf.org/) and [Weave](https://github.com/Ataraxy-Labs/weave) being built right now?

Because the napkin algorithm only works when the *unit of comparison* is right. Lines are the wrong unit for code. Two branches that re-order the same imports differently produce a "conflict" that any compiler considers identical. Two branches where one renames a function and the other adds a call to the old name produce a *clean merge* that breaks at runtime. The 2024 paper [*Detecting Semantic Conflicts with Unit Tests*](https://www.sciencedirect.com/science/article/pii/S0164121224001158) puts a number on this: in their corpus, **60% of merge conflicts in Java projects were semantic conflicts of interaction**, and lines involved in those conflicts were **26× more likely to introduce a bug** than lines in syntactic conflicts.

So the research isn't about three-way merge. It's about choosing the right unit of comparison.

---

## Family 1 — textual diff, but smarter

Git ships four diff algorithms: Myers (default), Minimal, Patience, and Histogram. They produce different outputs, and the differences are not academic. Nugroho et al. measured this empirically in *How different are different diff algorithms in Git?* (Springer EMSE 2019) on 14 Java projects: **1.7% to 8.2% of commits show different code-churn metrics** depending on the algorithm chosen.

Myers is the classic Hunt-Szymanski-style edit-script algorithm. It works, it's fast, but it tends to produce diffs that fragment along low-information anchors. **Patience diff**, popularized by Bram Cohen for Bazaar in 2008, fixes this by anchoring on lines that appear *exactly once on each side* — unique anchors. It produces noticeably more readable diffs on real code.

**Histogram diff** extends Patience to handle the case where unique anchors don't exist: it falls back to lines with the lowest frequency. It's both faster than Patience and produces better diffs than Myers on most real-world inputs. The Nugroho study concluded with the unambiguous recommendation: *use `--histogram` for code changes*.

Why does this matter for a merge engine? Because every part of the engine that does diff-then-reason inherits the diff's quality. GitWand's `non_overlapping` pattern computes `diff(base, ours)` and `diff(base, theirs)`, then checks whether the edits overlap. If the diff fragments along weak anchors, edits that *should* be non-overlapping look like they overlap. The hunk falls into `complex` and the human gets a marker.

Today GitWand uses pure LCS (longest common subsequence) — the simplest possible diff backend, with a hybrid implementation that switches between full DP for small inputs and Hirschberg's space-efficient variant for large ones (`packages/core/src/diff.ts`). It's correct. It's also the worst quality choice for code among the modern algorithms.

**v2.1 will replace LCS with Histogram diff** as the default backend, with `lcs()` keeping its public signature so consumers don't break. I expect a +2-5% global lift in auto-resolution rate, and a much larger lift on cases involving block reorders.

---

## Family 2 — structural merge through AST

Once you stop comparing lines and start comparing parse trees, a different class of conflicts becomes resolvable.

The foundational paper here is Lindholm's **3DM** (2004), but the line that matters today goes through **FSTMerge** and **JFSTMerge** (Apel et al.), then **GumTree** (Falleri 2014, the canonical AST-diff algorithm), then **IntelliMerge** (Shen et al., ICSE 2019), then **Spork** (Larsén 2022). Each refines the same intuition: parse base/ours/theirs into syntax trees, match nodes across the trees by structural and semantic identity, merge node-by-node.

The breakout in 2024-2026 has been **[Mergiraf](https://mergiraf.org/)**: an open-source, syntax-aware Git merge driver in Rust, built on **tree-sitter**. Tree-sitter is the incremental parsing library used by Neovim, GitHub's web syntax highlighting, and Helix — it has 270+ maintained grammars, ships .wasm bundles, and parses fast enough to use synchronously in an editor. Mergiraf 0.16 (November 2025) added C, fixed stack overflows on line-merges, and improved non-UTF-8 handling. The core algorithm: parse all three versions with tree-sitter, run GumTree-classic matching pairwise, build a class-mapping across the three, fuse. Crucially, Mergiraf falls back to line-based merge when it succeeds; it only invokes the structural path when lines fail. That's the right design: don't pay AST overhead unless you need to.

Late 2025 saw an even more focused tool: **[Weave](https://github.com/Ataraxy-Labs/weave)** by Ataraxy-Labs. Same tree-sitter foundation, but it operates at *entity-level*. Instead of merging full trees, it extracts top-level entities — functions, classes, methods, JSON keys — matches them by **identity** (name + type + scope), and merges entity-by-entity. The annotated benchmark: 31/31 clean merges versus Git's 15/31, on 12 languages.

This is the family GitWand is missing. Today, when two branches both add a method to the same class but in different positions, the engine sees it as a `complex` conflict because the lines overlap. Tree-sitter would see two separate entity additions to a class container — trivially mergeable.

The challenge is that web-tree-sitter is ~150KB minified, plus 400-1200KB per grammar in WASM. You can't bundle that into a TypeScript library and ship it on npm without thinking. **v2.3 will introduce a structural dispatcher** with five languages in the first ship — TS, JS, Python, Go, Rust — and grammars distributed as `optionalDependencies`. The architectural pattern follows Weave: extract top-level entities, match by canonical signature, merge per-entity using the existing 3-way pipeline as a sub-routine. I expect the largest single qualitative jump of the v2 sequence here: +20-30% auto-resolution on the covered languages.

There's a related tool worth knowing about even if you don't use it: **[difftastic](https://github.com/Wilfred/difftastic)**, the structural diff viewer (read-only, not a merge tool). It's the proof-of-concept that tree-sitter is fast and accurate enough for interactive use, on 60+ languages.

---

## Family 3 — semantic merge and refactoring-awareness

The next family asks: what if the merge unit is not even the syntax tree, but the *meaning* of the change?

The commercial reference here has been **SemanticMerge** by Plastic SCM (now Unity Version Control) since 2013. It parses code as namespace → class → method, matches *declarations* by identity (regardless of position), and merges declaration-by-declaration. It can track a method that's been moved between classes or renamed. Open-source equivalents are recent: **IntelliMerge** (ACM PACMPL 2019), graph-based, refactoring-aware for Java. **RefMerge** (Ellis et al., TSE 2023): operation-based — it inverts the refactorings on each branch first, runs a classical merge on the rolled-back code, then replays the refactorings on the result. The benchmark on 2,001 merge scenarios shows RefMerge introduces conflicts in only 11% of cases, vs 30% for IntelliMerge.

Even fresher: **RePatch** (arXiv:2508.06718, August 2025) extends RefMerge to *cherry-picks across diverged forks*, which is the daily reality of any maintainer of a long-running fork.

This branch has a separate concern that gets too little attention: **semantic conflicts** — the merges that succeed silently and break at runtime. Da Silva et al. 2024 (60%/26×, mentioned earlier). The companion paper *Detecting Semantic Conflicts using Static Analysis* (arXiv:2310.04269) attacks the same problem with static analysis instead of generated tests. **SAM** (SemAntic Merge) generates unit tests as partial specifications and uses them to flag silent conflicts. Sousa's *Verifying Semantic Conflict-Freedom in Three-Way Program Merges* (arXiv:1802.06551) goes full formal — modular relational reasoning over the modified regions to *prove* conflict-freedom.

These are not techniques you can drop into a desktop client tomorrow. But the lesson — *don't auto-resolve without checking the result against a real parser/checker* — translates directly. **v2.4 of GitWand will extend the existing post-merge validator** (currently `JSON.parse`, `yaml.parse`, `smol-toml`) to do parse-tree validity on the same languages that v2.3 covers, with optional `tsc --noEmit` and `eslint` invocations gated behind a config flag. A new `postMergeRisk` dimension in the confidence score will pull resolutions back if validation fails. This is the closest GitWand will get to formal verification — and honestly, for a desktop client, it's the right ceiling.

The refactoring-awareness piece is harder. **v2.6 (experimental) will detect three classes of refactoring** — local renames, top-level renames, method moves — using tree-sitter and run the RefMerge invert/merge/replay pipeline on them. It'll be opt-in, expected to help on the specific class of "rename + use-of-old-name-elsewhere" conflicts that no syntactic merge can resolve.

---

## Family 4 — neural networks, transformers, LLMs

Here's where the field has moved fastest in the last 18 months.

**DeepMerge** (Dinella et al., ICSE 2022, Microsoft) was the first credible neural attempt: a token-level encoder, ~55% top-1 precision on the resolutions it could even *propose* (it failed on a third of conflicts that aren't representable as line interleavings). **MergeBERT** (Microsoft Research, 2022) supersedes it with a transformer-based three-way encoder, hitting 63-68% accuracy — the headline number, and still the public state-of-the-art for token-level neural merge.

Then 2024 happened. **[ConGra](https://arxiv.org/abs/2409.14121)** (Zhao et al., September 2024) is the benchmark that matters: 44,948 conflicts from 34 real-world projects in C/C++/Java/Python, graded by complexity. The findings are blunt and a little uncomfortable for the field:

- **Longer context windows do not help.** Models with 128K context don't beat 8K models on this task.
- **General LLMs beat specialized code LLMs.** Llama3-8B and DeepSeek-V2 outperformed code-specialized variants of similar size.
- **Most models plateau around 50-60%** on medium-complexity conflicts.

In production, the state of the art is **[Project Harmony](https://www.source.dev/journal/harmony-preview)** (Source.dev), which reports 88% automatic resolution on Android codebases using a domain-specialized SLM 20× smaller than the leading general-purpose LLMs. That's the most honest data point I've seen — it validates the thesis that fine-tuned, narrow models beat zero-shot large ones for this problem.

Two industry tools deserve naming. **[merde.ai](https://sketch.dev/blog/merde)** by Sketch.dev offers ~50% success rate on their internal benchmark with a clever UX twist: resolutions land in a separate branch, never in your working directory. **LLMinus** is being applied since 2025 to the Linux kernel pull request workflow — a pretty serious endorsement.

For GitWand, this matters because the package already ships a public **MCP server** indexed on the official MCP Registry. Any LLM agent that speaks MCP — Claude Code, Cursor, Windsurf — can already inspect GitWand's pending hunks. **v2.5 will close the loop**: a new `llm_proposed` pattern at the lowest priority, opt-in, that serializes the hunk + the partial DecisionTrace + ±50 lines of context, calls a configured endpoint, and validates the proposal aggressively against v2.4's post-merge checker before accepting. Default off. Strict validation required. Audit trail in the decision trace. The architecture choice — in-process function call rather than HTTP — keeps `@gitwand/core` neutral on which provider you use.

I want to be careful here. The empirical evidence from ConGra and Harmony says LLMs are real, useful, and definitely not a silver bullet. The right framing is "last-resort fallback after all the deterministic pipelines have run", not "AI-powered everything".

---

## Family 5 — the mathematical alternatives

A short detour, because it deserves to be in the survey even if it's not in the GitWand roadmap.

**[Pijul](https://pijul.org/)** is a distributed VCS with a categorically rigorous theory of patches — files and patches form a category, and merge is a *pushout* in that category. Conflicts are first-class objects in a state graph rather than a failure mode. The mathematical guarantee: associativity, commutativity, identity. The trade-off: it's not Git, and the world runs on Git.

**Operational Transformation** and **CRDTs** (Yjs, Automerge, Logoot) are conflict-free by construction, which is how Google Docs and most collaborative editors work. Translating CRDT guarantees to source files would require giving up the textual representation Git relies on. Useful framing for fresh systems, irrelevant for a Git client.

**Darcs** has its own theory of patches, and is conceptually adjacent to Pijul. It's worth reading the original papers if you ever want to design a new VCS — but for someone shipping a Git tool today, this family is academic context.

---

## Where GitWand sits today

I want to draw the picture as it actually is, not as I'd like it to be.

GitWand v1.x is a textual + format-aware engine. The architecture has three good ideas it's worth being honest about:

1. **Pattern registry as an extension point.** Nine plugins today, ordered by priority, each implementing `detect`, `confidence`, `explanation`. Adding a new family of conflicts means adding a file. This is what makes the v2 roadmap concretely possible — every new technique slots in as another plugin.
2. **Composite confidence scoring.** Five dimensions, formula in `packages/core/src/patterns/utils.ts`. A pattern matching is a *hypothesis*, not a *decision*; the threshold gate is separate. This lets v2.4 add a `postMergeRisk` dimension without touching the patterns.
3. **DecisionTrace.** Every classification replays all eligible patterns and records why each passed or failed. The user can inspect "why did GitWand do that?" and read the actual reason chain. Few merge tools surface this.

What it *isn't*:

- **No AST.** The engine has tree-sitter-grade ambitions and pure-text execution. This is the biggest single gap, and v2.3 closes it.
- **No move-detection across files.** A hunk is analyzed in isolation. A method that moved files becomes two unrelated conflicts.
- **No semantic validation beyond JSON/YAML/TOML.** A v1 resolution that parses but doesn't compile passes silently. v2.4 fixes this.
- **No LLM in the resolver pipeline.** Available via the MCP server, but only as a separate human-driven workflow. v2.5 makes it a first-class fallback.

The shipped engine works because the patterns it does cover are all *strictly safer than human guesswork*. `same_change`, `one_side_change`, `delete_no_change` are mechanical 3-way merge cases. `whitespace_only`, `value_only_change`, `reorder_only`, `insertion_at_boundary` are heuristics with conservative confidence scores. `non_overlapping` is the classical RCS algorithm. `complex` is the explicit "I won't try" pattern. The discipline that makes this work is: *if in doubt, don't resolve*.

---

## The v2 sequence in one diagram

| Release | One-line | Family it touches |
|---------|----------|--------------------|
| **v2.1** | Histogram diff + block-move detection | Family 1 — better textual baseline |
| **v2.2** | Format profile registry + JSON Patch arrays | Family 1 + Family 2 (commutative parents) |
| **v2.3** | Tree-sitter structural dispatcher (5 languages) | Family 2 — the big jump |
| **v2.4** | Semantic post-merge validation | Family 3 — silent-conflict prevention |
| **v2.5** | LLM fallback through MCP, opt-in | Family 4 — last-resort |
| **v2.6** | Refactoring-aware merge, experimental | Family 3 — RefMerge in TS |

Each release is independently shippable. The two big architectural shifts are v2.3 (tree-sitter, with a runtime adapter for Node, browser, and Tauri) and v2.5 (async resolution, opt-in, audit-trailed). The full plan was in `CORE-V2-ROADMAP.md` at the root of the repo, with file-level specs and tests for each release (doc since removed — every release it planned has shipped; see the current [ROADMAP.md](https://github.com/devlint/GitWand/blob/main/ROADMAP.md) for what's next).

---

## What I'm trying not to do

A few framing principles I keep coming back to as I plan this:

**Don't claim AI-powered everything.** The literature is clear that deterministic algorithms outperform LLMs on the easy cases and complement them on the hard ones. The split should reflect that. v2.5's LLM fallback is opt-in, default off, after a parse-tree-validity check, with an explicit audit trail.

**Don't break existing users.** `@gitwand/core` is on npm. Every minor bump must keep the public API stable. When v2.1 changes the default diff backend, `lcs()` keeps its signature and `GITWAND_DIFF=lcs` rolls back. When v2.5 adds async resolution, `resolve()` stays synchronous and `resolveAsync()` is the new entry point.

**Don't smuggle in a benchmark.** I'm building a ConGra-mini internally — 50 conflicts graded A-F by complexity — and gating each release on it. The real ConGra is too big to run on every CI build, but it's the reference, and I'll be checking against it on each major release.

**Don't replace the human.** Across all six releases, the principle is the same: the engine resolves what it's confident about, surfaces everything else with full reasoning, and lets the human decide. Auto-resolution is a productivity feature, not an authority feature.

---

## Open questions I haven't solved

A few things I genuinely don't know how to handle yet, in case you want to argue with me in the [GitWand GitHub discussions](https://github.com/devlint/GitWand/discussions):

- **How aggressive should v2.6's refactoring detector be?** RefactoringMiner has 50+ refactoring types. A TypeScript port realistically supports 3-5 well. Where's the cutoff?
- **What's the right default for v2.5?** Off-by-default is the safe choice. But for users who'd benefit, off-by-default means they never discover it. There may be a middle-ground where the first time a `complex` is encountered, GitWand offers — once — to enable LLM fallback.
- **How does this integrate with GitWand's MCP server?** The MCP server is already public. The natural symmetry is: the resolver calls *out* via MCP, and the resolver also exposes itself *as* an MCP tool (which it already does). Both ends of the same protocol.

I'll write per-release posts as v2.1 → v2.6 ship — each with the actual benchmarks and the trade-offs that surfaced. This one is the survey before the work begins.

If you've thought hard about any of this and want to push back, [open an issue or a discussion on GitHub](https://github.com/devlint/GitWand/discussions) — I read everything that lands there.

---

*Curious about GitWand? [Download it here](https://gitwand.app/) — it's free, open-source, and shipping monthly.*

*Sources were at the end of the companion roadmap document (`CORE-V2-ROADMAP.md`, since removed), with the full bibliography (ConGra, Mergiraf, Weave, RefMerge, Da Silva 2024, Project Harmony, MergeBERT, Nugroho EMSE 2019, web-tree-sitter, Pijul, SemanticMerge).*
