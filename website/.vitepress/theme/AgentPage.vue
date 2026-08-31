<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { TOOLS, parseGitErrorTool, resolveConflictTool } from './tools'
import MergeRoom from './MergeRoom.vue'
import { SAMPLE_GIT_ERROR, SAMPLE_CONFLICT, SAMPLE_LOCKFILE, SAMPLE_DETACHED_HEAD } from './tools/samples'
import { registerTools, type Surface } from './webmcp'

/**
 * Registration happens on mount, never during the SSR pass: `document` does
 * not exist there, and tools belong to a live document anyway. The
 * AbortController is what unregisters them when the visitor navigates away,
 * which matters on a SPA-routed site where the document outlives the page.
 */
const surface = ref<Surface>(null)
const registered = ref<string[]>([])
const failed = ref<{ name: string; reason: string }[]>([])
const settled = ref(false)

let controller: AbortController | null = null

// No separate call counter any more: the room's activity log records every
// invocation with its actor and timestamp, which is the same evidence in a
// form that says what happened rather than only how often.
/**
 * Seed one real case on arrival. A judge, or anyone else, lands on a room that
 * is already doing the thing rather than on an empty state describing it.
 *
 * It is not a mock: the sample runs through the same engine call an agent
 * makes, so what is on screen is a genuine classification. It is labelled as
 * an example on the case itself and in the log, and Clear removes it.
 */
async function seedExample() {
  const signal = new AbortController().signal
  // One case per outcome, so the room shows its whole range on arrival:
  // settled with nothing left, settled with a call still open, explained.
  await resolveConflictTool.execute(
    { content: SAMPLE_LOCKFILE, filePath: 'pnpm-lock.yaml' },
    { signal },
    { example: true },
  )
  await resolveConflictTool.execute(
    { content: SAMPLE_CONFLICT, filePath: 'src/server.ts' },
    { signal },
    { example: true },
  )
  await parseGitErrorTool.execute({ output: SAMPLE_DETACHED_HEAD }, { signal }, { example: true })
}

onMounted(async () => {
  await seedExample()
  controller = new AbortController()
  const outcome = await registerTools(TOOLS, { signal: controller.signal })
  surface.value = outcome.surface
  registered.value = outcome.registered
  failed.value = outcome.failed
  settled.value = true
})

onUnmounted(() => controller?.abort())

/**
 * Try-it panel. Calls the same `execute` an agent calls, not a mock of it,
 * which is the only version of this worth shipping: if the panel disagreed
 * with the tool, the page would be lying.
 */

type ToolId = 'resolve_conflict' | 'parse_git_error'

const active = ref<ToolId>('resolve_conflict')
const errorInput = ref(SAMPLE_GIT_ERROR)
const conflictInput = ref(SAMPLE_CONFLICT)
const conflictPath = ref('src/server.ts')
const output = ref<string | null>(null)
const running = ref(false)

