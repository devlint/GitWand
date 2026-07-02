<script setup lang="ts"></script>

<template>
  <div class="gw-page">
    <section class="ph-hero">
      <div class="ph-inner">
        <span class="ph-badge">MCP server · Official registry · stdio · No API key</span>
        <h1 class="ph-h1">Your AI agents, with a <span class="grad">real Git engine on tap.</span></h1>
        <p class="ph-sub">GitWand's MCP server exposes its deterministic conflict engine to AI agents. GitWand resolves the trivial 95% instantly and deterministically; your agent takes over the complex cases with full context — ours/theirs/base content, classification trace and confidence scores. AI is always opt-in, always auditable.</p>
        <div class="ph-ctas">
          <a href="/guide/mcp" class="ph-btn ph-btn--primary">MCP documentation</a>
          <a href="/" class="ph-btn">← Back to home</a>
        </div>
      </div>
    </section>

    <section class="ph-section">
      <div class="ph-inner">
        <h2 class="ph-h2">How an agent uses GitWand</h2>
        <p class="ph-secsub">Three steps: the engine handles the deterministic work, the agent handles the judgment calls.</p>
        <div class="steps">
          <div class="step">
            <div class="step-n">1</div>
            <div><h3 class="step-t">Preview</h3><p class="step-d">The agent calls <code>gitwand_preview_merge</code> to assess the number of conflicts, their complexity, and the percentage GitWand can resolve on its own.</p></div>
          </div>
          <div class="step">
            <div class="step-n">2</div>
            <div><h3 class="step-t">Auto-resolve</h3><p class="step-d">GitWand instantly resolves trivial patterns (whitespace, one-side-change, same-change…) and returns ambiguous hunks with their classification trace.</p></div>
          </div>
          <div class="step">
            <div class="step-n step-n--ai">AI</div>
            <div><h3 class="step-t">AI resolution</h3><p class="step-d">For each complex conflict, the agent has full context: ours/theirs/base content, classification trace and confidence scores — then proposes a resolution you can accept or reject.</p></div>
          </div>
        </div>
      </div>
    </section>

    <section class="ph-section ph-section--alt">
      <div class="ph-inner cfg-layout">
        <div class="cfg-left">
          <h2 class="ph-h2 ph-h2--left">One command to wire it up</h2>
          <p class="cfg-p">With Claude Code: <code>claude mcp add gitwand -- npx -y @gitwand/mcp</code>. For Claude Desktop, Cursor or Windsurf, drop the config block into your client. The server is also on the official MCP Registry, so registry-aware clients discover it automatically.</p>
          <div class="chips">
            <span class="chip">Claude Code</span>
            <span class="chip">Claude Desktop</span>
            <span class="chip">Cursor</span>
            <span class="chip">Windsurf</span>
            <span class="chip">opencode</span>
            <span class="chip">Continue</span>
          </div>
        </div>
        <div class="cfg-card">
          <div class="cfg-bar"><span class="d d-r"></span><span class="d d-y"></span><span class="d d-g"></span><span class="cfg-title">claude_desktop_config.json</span></div>
