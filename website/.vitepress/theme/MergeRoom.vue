<script setup lang="ts">
import { computed, ref } from 'vue'
import { roomCases, roomJournal, summary, decide, clearRoom, finalFile, type ConflictCase } from './room'
import { listCasesTool } from './tools'

const copied = ref<string | null>(null)
const journalOpen = ref(false)

/**
 * `list_cases` is what closes the loop: it is how an agent reads the room back
 * and finds out whether the human made the call it was waiting on. That is
 * invisible if it only appears as a row in a spec table, so the room can show
 * its literal output next to the state it describes. It calls the real tool.
 */
const agentView = ref<string | null>(null)
async function showAgentView() {
  if (agentView.value) { agentView.value = null; return }
  const r = await listCasesTool.execute({}, { signal: new AbortController().signal })
  agentView.value = r.content[0].text
}
async function refreshAgentView() {
  if (!agentView.value) return
  const r = await listCasesTool.execute({}, { signal: new AbortController().signal })
  agentView.value = r.content[0].text
}

/**
 * A decided hunk collapses to the side that was taken. Keeping both columns
 * and both buttons on screen after the call is made is the same mistake as
 * leaving settled work at full weight: the room stops showing what is left.
 * Reopening is one click, because changing your mind is not an error state.
 */
const reopened = ref<Set<string>>(new Set())
const key = (caseId: string, i: number) => `${caseId}:${i}`
const isForkOpen = (caseId: string, h: { autoResolved: boolean; decision: string | null }, i: number) =>
  !h.autoResolved && (!h.decision || reopened.value.has(key(caseId, i)))
function reopen(caseId: string, i: number) {
  const next = new Set(reopened.value)
  next.add(key(caseId, i))
  reopened.value = next
}

const empty = computed(() => roomCases.value.length === 0)

/**
 * The rail is a proportion, not a scoreboard. Three counts as three big
 * numbers is the hero-metric template; the same three as widths of one bar
 * says the thing that actually matters, which is how much is left.
 */
const rail = computed(() => {
  const s = summary.value
  const total = s.hunksSettledByEngine + s.hunksDecidedByYou + s.hunksWaitingOnYou
  if (!total) return null
  const pct = (n: number) => (n / total) * 100
  return {
    total,
    settled: pct(s.hunksSettledByEngine),
    decided: pct(s.hunksDecidedByYou),
    waiting: pct(s.hunksWaitingOnYou),
    done: s.hunksWaitingOnYou === 0,
  }
})

function take(caseId: string, index: number, side: 'ours' | 'theirs') {
  decide(caseId, index, side)
  refreshAgentView()
  const next = new Set(reopened.value)
  next.delete(key(caseId, index))
  reopened.value = next
}

function waitingIn(c: ConflictCase) {
  return c.hunks.filter((h) => !h.autoResolved && !h.decision).length
}

async function copy(id: string, body: string) {
  try {
    await navigator.clipboard.writeText(body)
    copied.value = id
    setTimeout(() => (copied.value = null), 1600)
  } catch {
    copied.value = null
  }
}

const clock = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
</script>

