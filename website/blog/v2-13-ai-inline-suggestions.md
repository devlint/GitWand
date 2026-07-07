---
title: "AI code review in your PR diff: how GitWand v2.13 works"
description: "GitWand v2.13 ships two AI features that live inside the PR diff itself: per-hunk critique with a four-tier verdict, and a suggestion editor that turns an edited line into a mergeable GitHub suggestion block. Plus named AI prompt presets for commit messages. Here's how all three work under the hood."
date: 2026-05-18
head:
  - - meta
    - property: og:title
      content: "AI code review in your PR diff: how GitWand v2.13 works"
  - - meta
    - property: og:description
      content: "Per-hunk AI critique (ok / nit / suggestion / risk), inline suggestion editor (GitHub suggestion blocks), and named AI prompt presets. The v2.13 architecture, UX decisions, and the prompt engineering behind it."
  - - meta
    - name: twitter:title
      content: "AI code review in your PR diff: how GitWand v2.13 works"
---

# AI code review in your PR diff: how GitWand v2.13 works

`@gitwand/desktop@2.13.0` ships two AI features that live directly inside the PR diff view, plus a third that rethinks how you drive AI commit message generation. None of them require a cloud account, a separate browser tab, or context-switching outside the app. They all route through the AI provider you already configured — Anthropic, OpenAI, a local Ollama model, or the GitWand MCP path that needs no API key.

The three features are:

1. **Per-hunk AI critique** — a "Review hunk" button on every diff section that asks your AI provider to classify the change as `ok`, `nit`, `suggestion`, or `risk`, with a one-to-three-sentence explanation.
2. **Inline code suggestions** — a pencil icon on hover for every non-delete line; click it, edit the proposed replacement, hit "Add to review", and the change is staged as a GitHub suggestion block the PR author can apply in a single click.
3. **AI prompt presets** — four built-in system-prompt styles for AI commit messages (Default / Concise / Detailed / Emoji) plus unlimited custom presets, switchable per repo from a picker in the commit panel.

This post goes through each one in depth — the UX model, the prompt design, the JSON parsing, the Vue state machine, and the trade-offs.

---

## Part 1: per-hunk AI critique

### Why per-hunk instead of per-file

The obvious design is "review this file". The obvious design is wrong.

A diff file can span hundreds of lines across a dozen unrelated hunks — a dependency bump in the import block, a guard clause added to a function, a refactor of a loop three functions below. Asking the LLM to reason about all of it at once produces either a generic summary or an overlong dump that buries the one real concern in noise. Per-hunk review is cheaper (smaller context), faster (one hunk is rarely more than 3 000 characters), and more precise — the LLM is forced to reason about *one* thing, and the result renders right next to the hunk it describes.

The tradeoff is that the model can't see cross-hunk interactions. If hunk 1 adds a function and hunk 3 calls it in a way that's wrong given hunk 1's preconditions, per-hunk review misses that. That's a known limitation, not a surprise. For the cases it does catch — null-check gaps, resource leaks in an added `finally` block, a subtly wrong condition — per-hunk review is both faster to run and faster to read than a whole-file analysis.

### The composable: `usePrHunkCritique`

The critique logic lives in `apps/desktop/src/composables/usePrHunkCritique.ts`. The interface it exposes is minimal:

```ts
export interface HunkCritiqueResult {
  verdict: "ok" | "nit" | "suggestion" | "risk";
  summary: string; // 1–3 sentences
}

export function usePrHunkCritique() {
  const isGenerating = ref(false);
  const lastError = ref<string | null>(null);

  async function critique(
    filePath: string,
    hunk: DiffHunk,
    options: HunkCritiqueOptions = {},
  ): Promise<HunkCritiqueResult>

  return { isGenerating, lastError, critique };
}
```

The verdict scale maps cleanly to UI treatment. `ok` gets a green success-soft background — the hunk is clean, move on. `nit` gets a neutral muted background with a `·` marker — there's something, but it's stylistic. `suggestion` gets an accent-soft background with a `💡` — a concrete improvement to consider. `risk` gets a warning-soft background with a `⚠` — something could break.

