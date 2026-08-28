<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { TOOLS, parseGitErrorTool, resolveConflictTool } from './tools'
import { SAMPLE_GIT_ERROR, SAMPLE_CONFLICT } from './tools/samples'
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
const calls = ref<Record<string, number>>({})
const lastCall = ref<string | null>(null)

let controller: AbortController | null = null

function onCall(name: string) {
  calls.value = { ...calls.value, [name]: (calls.value[name] ?? 0) + 1 }
  lastCall.value = name
}

onMounted(async () => {
  controller = new AbortController()
  const outcome = await registerTools(TOOLS, { signal: controller.signal, onCall })
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
    <section class="ph-hero">
      <div class="ph-inner">
        <span class="ph-badge">WebMCP</span>
        <h1 class="ph-h1">Git tools your agent can <span class="grad">just call</span>.</h1>
        <p class="ph-sub">
          This page exposes GitWand's conflict engine to any agent browsing it, through the W3C WebMCP
          standard. No install, no API key, no server: the tools run in the tab you are looking at.
        </p>
        <div class="ph-ctas">
          <a href="/guide/mcp" class="ph-btn ph-btn--primary">Prefer a real MCP server?</a>
          <a href="/conflict-engine" class="ph-btn">How the engine works</a>
        </div>
      </div>
    </section>

    <!-- Live registration state. Deliberately shows failure and absence as
         plainly as success: a demo that always claims to work teaches nobody. -->
    <section class="ph-section">
      <div class="ph-inner">
        <h2 class="ph-h2">Status in this browser</h2>
        <p class="ph-secsub">
          Read live from the page you have open, not from a screenshot taken on a good day.
        </p>

        <div class="st" :class="settled ? (surface ? 'st--on' : 'st--off') : 'st--wait'">
          <template v-if="!settled">
            <p class="st-line">Checking for a WebMCP entry point…</p>
          </template>

          <template v-else-if="surface">
            <p class="st-line">
              <strong>WebMCP available</strong> on <code>{{ surface }}.modelContext</code>.
              {{ registered.length }} tool{{ registered.length === 1 ? '' : 's' }} registered.
            </p>
            <p v-if="surface === 'navigator'" class="st-note">
              This browser only exposes the deprecated location. Chrome 150 kept
              <code>navigator.modelContext</code> as an alias and has announced its removal, so this
              page registered there rather than not at all.
            </p>
            <ul class="st-calls">
              <li v-for="name in registered" :key="name">
                <code>{{ name }}</code>
                <span class="st-count" :class="{ 'st-count--hot': lastCall === name }">
                  called {{ calls[name] ?? 0 }}×
                </span>
              </li>
            </ul>
            <p class="st-note">
              That counter lives in this tab and is never sent anywhere. There is no backend behind
              this page to send it to.
            </p>
          </template>

          <template v-else>
            <p class="st-line"><strong>No WebMCP in this browser.</strong> Nothing was registered.</p>
            <p class="st-note">
              As of today that means most browsers. The API ships behind an origin trial in Chrome and
              a flag in Edge, and natively in the ChatGPT desktop app's built-in browser. Everything
              below is readable without it, which is the point of writing it out.
            </p>
          </template>

          <ul v-if="failed.length" class="st-failed">
            <li v-for="f in failed" :key="f.name"><code>{{ f.name }}</code> failed: {{ f.reason }}</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Runs the real tools, so a visitor with no WebMCP can still see what an
         agent would get back. -->
    <section class="ph-section ph-section--alt">
      <div class="ph-inner">
        <h2 class="ph-h2">Try them without an agent</h2>
        <p class="ph-secsub">
          This runs the same code an agent calls. Nothing is sent anywhere: the engine executes in
          this tab.
        </p>

        <div class="try">
          <div class="try-tabs" role="tablist">
            <button
              v-for="id in (['resolve_conflict', 'parse_git_error'] as const)"
              :key="id"
              class="try-tab"
              :class="{ 'try-tab--on': active === id }"
              role="tab"
              :aria-selected="active === id"
              @click="pick(id)"
            >
              {{ id }}
            </button>
          </div>

          <div v-if="active === 'resolve_conflict'" class="try-body">
            <label class="try-label" for="try-path">File path</label>
            <input id="try-path" v-model="conflictPath" class="try-input" spellcheck="false" />
            <p class="try-hint">
              The extension selects the format-aware resolvers, and the path is what identifies a
              generated file. Try <code>pnpm-lock.yaml</code> to see that change the answer.
            </p>

            <label class="try-label" for="try-conflict">Conflicted file</label>
            <textarea id="try-conflict" v-model="conflictInput" class="try-area" rows="14" spellcheck="false"></textarea>
          </div>

          <div v-else class="try-body">
            <label class="try-label" for="try-error">Output of the failing git command</label>
            <textarea id="try-error" v-model="errorInput" class="try-area" rows="8" spellcheck="false"></textarea>
          </div>

          <button class="try-run" :disabled="running" @click="run">
            {{ running ? 'Running…' : `Call ${active}` }}
          </button>

          <pre v-if="output" class="try-out">{{ output }}</pre>
        </div>
      </div>
    </section>

    <!-- The same tool contract in HTML, for the majority of visitors whose
         browser has no WebMCP and for crawlers that will never run the script. -->
    <section class="ph-section ph-section--alt">
      <div class="ph-inner">
        <h2 class="ph-h2">The two tools, written out</h2>
        <p class="ph-secsub">
          Both are read-only. Neither runs git, neither writes to a repository, and neither uploads
          what you pass it.
        </p>

        <article class="tool">
          <h3 class="tool-name"><code>parse_git_error</code></h3>
          <p class="tool-desc">
            Paste the raw output of a git command that failed. Returns the cause in plain language
            and the specific commands that resolve it, for the common failures: merge conflicts,
            rejected pushes, unrelated histories, detached HEAD, an interrupted merge or rebase,
            authentication.
          </p>
          <p class="tool-io"><span class="tool-k">Input</span> <code>{ output: string }</code></p>
        </article>

        <article class="tool">
          <h3 class="tool-name"><code>resolve_conflict</code></h3>
          <p class="tool-desc">
            Pass a file that still contains conflict markers. Returns the merged result plus a
            per-hunk classification: which conflicts carried no decision and were resolved, which
            need a human, and why in each case. Deterministic patterns only, no model in the loop.
            Pass the real file path when you have one: the extension selects the format-aware
            resolvers, and the path is what identifies a generated file.
          </p>
          <p class="tool-io">
            <span class="tool-k">Input</span> <code>{ content: string, filePath?: string }</code>
          </p>
        </article>

        <p class="foot">
          Neither tool is a substitute for
          <a href="/guide/mcp"><code>@gitwand/mcp</code></a>, which runs against your real repository
          and can write. WebMCP only carries callable tools, with no resources, prompts or sampling.
          This page is the zero-install door, not the full one.
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.gw-page{
  --purple:#8B5CF6;--purple-d:#7C3AED;--green:#10B981;
  --bg:#0c0c1a;--bg2:#111120;--card:#16162a;
  --border:rgba(124,58,237,0.18);--border-soft:rgba(255,255,255,0.06);
  --text:#e2e8f0;--muted:#94a3b8;
  background:var(--bg);color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
.ph-inner{max-width:1080px;margin:0 auto;padding:0 24px;}
.ph-hero{padding:80px 0 56px;text-align:center;background:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(124,58,237,0.18) 0%,transparent 70%),var(--bg);border-bottom:1px solid var(--border-soft);}
.ph-badge{display:inline-block;font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;color:var(--purple);background:rgba(124,58,237,0.1);border:1px solid var(--border);margin-bottom:18px;}
.ph-h1{font-size:44px;line-height:1.15;font-weight:800;letter-spacing:-0.02em;margin:0 auto 18px;max-width:800px;}
.ph-h1 .grad{background:linear-gradient(135deg,var(--purple),var(--green));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
.ph-sub{font-size:18px;line-height:1.65;color:var(--muted);max-width:680px;margin:0 auto 28px;}
.ph-ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.ph-btn{padding:11px 22px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;color:var(--text);border:1px solid var(--border-soft);transition:border-color .15s,color .15s;}
.ph-btn:hover{border-color:var(--purple);color:var(--purple);}
.ph-btn--primary{background:var(--purple-d);color:#fff;border-color:var(--purple-d);}
.ph-btn--primary:hover{background:var(--purple);color:#fff;}
.ph-section{padding:72px 0;}
.ph-section--alt{background:var(--bg2);border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);}
.ph-h2{font-size:30px;font-weight:800;letter-spacing:-0.01em;text-align:center;margin:0 0 10px;}
.ph-secsub{font-size:16px;color:var(--muted);text-align:center;max-width:640px;margin:0 auto 40px;line-height:1.6;}

.st{max-width:640px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-left-width:3px;border-radius:12px;padding:20px 22px;}
.st--on{border-left-color:var(--green);}
.st--off{border-left-color:var(--muted);}
.st--wait{border-left-color:var(--purple);}
.st-line{margin:0;font-size:15px;line-height:1.6;}
.st-note{margin:10px 0 0;font-size:13px;color:var(--muted);line-height:1.55;}
.st-calls{list-style:none;padding:0;margin:14px 0 0;display:flex;flex-direction:column;gap:8px;}
.st-calls li{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;}
.st-count{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;transition:color .2s;}
.st-count--hot{color:var(--green);}
.st-failed{margin:14px 0 0;padding-left:18px;font-size:13px;color:#f87171;}

.try{max-width:760px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 22px;}
.try-tabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;}
.try-tab{font-family:'JetBrains Mono',monospace;font-size:13px;padding:7px 14px;border-radius:8px;background:transparent;color:var(--muted);border:1px solid var(--border-soft);cursor:pointer;transition:color .15s,border-color .15s;}
.try-tab:hover{color:var(--text);}
.try-tab--on{color:var(--purple);border-color:var(--border);background:rgba(124,58,237,0.1);}
.try-body{display:flex;flex-direction:column;}
.try-label{font-size:13px;font-weight:600;margin-bottom:6px;}
.try-hint{font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.5;}
.try-input,.try-area{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);border:1px solid var(--border-soft);border-radius:8px;padding:10px 12px;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.6;}
.try-input:focus,.try-area:focus{outline:none;border-color:var(--purple);}
.try-area{resize:vertical;margin-bottom:4px;}
.try-label + .try-area,.try-hint + .try-label{margin-top:0;}
.try-body > .try-label:not(:first-child){margin-top:16px;}
.try-run{margin-top:16px;align-self:flex-start;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600;background:var(--purple-d);color:#fff;border:1px solid var(--purple-d);cursor:pointer;font-family:'JetBrains Mono',monospace;}
.try-run:hover:not(:disabled){background:var(--purple);}
.try-run:disabled{opacity:0.6;cursor:default;}
.try-out{margin:18px 0 0;padding:14px 16px;background:var(--bg);border:1px solid var(--border-soft);border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:460px;overflow:auto;color:var(--text);}
.tool{max-width:720px;margin:0 auto 20px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 22px;}
.tool-name{margin:0 0 10px;font-size:16px;}
.tool-name code{font-family:'JetBrains Mono',monospace;color:var(--purple);}
.tool-desc{margin:0 0 12px;font-size:14px;line-height:1.65;color:var(--muted);}
.tool-io{margin:0;font-size:13px;color:var(--muted);}
.tool-k{display:inline-block;min-width:52px;font-weight:600;color:var(--text);}
.foot{max-width:720px;margin:28px auto 0;font-size:14px;line-height:1.65;color:var(--muted);text-align:center;}
.foot a{color:var(--purple);}
code{font-family:'JetBrains Mono',monospace;font-size:0.92em;}
</style>