<template>
  <div class="room">
    <!-- One line, not a scoreboard. Reads as a sentence and doubles as the
         only progress indicator on the page. -->
    <div v-if="rail" class="rail">
      <div class="rail-track" role="img" :aria-label="`${summary.hunksSettledByEngine} settled by the engine, ${summary.hunksDecidedByYou} decided by you, ${summary.hunksWaitingOnYou} waiting on you`">
        <span class="rail-fill rail-fill--settled" :style="{ width: rail.settled + '%' }"></span>
        <span class="rail-fill rail-fill--decided" :style="{ width: rail.decided + '%' }"></span>
        <span class="rail-fill rail-fill--waiting" :style="{ width: rail.waiting + '%' }"></span>
      </div>
      <p class="rail-read">
        <span class="tick tick--settled">{{ summary.hunksSettledByEngine }} settled by the engine</span>
        <span v-if="summary.hunksDecidedByYou" class="tick tick--decided">{{ summary.hunksDecidedByYou }} you decided</span>
        <span v-if="summary.hunksWaitingOnYou" class="tick tick--waiting">{{ summary.hunksWaitingOnYou }} waiting on you</span>
        <span v-else class="tick tick--clear">nothing left for you</span>
      </p>
      <button class="ghost" @click="showAgentView">
        {{ agentView ? 'Hide agent view' : 'What the agent sees' }}
      </button>
      <button class="ghost ghost--last" @click="clearRoom">Clear</button>
    </div>

    <Transition name="unfurl">
      <figure v-if="agentView" class="agentview">
        <figcaption>
          <code>list_cases</code> returns this. It is how an agent checks whether you have made the
          call it was waiting on.
        </figcaption>
        <pre class="block">{{ agentView }}</pre>
      </figure>
    </Transition>

    <p v-if="empty" class="void">
      Empty. An agent calls <code>resolve_conflict</code> or <code>parse_git_error</code> and the
      case lands here, split into what it settled and what it will not touch. No agent to hand?
      File one below.
    </p>

    <!-- A ledger, not a stack of cards: one surface, rows separated by rules.
         Settled rows recede to a single quiet line; the ones needing a person
         are the only thing on the page carrying weight. -->
    <TransitionGroup name="file" tag="div" class="ledger">
      <article v-for="c in roomCases" :key="c.id" class="entry">
        <header class="entry-head">
          <code class="entry-id">{{ c.id }}</code>
          <span class="entry-subject">{{ c.kind === 'conflict' ? c.filePath : 'git failure' }}</span>
          <span v-if="c.example" class="entry-flag">example</span>
          <time class="entry-time">{{ clock(c.at) }}</time>
        </header>

        <template v-if="c.kind === 'error'">
          <p v-if="c.titles.length" class="err-title">{{ c.titles.join(' · ') }}</p>
          <pre class="block">{{ c.body }}</pre>
        </template>

        <template v-else>
          <div
            v-for="h in c.hunks"
            :key="h.index"
            class="hunk"
            :class="{
              'hunk--settled': h.autoResolved,
              'hunk--decided': !h.autoResolved && !!h.decision,
              'hunk--open': !h.autoResolved && !h.decision,
            }"
          >
            <div class="hunk-line">
              <span class="hunk-n">{{ h.index }}</span>
              <code class="hunk-type">{{ h.type }}</code>
              <span class="hunk-score">{{ h.confidenceLabel }} {{ h.confidenceScore }}</span>
              <span class="hunk-state">
                <template v-if="h.autoResolved">settled</template>
                <template v-else-if="h.decision">you took {{ h.decision }}</template>
                <template v-else>your call</template>
              </span>
            </div>
            <p class="hunk-why">{{ h.reason }}</p>

            <!-- Only for hunks the engine refused. There is deliberately no
                 control to override one it settled. -->
            <div v-if="isForkOpen(c.id, h, h.index)" class="fork">
              <div class="fork-side">
                <div class="fork-label">ours</div>
                <pre class="block block--side">{{ h.ours.join('\n') || '(empty)' }}</pre>
                <button class="choose" :class="{ 'choose--taken': h.decision === 'ours' }" @click="take(c.id, h.index, 'ours')">
                  Take ours
                </button>
              </div>
              <div class="fork-side">
                <div class="fork-label">theirs</div>
                <pre class="block block--side">{{ h.theirs.join('\n') || '(empty)' }}</pre>
                <button class="choose" :class="{ 'choose--taken': h.decision === 'theirs' }" @click="take(c.id, h.index, 'theirs')">
                  Take theirs
                </button>
              </div>
            </div>

            <!-- Decided: the call collapses to the side that was taken. -->
            <div v-else-if="!h.autoResolved" class="kept">
              <span class="fork-label">{{ h.decision }}</span>
              <pre class="block block--kept">{{ (h.decision === 'ours' ? h.ours : h.theirs).join('\n') || '(empty)' }}</pre>
              <button class="relink" @click="reopen(c.id, h.index)">Change</button>
            </div>
          </div>

          <Transition name="unfurl">
            <div v-if="finalFile(c)" class="done">
              <div class="done-head">
                <span class="done-say">Merged. Nothing left to decide.</span>
                <button class="ghost" @click="copy(c.id, finalFile(c) as string)">
                  {{ copied === c.id ? 'Copied' : 'Copy file' }}
                </button>
              </div>
              <pre class="block block--done">{{ finalFile(c) }}</pre>
            </div>
          </Transition>
          <p v-if="!finalFile(c)" class="held">
            Held: {{ waitingIn(c) }} hunk{{ waitingIn(c) === 1 ? '' : 's' }} still yours to call. The
            merged file appears the moment the last one has a side.
          </p>
        </template>
      </article>
    </TransitionGroup>

    <div v-if="roomJournal.length" class="log">
      <button class="log-toggle" :aria-expanded="journalOpen" @click="journalOpen = !journalOpen">
        {{ journalOpen ? 'Hide' : 'Show' }} activity ({{ roomJournal.length }})
      </button>
      <ul v-if="journalOpen">
        <li v-for="(e, i) in roomJournal" :key="i">
          <time>{{ clock(e.at) }}</time>
          <span class="log-who" :class="`log-who--${e.actor}`">{{ e.actor }}</span>
          <span>{{ e.text }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.room{
  --ink:#e8edf5;
  --ink-dim:#9aa7bd;
  --ink-quiet:#78849a;
  --ground:#0c0c1a;
  --surface:#13131f;
  --rule:rgba(255,255,255,0.09);
  --rule-soft:rgba(255,255,255,0.05);
  --settled:#34d399;
  --waiting:#fbbf24;
  --decided:#a78bfa;
  --ease:cubic-bezier(0.22,1,0.36,1);
  color:var(--ink);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}

/* ── rail ─────────────────────────────────────────────────────────────── */
.rail{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--rule);}
.rail-track{flex:0 0 100%;display:flex;height:5px;border-radius:99px;overflow:hidden;background:rgba(255,255,255,0.06);}
.rail-fill{transition:width .45s var(--ease);}
.rail-fill--settled{background:var(--settled);}
.rail-fill--decided{background:var(--decided);}
.rail-fill--waiting{background:var(--waiting);}
.rail-read{margin:0;font-size:14px;color:var(--ink-dim);display:flex;gap:16px;flex-wrap:wrap;align-items:baseline;}
.tick{display:inline-flex;align-items:baseline;gap:7px;font-variant-numeric:tabular-nums;}
.tick::before{content:'';width:7px;height:7px;border-radius:99px;transform:translateY(-1px);}
.tick--settled{color:var(--settled);}
.tick--settled::before{background:var(--settled);}
.tick--decided{color:var(--decided);}
.tick--decided::before{background:var(--decided);}
.tick--waiting{color:var(--waiting);font-weight:600;}
.tick--waiting::before{background:var(--waiting);}
.tick--clear{color:var(--settled);}
.tick--clear::before{background:var(--settled);}