The four-tier scale came from watching reviewers write comments. Most real PR comments fall into one of three buckets: "this is fine" (reviewers often explicitly say so to close discussion), "you could do this more cleanly" (nits and suggestions), or "this will break in production" (risks). Collapsing nit and suggestion into one bucket loses the signal about severity. Adding a fifth tier ("blocker" / "must-fix") runs into the problem that the model can't actually know whether an issue is blocking without more context than a hunk provides, so it over-fires; `risk` is the appropriate ceiling.

### The system prompt

```ts
function buildSystemPrompt(locale: string): string {
  const lang = locale === "fr" ? "French" : "English";
  return `You are a senior engineer reviewing one hunk of a pull
request diff.

You will receive:
- The file path.
- The hunk header (line ranges).
- The hunk's unified-diff content (context / added / removed lines).

Produce a short, actionable review in strict JSON:
{
  "verdict": "ok" | "nit" | "suggestion" | "risk",
  "summary": "<1–3 short sentences in ${lang}>"
}

Verdict scale (strict):
- "ok"         → nothing to flag; the hunk looks fine.
- "nit"        → minor readability / style issue, nothing critical.
- "suggestion" → a concrete improvement (naming, edge case, missing
                 null check, missing test).
- "risk"       → potential bug, security issue, breaking change, or
                 a behaviour regression.

Rules:
- Be concrete. Quote a line / symbol when it helps, but DO NOT
  paste the whole hunk back.
- If the hunk is trivial (whitespace, comment tweak, formatting),
  verdict MUST be "ok" and summary MUST acknowledge that.
- Never invent symbols or behaviours that aren't in the hunk.
- Write the summary in ${lang}. No code fences, no markdown
  headings, no preamble. Output ONLY the JSON object.`;
}
```

Three things worth noting. First, the locale: both the system prompt and the hunk-to-text serialiser are locale-aware. If the UI is in French, the critique lands in French. The model doesn't need a separate instruction to stay in one language — telling it `"in French"` in the constraint block is sufficient for every provider we tested. Second, the "trivial hunk" rule. Without it, models reliably manufacture `suggestion`-verdict responses for whitespace-only diffs, which trains users to ignore the panel. Forcing `ok` + an acknowledgment on trivial content keeps the signal-to-noise ratio high. Third, the strict JSON contract plus the explicit "no code fences, no preamble" instruction — models occasionally wrap their output in a markdown code block by default, and the parser needs to handle that fallback.

### Serialising the hunk

The hunk is serialised as a plain unified-diff text block, capped at 3 000 characters:

```ts
function hunkToText(filePath: string, hunk: DiffHunk, maxChars: number): string {
  const lines: string[] = [];
  lines.push(`File: ${filePath}`);
  lines.push(`Hunk: ${hunk.header}`);
  lines.push("");
  for (const line of hunk.lines) {
    const marker = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
    lines.push(`${marker} ${line.content}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + "\n... (truncated)";
}
```

The 3 000-character cap is conservative — most provider context windows can comfortably handle 3× that — but it avoids billing surprises on unusually large hunks and keeps latency predictable. In practice, over 95 % of hunks in the test fixture are under 2 000 characters.

### JSON parsing and fallback

The model is instructed to return raw JSON. It doesn't always listen:

```ts
function extractJson(raw: string): HunkCritiqueResult | null {
  let s = raw.trim();
  // Strip optional ``` fence the model might wrap around it
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();
  // Tolerate leading/trailing prose by finding the outermost braces
  const brace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (brace !== -1 && lastBrace > brace) s = s.slice(brace, lastBrace + 1);
  try {
    const obj = JSON.parse(s);
    // Validate and normalise verdict
    const verdictRaw = typeof obj?.verdict === "string" ? obj.verdict : "";
    const verdict: HunkCritiqueResult["verdict"] =
      ["ok", "nit", "suggestion", "risk"].includes(verdictRaw)
        ? (verdictRaw as HunkCritiqueResult["verdict"])
        : "suggestion";
    const summary = typeof obj?.summary === "string" ? obj.summary.trim() : "";
    if (!summary) return null;
    return { verdict, summary };
  } catch {
    return null;
  }
}
```

The three-step extraction (fence strip → brace slice → JSON.parse) handles the three most common failure modes: raw JSON (happy path), fenced JSON, and JSON with a preamble sentence. The fallback when `extractJson` returns null is intentional — instead of showing an error, the raw response is treated as a `suggestion`-verdict summary, truncated to 500 characters. The user gets something useful even when the model dodges the JSON contract entirely.

### UI integration: `PrInlineDiff.vue`

The hunk critique is called from `PrInlineDiff.vue`. Each hunk header row renders a compact "Review" button using the existing `.btn--ai` class, visible only when an AI provider is configured (`ai.isAvailable.value`):

```html
<button
  v-if="ai.isAvailable.value"
  class="btn btn--ai pid-hunk-ai"
  :class="{ 'pid-hunk-ai--active': critiqueOpenIdx === hunkIdx }"
  :disabled="critiqueLoadingIdx === hunkIdx"
  @click="requestHunkCritique(hunkIdx)"
