<script setup lang="ts">
const PATTERNS = [
  { name: 'same_change',           conf: 'certain', auto: true,  desc: 'Both branches made the exact same edit.' },
  { name: 'one_side_change',       conf: 'certain', auto: true,  desc: 'Only one branch touched this block.' },
  { name: 'non_overlapping',       conf: 'high',    auto: true,  desc: 'Additions at different positions in the block.' },
  { name: 'whitespace_only',       conf: 'high',    auto: true,  desc: 'Same logic, different indentation or spacing.' },
  { name: 'reorder_only',          conf: 'high',    auto: true,  desc: 'Same lines, different order.' },
  { name: 'insertion_at_boundary', conf: 'high',    auto: true,  desc: 'New lines added at the edge of a hunk.' },
  { name: 'value_only_change',     conf: 'high',    auto: true,  desc: 'A scalar value (JSON, config) updated on one side.' },
  { name: 'section_only_change',   conf: 'high',    auto: true,  desc: 'A document section edited on one side only.' },
  { name: 'llm_proposed',          conf: 'medium',  auto: true,  desc: 'LLM-proposed resolution above the confidence threshold.' },
  { name: 'complex',               conf: 'low',     auto: false, desc: 'Overlapping edits — surfaced with full classification trace.' },
] as const
</script>