<pre class="cfg-code">{
  <span class="k">"mcpServers"</span>: {
    <span class="k">"gitwand"</span>: {
      <span class="k">"command"</span>: <span class="s">"npx"</span>,
      <span class="k">"args"</span>: [
        <span class="s">"@gitwand/mcp"</span>,
        <span class="s">"--cwd"</span>,
        <span class="s">"/path/to/repo"</span>
      ]
    }
  }
}</pre>
        </div>
      </div>
    </section>

    <section class="ph-section">
      <div class="ph-inner">
        <h2 class="ph-h2">LLM fallback, when you get stuck</h2>
        <p class="ph-secsub">For the hunks patterns can't resolve, opt in to LLM resolution via Claude, OpenAI-compatible endpoints, Ollama, or MCP — your model, your key. Every suggestion runs through the same parse-tree validation pipeline as the deterministic patterns, with a decision trace and a reject button. No built-in model, no data leaving your machine unless you choose it.</p>
        <div class="why4">
          <div class="w4"><h3>Opt-in only</h3><p>Deterministic patterns run first and free. The LLM is called only for what's left.</p></div>
          <div class="w4"><h3>Validated</h3><p>LLM output is parsed and validated like any other resolution — not trusted blindly.</p></div>
          <div class="w4"><h3>Your provider</h3><p>Claude · OpenAI-compatible · Ollama · MCP. Your key, your endpoint, your data.</p></div>
          <div class="w4"><h3>Auditable</h3><p>Full decision trace and a one-click reject on every proposed resolution.</p></div>
        </div>
        <div class="ph-ctas ph-ctas--center">
          <a href="/guide/llm-fallback" class="ph-btn ph-btn--primary">AI fallback guide</a>
          <a href="/conflict-engine" class="ph-btn">The conflict engine →</a>
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
.ph-hero{padding:80px 0 56px;text-align:center;background:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(16,185,129,0.14) 0%,transparent 70%),var(--bg);border-bottom:1px solid var(--border-soft);}
.ph-badge{display:inline-block;font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;color:var(--green);background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);margin-bottom:18px;}
.ph-h1{font-size:44px;line-height:1.15;font-weight:800;letter-spacing:-0.02em;margin:0 auto 18px;max-width:820px;}
.ph-h1 .grad{background:linear-gradient(135deg,var(--purple),var(--green));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
.ph-sub{font-size:18px;line-height:1.65;color:var(--muted);max-width:720px;margin:0 auto 28px;}
.ph-ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.ph-ctas--center{margin-top:36px;}
.ph-btn{padding:11px 22px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;color:var(--text);border:1px solid var(--border-soft);transition:border-color .15s,color .15s;}
.ph-btn:hover{border-color:var(--purple);color:var(--purple);}
.ph-btn--primary{background:var(--purple-d);color:#fff;border-color:var(--purple-d);}
.ph-btn--primary:hover{background:var(--purple);color:#fff;}
.ph-section{padding:72px 0;}
.ph-section--alt{background:var(--bg2);border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);}
.ph-h2{font-size:30px;font-weight:800;letter-spacing:-0.01em;text-align:center;margin:0 0 10px;}
.ph-h2--left{text-align:left;}
.ph-secsub{font-size:16px;color:var(--muted);text-align:center;max-width:680px;margin:0 auto 40px;line-height:1.6;}
.steps{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:20px;}
.step{display:flex;gap:18px;align-items:flex-start;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px;}
.step-n{flex-shrink:0;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:var(--purple);background:rgba(124,58,237,0.12);}
.step-n--ai{color:var(--green);background:rgba(16,185,129,0.12);font-size:14px;}
.step-t{margin:0 0 6px;font-size:17px;font-weight:700;}
.step-d{margin:0;font-size:14.5px;line-height:1.6;color:var(--muted);}
.step-d code,.cfg-p code{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--purple);background:rgba(124,58,237,0.1);padding:1px 6px;border-radius:5px;}
.cfg-layout{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center;}
.cfg-p{font-size:15px;line-height:1.7;color:var(--muted);margin:0 0 20px;}
.chips{display:flex;flex-wrap:wrap;gap:8px;}
.chip{font-size:13px;padding:6px 13px;border-radius:999px;border:1px solid var(--border);color:var(--muted);}
.cfg-card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.cfg-bar{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid var(--border-soft);}
.d{width:10px;height:10px;border-radius:50%;}.d-r{background:#f87171;}.d-y{background:#fbbf24;}.d-g{background:var(--green);}
.cfg-title{margin-left:8px;font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace;}
.cfg-code{margin:0;padding:18px;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.7;color:var(--text);overflow-x:auto;}
.cfg-code .k{color:var(--purple);}.cfg-code .s{color:var(--green);}
.why4{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;}
.w4{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;}
.w4 h3{margin:0 0 8px;font-size:16px;font-weight:700;}
.w4 p{margin:0;font-size:14px;line-height:1.55;color:var(--muted);}
@media(max-width:760px){.cfg-layout{grid-template-columns:1fr;}.ph-h2--left{text-align:center;}}
@media(max-width:640px){.ph-h1{font-size:32px;}.ph-h2{font-size:24px;}}
</style>