>
  <AiSparkle :size="13" />
  {{ t('prInline.aiCritiqueButton') }}
</button>
```

The state is per-hunk using an index-keyed record:

```ts
const critiqueResults = ref<Record<number, HunkCritiqueResult | null>>({});
const critiqueLoadingIdx = ref<number | null>(null);
const critiqueOpenIdx = ref<number | null>(null);
```

Clicking the button a second time on an already-loaded hunk toggles the panel off — a clean "close" with no re-fetch cost. Results are cached for the lifetime of the component (closing and reopening the file in the PR view will re-fetch, which is the right call because the diff may have changed). Only one hunk critique runs at a time (`critiqueLoadingIdx` tracks the active one), which keeps the AI provider from being flooded by a user who clicks every hunk in rapid succession.

The critique panel itself renders between the hunk header and the first line row, inside the hunk's `<div class="pid-hunk">`. CSS left-border colour varies by verdict: green for `ok`, muted for `nit`, accent for `suggestion`, warning for `risk`. The icon and colour combination means the verdict is legible even without reading the text — useful for a fast scan across multiple open critiques.

---

## Part 2: inline code suggestions

### The GitHub suggestion format

GitHub's PR review API supports a special comment body format:

````
```suggestion
replacement code goes here
```
````

When a PR author views a comment in this format, GitHub renders it as a diff block — the original line shown with a red deletion marker, the suggested replacement shown with a green addition marker — with a single "Apply suggestion" button. Applying it commits the change directly to the branch. It's one of the most underused features of the GitHub PR UI, partly because producing the correct format requires being in the GitHub web editor.

GitWand v2.13 makes it available from the diff view in the desktop app.

### The UI flow

Every non-delete line in the diff renders a pencil icon button on hover:

```html
<button
  v-if="dl.type !== 'delete'"
  class="pid-suggest-btn"
  :title="t('pr.inline.suggestTooltip')"
  @click.stop="openSuggest(hunkIdx, lineIdx, dl)"
>
  <svg>…pencil icon…</svg>
</button>
```

Clicking it calls `openSuggest`, which pre-fills a textarea with the line's current content (leading `+` marker stripped), and closes any open regular comment compose box:

```ts
function openSuggest(hunkIdx: number, lineIdx: number, dl: DiffLine) {
  if (dl.type === "delete") return;
  const line = dl.newLineNo ?? 0;
  suggestLine.value = { hunkIdx, lineIdx, line, side: "RIGHT" };
  suggestText.value = dl.content.replace(/^\+?/, "");
  composeLine.value = null;
  composeText.value = "";
}
```

The suggestion editor renders inline, below the line it's anchored to, in a green-tinted textarea framed by the literal ` ```suggestion ` and ` ``` ` fences so the user sees exactly what GitHub will render:

```html
<div class="pid-suggest-preview">
  <span class="pid-suggest-fence">```suggestion</span>
  <textarea
    v-model="suggestText"
    class="pid-textarea pid-suggest-textarea mono"
    rows="3"
    autofocus
    @keydown.ctrl.enter.prevent="submitSuggest"
    @keydown.meta.enter.prevent="submitSuggest"
    @keydown.escape="closeSuggest"
  />
  <span class="pid-suggest-fence">```</span>