.ghost{background:transparent;border:1px solid var(--rule);color:var(--ink-dim);border-radius:7px;padding:6px 13px;font:inherit;font-size:13px;cursor:pointer;transition:color .16s,border-color .16s;}
.ghost:hover,.ghost:focus-visible{color:var(--ink);border-color:var(--ink-dim);}

.rail-read{flex:1;}
.agentview{margin:18px 0 0;}
.agentview figcaption{margin:0 0 8px;font-size:12.5px;color:var(--ink-dim);max-width:66ch;line-height:1.55;}
.agentview figcaption code{font-family:'JetBrains Mono',monospace;color:var(--decided);}
.entry-flag{font-size:10.5px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink-quiet);border:1px solid var(--rule);border-radius:99px;padding:2px 8px;}
.void{margin:0;font-size:15px;line-height:1.7;color:var(--ink-dim);max-width:58ch;text-wrap:pretty;}
.void code{font-family:'JetBrains Mono',monospace;font-size:0.9em;color:var(--ink);}

/* ── ledger ───────────────────────────────────────────────────────────── */
.ledger{margin-top:4px;}
.entry{padding:26px 0;border-bottom:1px solid var(--rule-soft);}
.entry-head{display:flex;align-items:baseline;gap:12px;margin-bottom:16px;}
.entry-id{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--decided);}
.entry-subject{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--ink);}
.entry-time{margin-left:auto;font-size:12px;color:var(--ink-dim);font-variant-numeric:tabular-nums;}
.err-title{margin:0 0 10px;font-size:16px;font-weight:600;}

.block{margin:0;padding:13px 15px;background:var(--surface);border:1px solid var(--rule-soft);border-radius:9px;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:300px;color:var(--ink);}
.block--side{max-height:180px;flex:1;}
.block--done{max-height:340px;}