<template>
  <div class="gw-page">
    <section class="ph-hero">
      <div class="ph-inner">
        <span class="ph-badge">Conflict engine</span>
        <h1 class="ph-h1">Deterministic conflict resolution. <span class="grad">No guessing.</span></h1>
        <p class="ph-sub">Every hunk runs through a classifier of 10 deterministic patterns, each with its own confidence profile and automatic resolver. The trivial 95% is resolved without you. The rest is surfaced with a full decision trace — never a black box.</p>
        <div class="ph-ctas">
          <a href="/guide/conflict-resolution" class="ph-btn ph-btn--primary">Read the deep dive</a>
          <a href="/" class="ph-btn">← Back to home</a>
        </div>
      </div>
    </section>

    <section class="ph-section">
      <div class="ph-inner">
        <h2 class="ph-h2">See it resolve a conflict in one second</h2>
        <p class="ph-secsub">GitWand reads code semantics, not just lines — and picks the right resolution for you.</p>
        <div class="demo">
          <div class="demo-panel">
            <div class="demo-head demo-head--before"><span class="dot dot--red"></span>Before — raw conflict</div>
            <div class="demo-code">
              <div class="cl cl-conflict">  &lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD</div>
              <div class="cl">    const theme = 'dark'</div>
              <div class="cl cl-conflict">  =======</div>
              <div class="cl">    const theme = localStorage.getItem('theme') ?? 'dark'</div>
              <div class="cl cl-conflict">  &gt;&gt;&gt;&gt;&gt;&gt;&gt; feature/settings</div>
            </div>
          </div>
          <div class="demo-arrow">→</div>
          <div class="demo-panel">
            <div class="demo-head demo-head--after"><span class="dot dot--green"></span>After — auto-resolved</div>
            <div class="demo-code">
              <div class="cl cl-ok">    const theme = localStorage.getItem('theme') ?? 'dark'</div>
            </div>
            <div class="demo-badge">✓ confidence 97% · one_side_change · deterministic</div>
          </div>
        </div>
      </div>
    </section>

    <section class="ph-section ph-section--alt">
      <div class="ph-inner">
        <h2 class="ph-h2">10 patterns. Deterministic. Auditable.</h2>
        <p class="ph-secsub">Each pattern has its own confidence profile and automatic resolver. The classifier never guesses — when it can't be certain, it hands the hunk back to you with the trace.</p>
        <div class="pat-grid">
          <div v-for="p in PATTERNS" :key="p.name" class="pat" :class="{ 'pat--dim': !p.auto }">
            <div class="pat-head">
              <code class="pat-name">{{ p.name }}</code>
              <span class="pat-conf" :class="`pat-conf--${p.conf}`">{{ p.conf }}</span>
            </div>
            <p class="pat-desc">{{ p.desc }}</p>
            <div class="pat-auto" :class="p.auto ? 'pat-auto--yes' : 'pat-auto--no'">{{ p.auto ? '⚡ Auto-resolved' : '○ Review needed' }}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="ph-section">
      <div class="ph-inner">
        <h2 class="ph-h2">Numbers, not adjectives.</h2>
        <p class="ph-secsub">Performance measured on an M-series chip with typical repositories.</p>
        <div class="bench">
          <div class="bcard"><div class="bval">249k<span>ops/sec</span></div><div class="blabel">1 conflict · ~30 lines</div></div>
          <div class="bcard"><div class="bval">40k<span>ops/sec</span></div><div class="blabel">5 conflicts · ~140 lines</div></div>
          <div class="bcard"><div class="bval">4.5k<span>ops/sec</span></div><div class="blabel">50 conflicts · ~1350 lines</div></div>
          <div class="bcard bcard--p"><div class="bval">322<span>tests</span></div><div class="blabel">Engine · CLI · App — all passing</div></div>
          <div class="bcard bcard--g"><div class="bval">0</div><div class="blabel">Hallucinations — fully deterministic</div></div>
        </div>
        <div class="ph-ctas ph-ctas--center">
          <a href="/" class="ph-btn ph-btn--primary">Download GitWand</a>
          <a href="/ai-agents" class="ph-btn">AI &amp; agents →</a>
        </div>
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
.ph-ctas--center{margin-top:36px;}
.ph-btn{padding:11px 22px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;color:var(--text);border:1px solid var(--border-soft);transition:border-color .15s,color .15s;}
.ph-btn:hover{border-color:var(--purple);color:var(--purple);}
.ph-btn--primary{background:var(--purple-d);color:#fff;border-color:var(--purple-d);}
.ph-btn--primary:hover{background:var(--purple);color:#fff;}
.ph-section{padding:72px 0;}
.ph-section--alt{background:var(--bg2);border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);}
.ph-h2{font-size:30px;font-weight:800;letter-spacing:-0.01em;text-align:center;margin:0 0 10px;}
.ph-secsub{font-size:16px;color:var(--muted);text-align:center;max-width:640px;margin:0 auto 40px;line-height:1.6;}
.demo{display:flex;align-items:center;gap:18px;justify-content:center;flex-wrap:wrap;}
.demo-panel{flex:1;min-width:280px;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.demo-head{padding:10px 14px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border-soft);}
.demo-head--before{color:#f87171;}.demo-head--after{color:var(--green);}
.dot{width:9px;height:9px;border-radius:50%;}.dot--red{background:#f87171;}.dot--green{background:var(--green);}
.demo-code{padding:14px;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.8;color:var(--muted);}
.cl-conflict{color:#f87171;}.cl-ok{color:var(--green);}
.demo-badge{margin:0 14px 14px;font-size:12px;padding:6px 10px;border-radius:8px;background:rgba(16,185,129,0.1);color:var(--green);display:inline-block;}
.demo-arrow{font-size:28px;color:var(--purple);}
.pat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;}
.pat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;}
.pat--dim{opacity:0.75;border-style:dashed;}
.pat-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;}
.pat-name{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--purple);}
.pat-conf{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;}
.pat-conf--certain{color:var(--green);background:rgba(16,185,129,0.12);}
.pat-conf--high{color:var(--purple);background:rgba(124,58,237,0.14);}
.pat-conf--medium{color:#fbbf24;background:rgba(251,191,36,0.12);}
.pat-conf--low{color:#94a3b8;background:rgba(148,163,184,0.12);}
.pat-desc{font-size:13px;color:var(--muted);line-height:1.55;margin:0 0 12px;}
.pat-auto{font-size:12px;font-weight:600;}.pat-auto--yes{color:var(--green);}.pat-auto--no{color:var(--muted);}
.bench{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;}
.bcard{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;}
.bcard--p{border-color:rgba(124,58,237,0.4);}.bcard--g{border-color:rgba(16,185,129,0.4);}
.bval{font-size:32px;font-weight:800;letter-spacing:-0.02em;}
.bval span{font-size:13px;font-weight:500;color:var(--muted);margin-left:4px;}
.blabel{font-size:13px;color:var(--muted);margin-top:6px;}
@media(max-width:640px){.ph-h1{font-size:32px;}.ph-h2{font-size:24px;}}
</style>