</div>
```

Submitting wraps the edited text in the suggestion block and emits `add-to-review` — suggestions are always staged to the pending review draft, never posted as immediate comments. The distinction matters: posting a suggestion immediately without a review context breaks GitHub's suggestion threading, and immediate single-comment posts don't participate in the "Submit review" approval flow.

```ts
function submitSuggest() {
  if (!suggestLine.value || !props.filePath) return;
  const { line } = suggestLine.value;
  const suggestionBlock = `\`\`\`suggestion\n${suggestText.value}\n\`\`\``;
  emit("add-to-review", {
    path: props.filePath,
    line,
    side: "RIGHT",
    body: suggestionBlock,
  });
  closeSuggest();
}
```

The parent (`PrDetailView.vue`) receives `add-to-review` and stages it alongside any regular review comments in the pending draft. The draft count badge in the header (`reviewDraftCount` prop) increments to show the suggestion was received.

### What it doesn't do yet

Multi-line suggestions — where the suggestion block replaces a range of lines, not just one — require passing `start_line` / `start_side` parameters to the GitHub API. The underlying `add-to-review` emit already carries those optional fields (they're used by the existing drag-to-select range comment feature). The suggestion editor in v2.13 is single-line only: the `suggestLine` tracks a single `newLineNo`, and `submitSuggest` builds the API call without `start_line`. Multi-line suggestion selection is the next natural extension — the infrastructure is there, the UI drag gesture isn't wired to it yet.

GitLab support is planned. GitLab uses a slightly different suggestion syntax (also a fenced block, but with `gitlab-suggestion` as the fence language in some contexts; newer GitLab versions handle ` ```suggestion ` similarly to GitHub). The `GitLabProvider` in `forge/GitLabProvider.ts` will need a review-comment endpoint update.

---

## Part 3: AI prompt presets

### The problem with a single system prompt

GitWand's AI commit message generation debuted in an earlier version with a hardcoded system prompt — Conventional Commits, imperative mood, body explaining why. It was a sensible default. It was also the only option, and different workflows need different styles.

Open-source maintainers want every commit to be a proper Conventional Commit with a scope and a body, because the changelog is generated from the commit history. Solo projects often want one-liners, fast to type and fast to scan. Some teams use Gitmoji and expect the emoji prefix as a convention. Detailed commit bodies with explicit WHY/WHAT are a culture choice, not a universal good.

Rather than adding three checkboxes to the AI settings panel, v2.13 introduces named presets — a system-prompt template with a name, description, and body — switchable per repo.

### The four built-in presets

```ts
export const BUILTIN_PRESETS: ReadonlyArray<AiPromptPreset> = [
  {
    id: "__builtin_default",
    name: "Default",
    description: "Conventional Commits, imperative mood, ${lang}.",
    systemPrompt: `…`, // Full Conventional Commits system prompt
  },
  {
    id: "__builtin_concise",
    name: "Concise",
    description: "One-liner only, no body.",
    systemPrompt: `…`, // Subject-only, 60-char cap
  },
  {
    id: "__builtin_detailed",
    name: "Detailed",
    description: "Conventional Commits with a mandatory WHY/WHAT body.",
    systemPrompt: `…`, // Always writes a 2–5 line body
  },
  {
    id: "__builtin_emoji",
    name: "Emoji",
    description: "Gitmoji-style prefix based on change type.",
    systemPrompt: `…`, // ✨ / 🐛 / ♻️ etc.
  },
];
```

Built-in preset IDs use the `__builtin_` prefix. The read functions in `useAiPromptPresets.ts` check for this prefix and route to the in-memory constant rather than `localStorage` — built-ins are immutable and don't persist between sessions, which means a future update to the Default preset's wording ships automatically without a migration.

All four system prompts share a structural pattern: role assignment, numbered rules, output format constraint, explicit "no code fences" instruction. The `${lang}` placeholder is resolved at call time from the current UI locale — the same i18n-awareness the hunk critique uses.

### Per-repo active preset

```ts
function getActivePresetId(cwd: string): string | null {
  return loadSettings().activePresetIdByRepo[cwd] ?? null;
}
```