/* Settled work recedes. Open work is the only thing with weight. */
.hunk{padding:13px 0;border-top:1px solid var(--rule-soft);transition:opacity .3s var(--ease);}
.hunk:first-of-type{border-top:none;}
.hunk--settled .hunk-type{color:var(--ink-quiet);}
.hunk--settled .hunk-why,.hunk--settled .hunk-score{color:var(--ink-quiet);}
.hunk--settled:hover .hunk-type,.hunk--settled:hover .hunk-why{color:var(--ink-dim);}
.hunk--open{background:rgba(251,191,36,0.05);border-radius:10px;padding:15px 16px;margin:6px -16px;border-top-color:transparent;}
.hunk-line{display:flex;align-items:baseline;gap:11px;}
.hunk-n{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--ink-dim);min-width:1.2em;font-variant-numeric:tabular-nums;}
.hunk-type{font-family:'JetBrains Mono',monospace;font-size:13.5px;color:var(--ink);}
.hunk-score{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--ink-dim);font-variant-numeric:tabular-nums;}
.hunk-state{margin-left:auto;font-size:11.5px;font-weight:700;letter-spacing:0.02em;}
.hunk--settled .hunk-state{color:var(--settled);}
.hunk--decided .hunk-state{color:var(--decided);}
.hunk--open .hunk-state{color:var(--waiting);}
.hunk-why{margin:7px 0 0 calc(1.2em + 11px);font-size:13.5px;line-height:1.6;color:var(--ink-dim);max-width:70ch;}

.fork{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;}
@media (max-width:660px){.fork{grid-template-columns:1fr;}}
.fork-side{display:flex;flex-direction:column;}
.fork-label{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--ink-dim);margin-bottom:6px;}
.choose{margin-top:9px;padding:9px 15px;border-radius:8px;font:inherit;font-size:13.5px;font-weight:600;background:transparent;color:var(--ink);border:1px solid var(--rule);cursor:pointer;transition:background .16s,border-color .16s,color .16s;}
.choose:hover,.choose:focus-visible{border-color:var(--waiting);color:var(--waiting);}
.choose--taken{background:var(--decided);border-color:var(--decided);color:#12121e;}
.choose--taken:hover{background:var(--decided);color:#12121e;}

.kept{display:flex;align-items:center;gap:12px;margin-top:11px;margin-left:calc(1.2em + 11px);}
.kept .fork-label{margin:0;flex:none;min-width:44px;}
.block--kept{flex:1;max-height:76px;padding:8px 12px;font-size:12px;}
.relink{flex:none;background:transparent;border:none;padding:0;color:var(--ink-dim);font:inherit;font-size:12.5px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--rule);}
.relink:hover,.relink:focus-visible{color:var(--ink);}

.done{margin-top:16px;}
.done-head{display:flex;align-items:center;gap:12px;margin-bottom:9px;}
.done-say{font-size:13.5px;font-weight:600;color:var(--settled);}
.held{margin:14px 0 0;font-size:13.5px;color:var(--waiting);max-width:64ch;}

/* ── activity log, folded away by default ─────────────────────────────── */
.log{margin-top:22px;}
.log-toggle{background:transparent;border:none;padding:0;color:var(--ink-dim);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--rule);}
.log-toggle:hover,.log-toggle:focus-visible{color:var(--ink);}
.log ul{list-style:none;padding:0;margin:14px 0 0;display:flex;flex-direction:column;gap:7px;}
.log li{display:flex;gap:11px;align-items:baseline;font-size:13px;line-height:1.5;color:var(--ink-dim);}
.log time{font-family:'JetBrains Mono',monospace;font-size:11px;font-variant-numeric:tabular-nums;}
.log-who{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;min-width:42px;}
.log-who--agent{color:var(--decided);}
.log-who--you{color:var(--settled);}

/* ── motion: only the two moments that mean something ─────────────────── */
.file-enter-active{transition:opacity .34s var(--ease), transform .34s var(--ease);}
.file-enter-from{opacity:0;transform:translateY(10px);}
.unfurl-enter-active{transition:opacity .3s var(--ease), transform .3s var(--ease);}
.unfurl-enter-from{opacity:0;transform:translateY(-6px);}

@media (prefers-reduced-motion:reduce){
  .file-enter-active,.unfurl-enter-active{transition:opacity .01ms;}
  .file-enter-from,.unfurl-enter-from{transform:none;}
  .rail-fill{transition:none;}
  .hunk{transition:none;}
}
</style>