async function run() {
  running.value = true
  output.value = null
  const signal = new AbortController().signal
  try {
    // Deliberately the un-instrumented tool: registerTools wraps a copy for
    // its counter, so clicking here does not inflate the agent call count.
    const result =
      active.value === 'parse_git_error'
        ? await parseGitErrorTool.execute({ output: errorInput.value }, { signal })
        : await resolveConflictTool.execute(
            { content: conflictInput.value, filePath: conflictPath.value },
            { signal },
          )
    output.value = result.content.map((c) => c.text).join('\n')
  } catch (err) {
    output.value = `The tool threw: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    running.value = false
  }
}

function pick(id: ToolId) {
  active.value = id
  output.value = null
}

</script>

<template>
  <div class="gw-page">
    <!-- ══ WORKSHOP ══════════════════════════════════════════════════════
         A tool, not a pitch. Status is a strip, not a section: it is a
         connection indicator, and giving it a heading of its own is what
         made the previous version read as two things fighting. -->
    <div class="shop">
      <div class="wrap">
        <div class="strip" :class="settled ? (surface ? 'strip--on' : 'strip--off') : 'strip--wait'">
          <span class="dot" aria-hidden="true"></span>
          <span v-if="!settled">Looking for a WebMCP entry point…</span>
          <span v-else-if="surface">
            WebMCP live on <code>{{ surface }}.modelContext</code>, {{ registered.length }} tool{{ registered.length === 1 ? '' : 's' }} registered
            <span v-if="surface === 'navigator'" class="strip--legacy">· deprecated location, registered there rather than not at all</span>
          </span>
          <span v-else>No WebMCP in this browser. The room still works by hand, and everything below is readable without it.</span>
          <span v-for="f in failed" :key="f.name" class="strip-fail">{{ f.name }} failed: {{ f.reason }}</span>
        </div>

        <header class="shop-head">
          <h1 class="shop-h1">Merge Room for humans and agents.</h1>
          <p class="shop-line">
            Your agent clears what was never a decision.
            <strong>What your branches genuinely disagree about waits for you.</strong>
          </p>
          <p class="shop-note">No tool on this page can take that call. That is the point.</p>
        </header>

        <MergeRoom />

        <!-- The input sits with the tool it feeds, not in its own marketing bay. -->
        <section class="feed">
          <h2 class="feed-h">File a case</h2>
          <p class="feed-sub">
            The same code an agent calls, wired to the same room. Nothing leaves this tab.
          </p>

          <div class="feed-tabs" role="tablist">
            <button
              v-for="id in (['resolve_conflict', 'parse_git_error'] as const)"
              :key="id"
              class="feed-tab"
              :class="{ 'feed-tab--on': active === id }"
              role="tab"
              :aria-selected="active === id"
              @click="pick(id)"
            >{{ id }}</button>
          </div>

          <div v-if="active === 'resolve_conflict'" class="feed-body">
            <label class="feed-label" for="try-path">File path</label>
            <input id="try-path" v-model="conflictPath" class="feed-input" spellcheck="false" />
            <p class="feed-hint">
              The extension picks the format-aware resolvers and the path is what marks a generated
              file. Try <code>pnpm-lock.yaml</code> to watch the answer change.
            </p>
            <label class="feed-label" for="try-conflict">Conflicted file</label>
            <textarea id="try-conflict" v-model="conflictInput" class="feed-area" rows="13" spellcheck="false"></textarea>
          </div>

          <div v-else class="feed-body">
            <label class="feed-label" for="try-error">Output of the failing git command</label>
            <textarea id="try-error" v-model="errorInput" class="feed-area" rows="8" spellcheck="false"></textarea>
          </div>

          <button class="feed-run" :disabled="running" @click="run">
            {{ running ? 'Running…' : `Call ${active}` }}
          </button>
          <p v-if="output" class="feed-note">Filed. The case is in the room above.</p>
        </section>
      </div>
    </div>

    <!-- ══ THE BREAK ═════════════════════════════════════════════════════
         Deliberate and visible. Above it the page is a tool; below it the
         page argues. Interleaving the two is what made it muddled. -->
    <div class="seam" aria-hidden="true"></div>

    <!-- ══ SHOWCASE ══════════════════════════════════════════════════════ -->
    <div class="tell">
      <div class="wrap">
        <p class="tell-lede">
          Every other tool in this space asks you to trust that a model got it right.
          <strong>This one refuses to guess.</strong>
        </p>
        <p class="tell-body">
          Twelve patterns in a classifier registry, eight of which apply on their own. Every
          resolution carries the pattern that produced it, a composite confidence score and a full
          decision trace. Where the two branches genuinely disagree, the engine stops and says so.
          That refusal is the product, so it is enforced in the data rather than promised in the
          copy: nothing exposed on this page can pick a side for you.
        </p>

        <h2 class="tell-h">The three tools</h2>
        <dl class="spec">
          <div class="spec-row">
            <dt><code>resolve_conflict</code></dt>
            <dd>
              <p>A file with conflict markers goes in. Hunks that carry no decision come back
              resolved; the rest are filed for you, with the reason each one was refused.</p>
              <p class="spec-io"><code>{ content: string, filePath?: string }</code></p>
            </dd>
          </div>
          <div class="spec-row">
            <dt><code>parse_git_error</code></dt>
            <dd>
              <p>The raw output of a git command that failed goes in. Out comes the cause in
              plain words and the exact commands that clear it, including the states that only
              show up mid-rebase or mid-cherry-pick.</p>
              <p class="spec-io"><code>{ output: string }</code></p>
            </dd>
          </div>
          <div class="spec-row">
            <dt><code>list_cases</code></dt>
            <dd>
              <p>Closes the loop. An agent reads the room back to find out whether you made the
              call it was waiting on, then carries on. Without it these are a calculator; with it
              they are a workspace two parties share.</p>
              <p class="spec-io"><code>{}</code></p>
            </dd>
          </div>
        </dl>

        <p class="tell-foot">
          None of these runs git or touches a repository, and none uploads what you pass it. For the
          real thing against your working tree, there is
          <a href="/guide/mcp"><code>@gitwand/mcp</code></a>. WebMCP carries callable tools only, no
          resources, prompts or sampling, so this page is the zero-install door rather than the
          whole house. <a href="/conflict-engine">How the engine decides →</a>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gw-page{
  --ink:#e8edf5;
  --ink-dim:#9aa7bd;
  --ground:#0c0c1a;
  --ground-tell:#08080f;
  --surface:#13131f;
  --rule:rgba(255,255,255,0.09);
  --rule-soft:rgba(255,255,255,0.05);
  --brand:#a78bfa;
  --settled:#34d399;
  --waiting:#fbbf24;
  --ease:cubic-bezier(0.22,1,0.36,1);
  background:var(--ground);
  color:var(--ink);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:940px;margin:0 auto;padding:0 26px;}

/* ── workshop ─────────────────────────────────────────────────────────── */
.shop{padding:20px 0 74px;}
.strip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--ink-dim);padding:11px 15px;background:var(--surface);border:1px solid var(--rule-soft);border-radius:9px;}
.strip code{font-family:'JetBrains Mono',monospace;font-size:0.92em;color:var(--ink);}
.dot{width:7px;height:7px;border-radius:99px;background:var(--ink-dim);flex:none;}
.strip--on .dot{background:var(--settled);box-shadow:0 0 0 3px rgba(52,211,153,0.16);}
.strip--wait .dot{background:var(--brand);}
.strip--legacy{color:var(--waiting);}
.strip-fail{color:#f87171;}

.shop-head{margin:26px 0 22px;}
.shop-h1{font-size:36px;line-height:1.1;font-weight:800;letter-spacing:-0.03em;margin:0 0 12px;max-width:18ch;text-wrap:balance;}
.shop-line{margin:0;font-size:19px;line-height:1.55;color:var(--ink-dim);max-width:46ch;text-wrap:balance;}

.shop-line strong{color:var(--ink);font-weight:700;}
.shop-note{margin:10px 0 0;font-size:14px;color:var(--ink-dim);}
.feed{margin-top:52px;padding-top:30px;border-top:1px solid var(--rule);}
.feed-h{font-size:15px;font-weight:700;margin:0 0 5px;letter-spacing:-0.01em;}
.feed-sub{margin:0 0 20px;font-size:13.5px;color:var(--ink-dim);}
.feed-tabs{display:flex;gap:7px;margin-bottom:18px;flex-wrap:wrap;}
.feed-tab{font-family:'JetBrains Mono',monospace;font-size:12.5px;padding:7px 13px;border-radius:7px;background:transparent;color:var(--ink-dim);border:1px solid var(--rule-soft);cursor:pointer;transition:color .16s,border-color .16s,background .16s;}
.feed-tab:hover,.feed-tab:focus-visible{color:var(--ink);}
.feed-tab--on{color:var(--ink);border-color:var(--rule);background:var(--surface);}
.feed-body{display:flex;flex-direction:column;}
.feed-label{font-size:12.5px;font-weight:600;margin-bottom:6px;}
.feed-body > .feed-label:not(:first-child){margin-top:17px;}
.feed-hint{font-size:12.5px;color:var(--ink-dim);margin:7px 0 0;line-height:1.55;}
.feed-hint code{font-family:'JetBrains Mono',monospace;color:var(--ink);}
.feed-input,.feed-area{width:100%;box-sizing:border-box;background:var(--surface);color:var(--ink);border:1px solid var(--rule-soft);border-radius:8px;padding:10px 13px;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.65;}
.feed-input:focus,.feed-area:focus{outline:none;border-color:var(--brand);}
.feed-area{resize:vertical;}
.feed-run{margin-top:17px;align-self:flex-start;padding:10px 19px;border-radius:8px;font:inherit;font-size:13.5px;font-weight:600;background:var(--ink);color:#0c0c14;border:1px solid var(--ink);cursor:pointer;transition:opacity .16s;}
.feed-run:hover:not(:disabled){opacity:0.86;}
.feed-run:disabled{opacity:0.5;cursor:default;}
.feed-note{margin:12px 0 0;font-size:13px;color:var(--settled);}

/* ── the break ────────────────────────────────────────────────────────── */
.seam{height:0;border-top:1px solid var(--rule);box-shadow:0 -22px 44px -30px rgba(167,139,250,0.55);}

/* ── showcase ─────────────────────────────────────────────────────────── */
.tell{background:var(--ground-tell);padding:96px 0 100px;}
.tell-lede{margin:0 0 26px;font-size:29px;line-height:1.3;font-weight:600;letter-spacing:-0.02em;color:var(--ink-dim);max-width:24ch;text-wrap:balance;}
.tell-lede strong{color:var(--ink);font-weight:800;display:block;}
.tell-body{margin:0 0 62px;font-size:16px;line-height:1.75;color:var(--ink-dim);max-width:70ch;text-wrap:pretty;}
.tell-h{font-size:13px;font-weight:700;margin:0 0 4px;color:var(--ink);}

.spec{margin:0 0 44px;}
.spec-row{display:grid;grid-template-columns:minmax(160px,0.9fr) 2fr;gap:26px;padding:22px 0;border-top:1px solid var(--rule-soft);}
@media (max-width:680px){.spec-row{grid-template-columns:1fr;gap:9px;}}
.spec-row dt code{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--brand);}
.spec-row dd{margin:0;}
.spec-row dd p{margin:0;font-size:14.5px;line-height:1.65;color:var(--ink-dim);max-width:62ch;}
.spec-io{margin-top:9px !important;font-family:'JetBrains Mono',monospace;}
.spec-io code{font-size:12.5px;color:var(--ink-dim);}

.tell-foot{margin:0;font-size:14px;line-height:1.75;color:var(--ink-dim);max-width:70ch;}
.tell-foot a{color:var(--brand);text-underline-offset:3px;}
.tell-foot code{font-family:'JetBrains Mono',monospace;font-size:0.92em;}

@media (max-width:640px){
  .shop-h1{font-size:32px;}
  .tell-lede{font-size:24px;}
}
</style>