`activePresetIdByRepo` is a `Record<string, string>` in `AppSettings`, keyed by the repo's working directory path. Null / absent means "use the default built-in". This gives you fine-grained control: one repo uses Detailed (because its changelog is auto-generated and every commit must have a body), another uses Concise (a personal fork where you write one-liners). The active preset follows you across sessions without any manual switching.

### The preset picker in the commit panel

The existing AI commit dropdown in the commit zone now includes a second row of chip-style preset buttons above the "Generate" option. Selecting a chip calls `activate(presetId)`, which writes to `activePresetIdByRepo` and triggers the next AI call to use the new preset. The chip row is scrollable when more than four presets are visible. A "Manage presets…" link at the bottom of the dropdown opens **Settings → AI → Presets** directly.

The Settings panel tab uses a CRUD list: each user preset shows a name, description, and a text area for the system prompt. Edit in place; changes save immediately via `updatePreset`. Delete requires a confirmation chip ("Delete?") to avoid accidental removal. No undo — but presets are just settings strings, and the built-ins are always there as a restore point.

---

## The shared architectural constraint: zero network calls from `@gitwand/core`

All three features use `useAIProvider()`, which resolves at runtime to whichever provider the user has configured. The resolution happens inside `apps/desktop/src/composables/useAIProvider.ts` — a Tauri-side module. None of the AI logic touches `@gitwand/core`.

This is the same constraint that governed the LLM fallback in [v2.5](/blog/v2-5-llm-fallback): `@gitwand/core` must remain browser-compatible and dependency-free. AI calls that go out over the network belong in the Tauri app layer, not in the portable engine. The PR critique and suggestion features are pure UI features — they don't touch the conflict-resolution engine — so the separation is clean.

The MCP path deserves a mention here. If you've configured the [GitWand MCP server](/guide/mcp) and pointed it at a Claude subscription (no API key required), then `useAIProvider()` routes through the MCP tool call instead of a direct API call. All three v2.13 features work over MCP without any code change — the provider abstraction handles it. For teams without an LLM API account, this is the friction-free path.

---

## What's next

Two natural extensions are already in scope for the next cycle.

**Multi-line suggestions.** The suggestion editor anchors to a single line. The GitHub API accepts a `start_line` parameter to replace a range. The drag-to-select gesture that already exists for range comments can be wired to the suggestion flow — select three lines with a drag, click the pencil icon on the last selected line, and the suggestion block replaces the whole range. The infrastructure (the `CommentParams` interface, the drag state machine, the emit handler in `PrDetailView.vue`) is already there.

**GitLab suggestion support.** GitLab's review API is live in the `GitLabProvider`, but suggestion blocks aren't yet serialised through it. GitLab accepts the same ` ```suggestion ` format in newer versions; the change is a small provider-level flag that enables the suggest button for GitLab PRs.

The hunk critique may also get a **"fix it" shortcut**: if the verdict is `suggestion` or `risk`, a "Apply fix →" button could open the suggestion editor pre-filled with the LLM's proposed replacement, rather than the original line. That requires the LLM to output a code snippet alongside the verdict — a change to the system prompt and a new field in `HunkCritiqueResult`. Whether that's net useful or net noisy depends on how often the fix suggestion is actually right; we'll gather data on the current verdicts first.

---

## Try it

Update to v2.13 from the [releases page](https://gitwand.app) or from the in-app update check. If you have an AI provider configured, the "Review" button appears immediately on every hunk header in the PR diff. The pencil icon appears on hover over any non-delete line.

The AI prompt presets are in **Settings → AI → Presets** — four built-ins are ready to use out of the box. The picker lives in the commit zone AI dropdown, next to the existing "Generate commit message" option.

Source on [GitHub](https://github.com/devlint/GitWand). Full v2.13.0 entry in the [changelog](/changelog#v2-13-0-may-2026).

---

*Related reading: [Why we made LLM resolution opt-in](/blog/v2-5-llm-fallback) (the v2.5 architecture that brought AI into the conflict-resolution engine) and [Pairing Claude Code with GitWand](/blog/claude-code-gitwand-ai-agents) (using GitWand's MCP server with an AI coding agent).*

*Curious about GitWand? [Download it here](https://gitwand.app/) — free, open-source, shipping monthly.*
