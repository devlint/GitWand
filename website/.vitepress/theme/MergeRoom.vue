<script setup lang="ts">
import { computed, ref } from 'vue'
import { roomCases, roomJournal, summary, decide, clearRoom, finalFile, type ConflictCase } from './room'

const copied = ref<string | null>(null)

const empty = computed(() => roomCases.value.length === 0)

function finalFor(c: ConflictCase) {
  return finalFile(c)
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
  <section class="ph-section">
    <div class="ph-inner">
      <h2 class="ph-h2">The Merge Room</h2>
      <p class="ph-secsub">
        Everything an agent files lands here. The engine settles what carries no decision. Every hunk
        where the two branches genuinely disagree waits for you, and no tool on this page can take
        that call.
      </p>

      <div class="mr-bar">
        <div class="mr-stat">
          <span class="mr-n mr-n--green">{{ summary.hunksSettledByEngine }}</span>
          <span class="mr-l">settled by the engine</span>
        </div>
        <div class="mr-stat">
          <span class="mr-n mr-n--amber">{{ summary.hunksWaitingOnYou }}</span>
          <span class="mr-l">waiting on you</span>
        </div>
        <div class="mr-stat">
          <span class="mr-n">{{ summary.hunksDecidedByYou }}</span>
          <span class="mr-l">decided by you</span>
        </div>
        <button v-if="!empty" class="mr-clear" @click="clearRoom">Clear room</button>
      </div>

      <p v-if="empty" class="mr-empty">
        Nothing filed yet. Ask an agent to call <code>resolve_conflict</code> or
        <code>parse_git_error</code>, or use the panel below to file a case yourself.
      </p>

      <div v-for="c in roomCases" :key="c.id" class="mr-case">
        <header class="mr-head">
          <code class="mr-id">{{ c.id }}</code>
          <span v-if="c.kind === 'conflict'" class="mr-path">{{ c.filePath }}</span>
          <span v-else class="mr-path">git error</span>
          <span class="mr-time">{{ clock(c.at) }}</span>
        </header>

        <template v-if="c.kind === 'error'">
          <p v-if="c.titles.length" class="mr-titles">{{ c.titles.join(' · ') }}</p>
          <pre class="mr-body">{{ c.body }}</pre>
        </template>

        <template v-else>
          <div v-for="h in c.hunks" :key="h.index" class="mr-hunk" :class="{ 'mr-hunk--open': !h.autoResolved && !h.decision }">
            <div class="mr-hunk-head">
              <span class="mr-idx">[{{ h.index }}]</span>
              <code class="mr-type">{{ h.type }}</code>
              <span class="mr-conf" :class="`mr-conf--${h.confidenceLabel}`">{{ h.confidenceLabel }} · {{ h.confidenceScore }}</span>
              <span v-if="h.autoResolved" class="mr-tag mr-tag--auto">settled</span>
              <span v-else-if="h.decision" class="mr-tag mr-tag--you">you took {{ h.decision }}</span>
              <span v-else class="mr-tag mr-tag--open">your call</span>
            </div>
            <p class="mr-reason">{{ h.reason }}</p>

            <!-- Only the hunks the engine refused get a chooser. There is
                 deliberately no control to override one it settled. -->
            <div v-if="!h.autoResolved" class="mr-choose">
              <div class="mr-side">
                <div class="mr-side-head">ours</div>
                <pre class="mr-code">{{ h.ours.join('\n') || '(empty)' }}</pre>
                <button class="mr-pick" :class="{ 'mr-pick--on': h.decision === 'ours' }" @click="decide(c.id, h.index, 'ours')">Take ours</button>
              </div>
              <div class="mr-side">
                <div class="mr-side-head">theirs</div>
                <pre class="mr-code">{{ h.theirs.join('\n') || '(empty)' }}</pre>
                <button class="mr-pick" :class="{ 'mr-pick--on': h.decision === 'theirs' }" @click="decide(c.id, h.index, 'theirs')">Take theirs</button>
              </div>
            </div>
          </div>

          <div v-if="finalFor(c)" class="mr-final">
            <div class="mr-final-head">
              <span>Merged file, ready to paste back</span>
              <button class="mr-copy" @click="copy(c.id, finalFor(c) as string)">
                {{ copied === c.id ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <pre class="mr-code mr-code--final">{{ finalFor(c) }}</pre>
          </div>
          <p v-else class="mr-pending">
            {{ waitingIn(c) }} hunk{{ waitingIn(c) === 1 ? '' : 's' }} still waiting on you. The merged
            file appears here once every one has a side.
          </p>
        </template>
      </div>

      <div v-if="roomJournal.length" class="mr-journal">
        <h3 class="mr-jh">Live journal</h3>
        <ul>
          <li v-for="(e, i) in roomJournal" :key="i">
            <span class="mr-jt">{{ clock(e.at) }}</span>
            <span class="mr-actor" :class="`mr-actor--${e.actor}`">{{ e.actor }}</span>
            <span>{{ e.text }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ph-inner{max-width:1080px;margin:0 auto;padding:0 24px;}
.ph-section{padding:72px 0;}
.ph-h2{font-size:30px;font-weight:800;letter-spacing:-0.01em;text-align:center;margin:0 0 10px;}
.ph-secsub{font-size:16px;color:var(--muted);text-align:center;max-width:660px;margin:0 auto 36px;line-height:1.6;}

.mr-bar{display:flex;align-items:center;gap:28px;flex-wrap:wrap;max-width:820px;margin:0 auto 24px;padding:16px 20px;background:var(--card);border:1px solid var(--border);border-radius:12px;}
.mr-stat{display:flex;flex-direction:column;gap:2px;}
.mr-n{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;}
.mr-n--green{color:var(--green);}
.mr-n--amber{color:#fbbf24;}
.mr-l{font-size:12px;color:var(--muted);}
.mr-clear{margin-left:auto;background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;}
.mr-clear:hover{color:var(--text);border-color:var(--purple);}

.mr-empty{max-width:820px;margin:0 auto;text-align:center;color:var(--muted);font-size:14px;line-height:1.6;}

.mr-case{max-width:820px;margin:0 auto 18px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;}
.mr-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
.mr-id{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--purple);}
.mr-path{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);}
.mr-time{margin-left:auto;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;}
.mr-titles{margin:0 0 8px;font-size:14px;font-weight:600;}
.mr-body{margin:0;padding:12px 14px;background:var(--bg);border:1px solid var(--border-soft);border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:280px;overflow:auto;}

.mr-hunk{padding:12px 0;border-top:1px solid var(--border-soft);}
.mr-hunk:first-of-type{border-top:none;}
.mr-hunk--open{background:rgba(251,191,36,0.04);margin:0 -20px;padding:12px 20px;}
.mr-hunk-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
.mr-idx{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);}
.mr-type{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--purple);}
.mr-conf{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:rgba(148,163,184,0.12);color:var(--muted);}
.mr-conf--certain{color:var(--green);background:rgba(16,185,129,0.12);}
.mr-conf--high{color:var(--purple);background:rgba(124,58,237,0.14);}
.mr-conf--medium{color:#fbbf24;background:rgba(251,191,36,0.12);}
.mr-tag{margin-left:auto;font-size:11px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;}
.mr-tag--auto{color:var(--green);}
.mr-tag--you{color:var(--purple);}
.mr-tag--open{color:#fbbf24;}
.mr-reason{margin:6px 0 0;font-size:13px;color:var(--muted);line-height:1.55;}

.mr-choose{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;}
@media (max-width:640px){.mr-choose{grid-template-columns:1fr;}}
.mr-side{display:flex;flex-direction:column;}
.mr-side-head{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-bottom:5px;}
.mr-code{margin:0;padding:10px 12px;background:var(--bg);border:1px solid var(--border-soft);border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;flex:1;}
.mr-code--final{max-height:320px;}
.mr-pick{margin-top:8px;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;background:transparent;color:var(--text);border:1px solid var(--border-soft);cursor:pointer;}
.mr-pick:hover{border-color:var(--purple);color:var(--purple);}
.mr-pick--on{background:var(--purple-d);border-color:var(--purple-d);color:#fff;}

.mr-final{margin-top:14px;}
.mr-final-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px;font-size:13px;font-weight:600;color:var(--green);}
.mr-copy{background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;}
.mr-copy:hover{color:var(--text);border-color:var(--green);}
.mr-pending{margin:12px 0 0;font-size:13px;color:#fbbf24;}

.mr-journal{max-width:820px;margin:26px auto 0;}
.mr-jh{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin:0 0 10px;}
.mr-journal ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;}
.mr-journal li{display:flex;gap:10px;align-items:baseline;font-size:13px;line-height:1.5;}
.mr-jt{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;}
.mr-actor{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;min-width:44px;}
.mr-actor--agent{color:var(--purple);}
.mr-actor--you{color:var(--green);}
</style>
