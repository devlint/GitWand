<script setup lang="ts">
import { ref, computed } from 'vue'

const locale = ref<'fr' | 'en'>((typeof navigator !== 'undefined' && navigator.language?.startsWith('en')) ? 'en' : 'fr')
const faqOpen = ref<number | null>(null)
function toggleFaq(i: number) {
  faqOpen.value = faqOpen.value === i ? null : i
}

const i18n = {
  fr: {
    badge: 'v1.2.0 · Open Source · MIT',
    heroH1a: 'Git, sans',
    heroH1b: 'maux de tête.',
    heroSub: 'GitWand est un client Git natif avec résolution intelligente des conflits de fusion. Desktop, CLI, et extension VS Code — un seul outil, partout.',
    download: 'Télécharger',
    docs: 'Documentation →',
    platforms: 'macOS · Linux · Windows',
    statPatterns: 'patterns de résolution',
    statResolved: 'conflits résolus automatiquement',
    statInterfaces: 'interfaces (Desktop, CLI, VS Code)',
    featTitle: 'Tout ce qu\'il faut pour Git',
    featSub: 'Un workflow complet, sans compromis sur les performances.',
    featPerf: 'Performances natives',
    featPerfDesc: 'Construit avec Tauri 2 et Vue 3. Démarrage en moins d\'une seconde. Aucun overhead Electron.',
    featResolve: 'Résolution intelligente',
    featResolveDesc: '8 patterns de résolution avec scoring de confiance. 95%+ des conflits triviaux résolus sans intervention.',
    featDiff: 'Diff visuel',
    featDiffDesc: 'Viewer de diff unifié avec coloration syntaxique, staging au niveau du hunk, et preview de merge.',
    featHistory: 'Historique & Graph',
    featHistoryDesc: 'Historique complet, graphe DAG interactif, blame de fichier, et recherche dans les commits.',
    featPR: 'Pull Requests intégrées',
    featPRDesc: 'Revue de PR GitHub directement dans l\'app. Commentaires, reviews, statuts CI et aperçu des conflits.',
    featUI: '3 interfaces',
    featUIDesc: 'App desktop (macOS/Linux/Windows), outil CLI gitwand resolve pour CI/CD, et extension VS Code.',
    conflictTitle: 'Les conflits de merge, résolus automatiquement',
    conflictSub: 'GitWand analyse la sémantique du code, pas seulement les lignes. Il choisit la bonne résolution à votre place.',
    conflictBefore: 'Avant — conflit brut',
    conflictAfter: 'Après — résolu automatiquement',
    conflictBadge: 'Confiance 97% · prefer-theirs · sémantique',
    previewTitle: 'Un client Git que vous allez aimer',
    previewSub: 'Interface épurée, thème sombre, toutes les fonctionnalités Git au même endroit.',
    platformsTitle: 'Disponible partout',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Installeur .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g gitwand',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: 'Prêt à simplifier votre workflow Git ?',
    ctaSub: 'Gratuit, open source, et conçu pour les développeurs qui veulent aller vite.',
    ctaDownload: 'Télécharger GitWand',
    llmTitle: 'Vos agents IA dans la boucle',
    llmSub: 'Le serveur MCP de GitWand expose son moteur de conflits aux agents IA. GitWand résout le trivial — votre agent prend le relais pour les cas complexes.',
    llmBadge: 'MCP Server · stdio · Sans clé API',
    llmStep1: 'Analyse',
    llmStep1Desc: 'L\'agent appelle gitwand_preview_merge pour évaluer le nombre de conflits, leur complexité, et le pourcentage que GitWand peut résoudre seul.',
    llmStep2: 'Auto-résolution',
    llmStep2Desc: 'GitWand résout instantanément les patterns triviaux (whitespace, one-side-change, same-change…) et retourne les hunks ambigus avec leur trace de classification.',
    llmStep3: 'Résolution IA',
    llmStep3Desc: 'Pour chaque conflit complexe, l\'agent dispose du contexte complet : contenu ours/theirs/base, trace de classification et scores de confiance.',
    llmCompat: 'Compatible avec',
    llmDocs: 'Voir la documentation MCP →',
    faqTitle: 'Questions fréquentes',
    faqItems: [
      { q: 'GitWand est-il vraiment gratuit ?', a: 'Oui, GitWand est entièrement open source sous licence MIT. Vous pouvez l\'utiliser, le modifier et le redistribuer librement.' },
      { q: 'Comment fonctionne la résolution intelligente des conflits ?', a: 'GitWand analyse la sémantique du code avec 8 patterns de résolution (whitespace_only, same_change, one_side_change…) et un scoring de confiance par hunk. Les conflits triviaux sont résolus automatiquement ; les cas complexes sont remontés avec une trace d\'explication complète.' },
      { q: 'Qu\'est-ce que le serveur MCP et pourquoi l\'utiliser ?', a: 'Le serveur MCP expose le moteur de GitWand aux agents IA — Claude Code, Cursor, Windsurf, et d\'autres. Il tourne en local via stdio, sans clé API ni accès réseau. GitWand gère 95%+ des conflits triviaux, l\'agent IA s\'occupe des cas ambigus avec tout le contexte nécessaire.' },
      { q: 'GitWand fonctionne-t-il avec n\'importe quel dépôt Git ?', a: 'Oui. GitWand fonctionne avec tous les dépôts Git locaux, quel que soit l\'hébergement (GitHub, GitLab, Bitbucket, Gitea…). La vue Pull Requests est pour l\'instant limitée à GitHub.' },
      { q: 'Quelle est la différence avec les autres clients Git ?', a: 'GitWand se distingue par son moteur de résolution intégré, son architecture native Tauri (pas d\'Electron), ses 3 interfaces cohérentes (desktop, CLI, VS Code), et son serveur MCP pour l\'intégration avec les agents IA.' },
      { q: 'Comment installer le serveur MCP ?', a: 'Aucune installation n\'est nécessaire : npx @gitwand/mcp suffit. Ajoutez la configuration dans Claude Desktop, Claude Code ou votre client MCP préféré — la documentation détaille chaque cas.' },
    ],
  },
  en: {
    badge: 'v1.2.0 · Open Source · MIT',
    heroH1a: 'Git, without',
    heroH1b: 'the headaches.',
    heroSub: 'GitWand is a native Git client with smart merge conflict resolution. Desktop, CLI, and VS Code extension — one tool, everywhere.',
    download: 'Download',
    docs: 'Documentation →',
    platforms: 'macOS · Linux · Windows',
    statPatterns: 'resolution patterns',
    statResolved: 'conflicts auto-resolved',
    statInterfaces: 'interfaces (Desktop, CLI, VS Code)',
    featTitle: 'Everything you need for Git',
    featSub: 'A complete workflow with no performance compromise.',
    featPerf: 'Native performance',
    featPerfDesc: 'Built with Tauri 2 and Vue 3. Sub-second startup. Zero Electron overhead.',
    featResolve: 'Smart resolution',
    featResolveDesc: '8 resolution patterns with confidence scoring. 95%+ of trivial conflicts resolved without intervention.',
    featDiff: 'Visual diff',
    featDiffDesc: 'Unified diff viewer with syntax highlighting, hunk-level staging, and merge preview.',
    featHistory: 'History & Graph',
    featHistoryDesc: 'Full history, interactive DAG graph, file blame, and commit search.',
    featPR: 'Integrated Pull Requests',
    featPRDesc: 'Review GitHub PRs directly in the app. Comments, reviews, CI status, and conflict preview.',
    featUI: '3 interfaces',
    featUIDesc: 'Desktop app (macOS/Linux/Windows), gitwand resolve CLI for CI/CD, and VS Code extension.',
    conflictTitle: 'Merge conflicts, resolved automatically',
    conflictSub: 'GitWand analyzes code semantics, not just lines. It picks the right resolution for you.',
    conflictBefore: 'Before — raw conflict',
    conflictAfter: 'After — auto-resolved',
    conflictBadge: 'Confidence 97% · prefer-theirs · semantic',
    previewTitle: 'A Git client you\'ll love',
    previewSub: 'Clean interface, dark theme, every Git feature in one place.',
    platformsTitle: 'Available everywhere',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Installer .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g gitwand',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: 'Ready to simplify your Git workflow?',
    ctaSub: 'Free, open source, and built for developers who want to move fast.',
    ctaDownload: 'Download GitWand',
    llmTitle: 'Your AI agents in the loop',
    llmSub: 'GitWand\'s MCP server exposes its conflict engine to AI agents. GitWand resolves the trivial — your agent takes over for the complex cases.',
    llmBadge: 'MCP Server · stdio · No API key',
    llmStep1: 'Preview',
    llmStep1Desc: 'The agent calls gitwand_preview_merge to assess the number of conflicts, their complexity, and the percentage GitWand can resolve on its own.',
    llmStep2: 'Auto-resolve',
    llmStep2Desc: 'GitWand instantly resolves trivial patterns (whitespace, one-side-change, same-change…) and returns ambiguous hunks with their classification trace.',
    llmStep3: 'AI resolution',
    llmStep3Desc: 'For each complex conflict, the agent has full context: ours/theirs/base content, classification trace, and confidence scores.',
    llmCompat: 'Compatible with',
    llmDocs: 'View MCP documentation →',
    faqTitle: 'Frequently asked questions',
    faqItems: [
      { q: 'Is GitWand really free?', a: 'Yes, GitWand is fully open source under the MIT license. You can use, modify, and redistribute it freely.' },
      { q: 'How does smart conflict resolution work?', a: 'GitWand analyzes code semantics using 8 resolution patterns (whitespace_only, same_change, one_side_change…) with per-hunk confidence scoring. Trivial conflicts are resolved automatically; complex cases are surfaced with a full explanation trace.' },
      { q: 'What is the MCP server and why use it?', a: 'The MCP server exposes GitWand\'s engine to AI agents — Claude Code, Cursor, Windsurf, and others. It runs locally over stdio, with no API key or network access required. GitWand handles 95%+ of trivial conflicts; the AI agent tackles the ambiguous ones with full context.' },
      { q: 'Does GitWand work with any Git repository?', a: 'Yes. GitWand works with any local Git repository, regardless of hosting (GitHub, GitLab, Bitbucket, Gitea…). The Pull Request view is currently limited to GitHub.' },
      { q: 'What sets GitWand apart from other Git clients?', a: 'GitWand stands out with its built-in resolution engine, native Tauri architecture (no Electron), three consistent interfaces (desktop, CLI, VS Code), and an MCP server for AI agent integration.' },
      { q: 'How do I install the MCP server?', a: 'No installation needed: npx @gitwand/mcp is all it takes. Add the configuration to Claude Desktop, Claude Code, or your preferred MCP client — the documentation covers each case.' },
    ],
  },
}

const t = computed(() => i18n[locale.value])

function toggleLocale() {
  locale.value = locale.value === 'fr' ? 'en' : 'fr'
}
</script>

<template>
  <div class="gw-landing">

    <!-- Language toggle -->
    <button class="lang-toggle" @click="toggleLocale" :title="locale === 'fr' ? 'Switch to English' : 'Passer en français'">
      {{ locale === 'fr' ? 'EN' : 'FR' }}
    </button>

    <!-- ══════════════════════════════════════
         HERO
    ══════════════════════════════════════ -->
    <section class="hero">
      <div class="hero-inner">

        <!-- Left: text -->
        <div class="hero-text">
          <span class="badge">{{ t.badge }}</span>
          <h1 class="hero-h1">
            {{ t.heroH1a }}<br>
            <span class="gradient">{{ t.heroH1b }}</span>
          </h1>
          <p class="hero-sub">
            {{ t.heroSub }}
          </p>
          <div class="hero-ctas">
            <a href="https://github.com/devlint/GitWand/releases" class="btn-primary">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v10M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              {{ t.download }}
            </a>
            <a href="/GitWand/guide/getting-started" class="btn-ghost">
              {{ t.docs }}
            </a>
          </div>
          <p class="hero-platforms">{{ t.platforms }}</p>
        </div>

        <!-- Right: app window mockup -->
        <div class="hero-visual">
          <div class="app-window">
            <div class="win-bar">
              <span class="tl tl-r"></span>
              <span class="tl tl-y"></span>
              <span class="tl tl-g"></span>
              <span class="win-title">GitWand — my-project</span>
            </div>
            <div class="win-body">
              <!-- Sidebar -->
              <div class="win-sidebar">
                <div class="sb-section-head">
                  <span>STAGED</span><span class="sb-count">1</span>
                </div>
                <div class="sb-file">
                  <span class="sb-badge sb-added">A</span>
                  <span class="sb-name">package.json</span>
                </div>
                <div class="sb-section-head" style="margin-top:8px">
                  <span>MODIFIED</span><span class="sb-count">2</span>
                </div>
                <div class="sb-file sb-file--active">
                  <span class="sb-badge sb-mod">M</span>
                  <span class="sb-name">App.vue</span>
                </div>
                <div class="sb-file">
                  <span class="sb-badge sb-mod">M</span>
                  <span class="sb-name">index.ts</span>
                </div>
                <div class="sb-commit">
                  <input class="sb-input" placeholder="feat: add auth…" readonly />
                  <button class="sb-btn">Commit 2</button>
                </div>
              </div>
              <!-- Diff viewer -->
              <div class="win-diff">
                <div class="diff-tab">App.vue</div>
                <div class="diff-lines">
                  <div class="dl dl-n"><span class="ln">1</span><span class="dc"> import { ref } from <span class="s">'vue'</span></span></div>
                  <div class="dl dl-a"><span class="ln">2</span><span class="dc">+import { useAuth } from <span class="s">'./composables/auth'</span></span></div>
                  <div class="dl dl-n"><span class="ln">3</span><span class="dc"> </span></div>
                  <div class="dl dl-n"><span class="ln">4</span><span class="dc"> export <span class="k">default</span> {</span></div>
                  <div class="dl dl-n"><span class="ln">5</span><span class="dc">   <span class="k">setup</span>() {</span></div>
                  <div class="dl dl-d"><span class="ln">6</span><span class="dc">-    <span class="k">return</span> {}</span></div>
                  <div class="dl dl-a"><span class="ln">6</span><span class="dc">+    <span class="k">const</span> { user } = useAuth()</span></div>
                  <div class="dl dl-a"><span class="ln">7</span><span class="dc">+    <span class="k">return</span> { user }</span></div>
                  <div class="dl dl-n"><span class="ln">8</span><span class="dc">   }</span></div>
                  <div class="dl dl-n"><span class="ln">9</span><span class="dc"> }</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         STATS BAR
    ══════════════════════════════════════ -->
    <section class="stats-bar">
      <div class="stat">
        <span class="stat-n">8</span>
        <span class="stat-l">{{ t.statPatterns }}</span>
      </div>
      <div class="stat-sep"></div>
      <div class="stat">
        <span class="stat-n">95%+</span>
        <span class="stat-l">{{ t.statResolved }}</span>
      </div>
      <div class="stat-sep"></div>
      <div class="stat">
        <span class="stat-n">3</span>
        <span class="stat-l">{{ t.statInterfaces }}</span>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         FEATURES
    ══════════════════════════════════════ -->
    <section class="features">
      <div class="section-inner">
        <h2 class="section-title">{{ t.featTitle }}</h2>
        <p class="section-sub">{{ t.featSub }}</p>
        <div class="features-grid">

          <div class="feat-card">
            <div class="feat-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h3>{{ t.featPerf }}</h3>
            <p>{{ t.featPerfDesc }}</p>
          </div>

          <div class="feat-card">
            <div class="feat-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 100 14A7 7 0 0012 2z" stroke="#7C3AED" stroke-width="1.8"/><path d="M9 12l2 2 4-4" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h3>{{ t.featResolve }}</h3>
            <p>{{ t.featResolveDesc }}</p>
          </div>

          <div class="feat-card">
            <div class="feat-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="14" rx="2" stroke="#7C3AED" stroke-width="1.8"/><path d="M8 21h8M12 17v4" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <h3>{{ t.featDiff }}</h3>
            <p>{{ t.featDiffDesc }}</p>
          </div>

          <div class="feat-card">
            <div class="feat-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2" stroke="#7C3AED" stroke-width="1.8"/><circle cx="18" cy="6" r="2" stroke="#7C3AED" stroke-width="1.8"/><circle cx="12" cy="18" r="2" stroke="#7C3AED" stroke-width="1.8"/><path d="M8 6h8M7 8l-2 8M17 8l2 8" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <h3>{{ t.featHistory }}</h3>
            <p>{{ t.featHistoryDesc }}</p>
          </div>

          <div class="feat-card">
            <div class="feat-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h3>{{ t.featPR }}</h3>
            <p>{{ t.featPRDesc }}</p>
          </div>

          <div class="feat-card">
            <div class="feat-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/><circle cx="9" cy="7" r="4" stroke="#7C3AED" stroke-width="1.8"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <h3>{{ t.featUI }}</h3>
            <p>{{ t.featUIDesc }}</p>
          </div>

        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         CONFLICT RESOLUTION DEMO
    ══════════════════════════════════════ -->
    <section class="conflict-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.conflictTitle }}</h2>
        <p class="section-sub">{{ t.conflictSub }}</p>

        <div class="conflict-demo">
          <!-- Before -->
          <div class="conflict-panel">
            <div class="conflict-panel-head conflict-panel-head--before">
              <span class="panel-dot panel-dot--red"></span>
              {{ t.conflictBefore }}
            </div>
            <div class="conflict-code">
              <div class="cc-line cc-conflict">  &lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD</div>
              <div class="cc-line cc-ours">    <span class="k">const</span> theme = <span class="s">'dark'</span></div>
              <div class="cc-line cc-conflict">  =======</div>
              <div class="cc-line cc-theirs">    <span class="k">const</span> theme = localStorage.<span class="fn">getItem</span>(<span class="s">'theme'</span>) ?? <span class="s">'dark'</span></div>
              <div class="cc-line cc-conflict">  &gt;&gt;&gt;&gt;&gt;&gt;&gt; feature/settings</div>
            </div>
          </div>

          <!-- Arrow -->
          <div class="conflict-arrow">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none"><path d="M8 20h24M22 12l10 8-10 8" stroke="#7C3AED" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>GitWand</span>
          </div>

          <!-- After -->
          <div class="conflict-panel">
            <div class="conflict-panel-head conflict-panel-head--after">
              <span class="panel-dot panel-dot--green"></span>
              {{ t.conflictAfter }}
            </div>
            <div class="conflict-code">
              <div class="cc-line cc-resolved">    <span class="k">const</span> theme = localStorage.<span class="fn">getItem</span>(<span class="s">'theme'</span>) ?? <span class="s">'dark'</span></div>
            </div>
            <div class="conflict-badge">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 3.5l-7 7L3 7" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {{ t.conflictBadge }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         LLM / MCP SECTION
    ══════════════════════════════════════ -->
    <section class="llm-section">
      <div class="section-inner">
        <span class="badge">{{ t.llmBadge }}</span>
        <h2 class="section-title" style="margin-top:16px">{{ t.llmTitle }}</h2>
        <p class="section-sub">{{ t.llmSub }}</p>

        <div class="llm-layout">
          <!-- Steps -->
          <div class="llm-steps">
            <div class="llm-step">
              <div class="llm-step-num">1</div>
              <div class="llm-step-body">
                <h3 class="llm-step-title">{{ t.llmStep1 }}</h3>
                <p class="llm-step-desc">{{ t.llmStep1Desc }}</p>
              </div>
            </div>
            <div class="llm-connector"></div>
            <div class="llm-step">
              <div class="llm-step-num">2</div>
              <div class="llm-step-body">
                <h3 class="llm-step-title">{{ t.llmStep2 }}</h3>
                <p class="llm-step-desc">{{ t.llmStep2Desc }}</p>
              </div>
            </div>
            <div class="llm-connector"></div>
            <div class="llm-step">
              <div class="llm-step-num llm-step-num--ai">AI</div>
              <div class="llm-step-body">
                <h3 class="llm-step-title">{{ t.llmStep3 }}</h3>
                <p class="llm-step-desc">{{ t.llmStep3Desc }}</p>
              </div>
            </div>
          </div>

          <!-- Code card -->
          <div class="llm-code-card">
            <div class="llm-code-bar">
              <span class="tl tl-r"></span>
              <span class="tl tl-y"></span>
              <span class="tl tl-g"></span>
              <span class="llm-code-title">claude_desktop_config.json</span>
            </div>
            <pre class="llm-code-block"><span class="lc-p">{</span>
  <span class="lc-k">"mcpServers"</span><span class="lc-p">:</span> <span class="lc-p">{</span>
    <span class="lc-k">"gitwand"</span><span class="lc-p">:</span> <span class="lc-p">{</span>
      <span class="lc-k">"command"</span><span class="lc-p">:</span> <span class="lc-s">"npx"</span><span class="lc-p">,</span>
      <span class="lc-k">"args"</span><span class="lc-p">:</span> <span class="lc-p">[</span>
        <span class="lc-s">"@gitwand/mcp"</span><span class="lc-p">,</span>
        <span class="lc-s">"--cwd"</span><span class="lc-p">,</span>
        <span class="lc-s">"/path/to/repo"</span>
      <span class="lc-p">]</span>
    <span class="lc-p">}</span>
  <span class="lc-p">}</span>
<span class="lc-p">}</span></pre>
            <div class="llm-compat">
              <span class="llm-compat-label">{{ t.llmCompat }}</span>
              <div class="llm-compat-chips">
                <span class="llm-chip">Claude Code</span>
                <span class="llm-chip">Claude Desktop</span>
                <span class="llm-chip">Cursor</span>
                <span class="llm-chip">Windsurf</span>
                <span class="llm-chip">Continue</span>
              </div>
            </div>
            <a href="/GitWand/guide/mcp" class="llm-docs-link">{{ t.llmDocs }}</a>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         APP PREVIEW (larger mockup)
    ══════════════════════════════════════ -->
    <section class="preview-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.previewTitle }}</h2>
        <p class="section-sub">{{ t.previewSub }}</p>

        <div class="preview-window">
          <div class="win-bar">
            <span class="tl tl-r"></span>
            <span class="tl tl-y"></span>
            <span class="tl tl-g"></span>
            <span class="win-title">GitWand — my-project · main</span>
            <div class="win-bar-right">
              <span class="win-tab win-tab--active">Changements</span>
              <span class="win-tab">Log</span>
              <span class="win-tab">Graphe</span>
              <span class="win-tab">PRs</span>
            </div>
          </div>
          <div class="win-body">
            <!-- Sidebar -->
            <div class="win-sidebar win-sidebar--lg">
              <div class="sb-section-head">
                <span style="color:#f38ba8">!</span>&nbsp;CONFLITS&nbsp;<span class="sb-count sb-count--red">1</span>
              </div>
              <div class="sb-file sb-file--conflict">
                <span class="sb-badge sb-conflict">!</span>
                <span class="sb-name">merge.ts</span>
              </div>
              <div class="sb-section-head" style="margin-top:10px">
                <span style="color:#a6e3a1">+</span>&nbsp;STAGED&nbsp;<span class="sb-count sb-count--green">3</span>
              </div>
              <div class="sb-file">
                <span class="sb-badge sb-added">A</span>
                <span class="sb-name">auth.ts</span>
              </div>
              <div class="sb-file">
                <span class="sb-badge sb-added">A</span>
                <span class="sb-name">useAuth.ts</span>
              </div>
              <div class="sb-file">
                <span class="sb-badge sb-mod">M</span>
                <span class="sb-name">App.vue</span>
              </div>
              <div class="sb-section-head" style="margin-top:10px">
                <span style="color:#f9e2af">~</span>&nbsp;MODIFIÉS&nbsp;<span class="sb-count sb-count--yellow">2</span>
              </div>
              <div class="sb-file">
                <span class="sb-badge sb-mod">M</span>
                <span class="sb-name">config.ts</span>
              </div>
              <div class="sb-file sb-file--active">
                <span class="sb-badge sb-mod">M</span>
                <span class="sb-name">router.ts</span>
              </div>
              <div class="sb-commit">
                <input class="sb-input" placeholder="feat: user authentication" readonly />
                <button class="sb-btn">Commit 3</button>
              </div>
            </div>
            <!-- Diff viewer -->
            <div class="win-diff win-diff--lg">
              <div class="diff-toolbar">
                <div class="diff-tabs">
                  <span class="diff-tab diff-tab--active">router.ts</span>
                </div>
                <div class="diff-actions">
                  <span class="diff-pill">Unified</span>
                  <span class="diff-pill diff-pill--ghost">Split</span>
                </div>
              </div>
              <div class="diff-lines">
                <div class="dl dl-n"><span class="ln">1</span><span class="dc"><span class="k">import</span> { createRouter } <span class="k">from</span> <span class="s">'vue-router'</span></span></div>
                <div class="dl dl-a"><span class="ln">2</span><span class="dc">+<span class="k">import</span> { useAuth } <span class="k">from</span> <span class="s">'./composables/auth'</span></span></div>
                <div class="dl dl-n"><span class="ln">3</span><span class="dc"> </span></div>
                <div class="dl dl-n"><span class="ln">4</span><span class="dc"><span class="k">const</span> routes = [</span></div>
                <div class="dl dl-n"><span class="ln">5</span><span class="dc">  { path: <span class="s">'/'</span>, component: Home },</span></div>
                <div class="dl dl-a"><span class="ln">6</span><span class="dc">+  { path: <span class="s">'/login'</span>, component: Login },</span></div>
                <div class="dl dl-a"><span class="ln">7</span><span class="dc">+  { path: <span class="s">'/profile'</span>, component: Profile, meta: { requiresAuth: <span class="k">true</span> } },</span></div>
                <div class="dl dl-n"><span class="ln">8</span><span class="dc">]</span></div>
                <div class="dl dl-n"><span class="ln">9</span><span class="dc"> </span></div>
                <div class="dl dl-d"><span class="ln">10</span><span class="dc">-<span class="k">export default</span> createRouter({ history: createWebHistory(), routes })</span></div>
                <div class="dl dl-a"><span class="ln">10</span><span class="dc">+<span class="k">const</span> router = createRouter({ history: createWebHistory(), routes })</span></div>
                <div class="dl dl-a"><span class="ln">11</span><span class="dc">+router.beforeEach(useAuth().requireAuth)</span></div>
                <div class="dl dl-a"><span class="ln">12</span><span class="dc">+<span class="k">export default</span> router</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         PLATFORMS
    ══════════════════════════════════════ -->
    <section class="platforms-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.platformsTitle }}</h2>
        <div class="platforms-grid">
          <div class="platform-card">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z" stroke="#8B5CF6" stroke-width="1.5"/><path d="M8 12.5c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4-4-1.8-4-4z" stroke="#8B5CF6" stroke-width="1.5"/></svg>
            <span class="pl-name">macOS</span>
            <span class="pl-sub">{{ t.plMacSub }}</span>
          </div>
          <div class="platform-card">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#8B5CF6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="pl-name">Linux</span>
            <span class="pl-sub">{{ t.plLinuxSub }}</span>
          </div>
          <div class="platform-card">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/><rect x="13" y="3" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/><rect x="3" y="13" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/><rect x="13" y="13" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/></svg>
            <span class="pl-name">Windows</span>
            <span class="pl-sub">{{ t.plWinSub }}</span>
          </div>
          <div class="platform-card">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7l3-7z" stroke="#10B981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="pl-name">{{ t.plCli }}</span>
            <span class="pl-sub">{{ t.plCliSub }}</span>
          </div>
          <div class="platform-card">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="4" stroke="#10B981" stroke-width="1.5"/><path d="M8 14l2.5-5L13 14M9 12h3" stroke="#10B981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 9v6" stroke="#10B981" stroke-width="1.5" stroke-linecap="round"/></svg>
            <span class="pl-name">{{ t.plVscode }}</span>
            <span class="pl-sub">{{ t.plVscodeSub }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         FAQ
    ══════════════════════════════════════ -->
    <section class="faq-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.faqTitle }}</h2>
        <div class="faq-list">
          <div
            v-for="(item, i) in t.faqItems"
            :key="i"
            class="faq-item"
            :class="{ 'faq-item--open': faqOpen === i }"
            @click="toggleFaq(i)"
          >
            <div class="faq-q">
              <span>{{ item.q }}</span>
              <svg class="faq-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="faq-a" v-show="faqOpen === i">
              <p>{{ item.a }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         FINAL CTA
    ══════════════════════════════════════ -->
    <section class="cta-section">
      <div class="cta-inner">
        <!-- Logo cube -->
        <svg width="56" height="49" viewBox="0 0 80 70" fill="none" class="cta-logo" aria-hidden="true">
          <path d="M 55,35 L 47.5,22 L 32.5,22 L 25,35 L 32.5,48 L 47.5,48 Z" fill="none"/>
          <path d="M 10,35 L 25,9 L 55,9 L 70,35 L 55,35 L 47.5,22 L 32.5,22 L 25,35 Z" fill="#8B5CF6"/>
          <path d="M 70,35 L 55,61 L 47.5,48 L 55,35 Z" fill="#4C1D95"/>
          <path d="M 10,35 L 25,35 L 32.5,48 L 25,61 Z" fill="#6D28D9"/>
          <path d="M 25,61 L 55,61 L 47.5,48 L 32.5,48 Z" fill="#5B21B6"/>
        </svg>
        <h2 class="cta-title">{{ t.ctaTitle }}</h2>
        <p class="cta-sub">{{ t.ctaSub }}</p>
        <div class="cta-btns">
          <a href="https://github.com/devlint/GitWand/releases" class="btn-primary btn-lg">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M8 1v10M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            {{ t.ctaDownload }}
          </a>
          <a href="https://github.com/devlint/GitWand" class="btn-ghost btn-lg" target="_blank" rel="noopener">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            GitHub
          </a>
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
/* ───────────────────────────────────────────
   Language toggle
─────────────────────────────────────────── */
.lang-toggle {
  position: fixed;
  top: 78px;
  right: 20px;
  z-index: 100;
  background: rgba(124, 58, 237, 0.15);
  border: 1px solid rgba(124, 58, 237, 0.35);
  color: #c4b5fd;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: all 0.2s ease;
}
.lang-toggle:hover {
  background: rgba(124, 58, 237, 0.3);
  color: #e9e5ff;
  border-color: rgba(124, 58, 237, 0.5);
}

/* ───────────────────────────────────────────
   Base
─────────────────────────────────────────── */
.gw-landing {
  --gw-purple:       #7C3AED;
  --gw-purple-light: #8B5CF6;
  --gw-purple-dark:  #5B21B6;
  --gw-green:        #10B981;
  --gw-green-dark:   #059669;
  --gw-bg:           #0c0c1a;
  --gw-bg-2:         #111120;
  --gw-bg-card:      #16162a;
  --gw-bg-card-2:    #1c1c32;
  --gw-border:       rgba(124,58,237,0.18);
  --gw-border-soft:  rgba(255,255,255,0.06);
  --gw-text:         #e2e8f0;
  --gw-text-muted:   #94a3b8;
  --gw-radius:       12px;

  width: 100%;
  background: var(--gw-bg);
  color: var(--gw-text);
  font-family: var(--vp-font-family-base, system-ui, sans-serif);
  overflow-x: hidden;
}

/* ───────────────────────────────────────────
   Shared helpers
─────────────────────────────────────────── */
.section-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 28px;
}
.section-title {
  font-size: clamp(24px, 4vw, 36px);
  font-weight: 700;
  text-align: center;
  color: var(--gw-text);
  margin: 0 0 12px;
}
.section-sub {
  text-align: center;
  color: var(--gw-text-muted);
  font-size: 16px;
  margin: 0 0 52px;
}
.gradient {
  background: linear-gradient(135deg, var(--gw-purple-light), var(--gw-green));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 20px;
  border: 1px solid var(--gw-border);
  font-size: 12px;
  color: var(--gw-purple-light);
  background: rgba(124,58,237,0.08);
  margin-bottom: 20px;
  letter-spacing: 0.02em;
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--gw-purple);
  color: #fff;
  border-radius: 8px;
  font-weight: 600;
  font-size: 15px;
  transition: background 0.15s, transform 0.1s;
  text-decoration: none;
}
.btn-primary:hover {
  background: var(--gw-purple-light);
  transform: translateY(-1px);
}
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: transparent;
  color: var(--gw-text);
  border: 1px solid var(--gw-border-soft);
  border-radius: 8px;
  font-weight: 500;
  font-size: 15px;
  transition: border-color 0.15s, color 0.15s, transform 0.1s;
  text-decoration: none;
}
.btn-ghost:hover {
  border-color: var(--gw-purple);
  color: var(--gw-purple-light);
  transform: translateY(-1px);
}
.btn-lg {
  padding: 14px 28px;
  font-size: 16px;
}

/* ───────────────────────────────────────────
   HERO
─────────────────────────────────────────── */
.hero {
  padding: 80px 0 60px;
  background: radial-gradient(ellipse 80% 60% at 60% -10%, rgba(124,58,237,0.18) 0%, transparent 70%),
              var(--gw-bg);
  border-bottom: 1px solid var(--gw-border-soft);
}
.hero-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 28px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 60px;
  align-items: center;
}
.hero-h1 {
  font-size: clamp(32px, 5vw, 52px);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0 0 20px;
  color: var(--gw-text);
}
.hero-sub {
  font-size: 17px;
  color: var(--gw-text-muted);
  line-height: 1.65;
  margin: 0 0 32px;
  max-width: 460px;
}
.hero-ctas {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.hero-platforms {
  font-size: 12px;
  color: var(--gw-text-muted);
  margin: 0;
  letter-spacing: 0.04em;
}

/* ── App window (hero) ── */
.app-window {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
  background: #12121f;
}
.win-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #1a1a2e;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  position: relative;
}
.win-bar-right {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.win-tab {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  color: #6c7086;
  cursor: default;
}
.win-tab--active {
  color: var(--gw-text);
  background: rgba(124,58,237,0.15);
}
.tl {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tl-r { background: #ff5f57; }
.tl-y { background: #febc2e; }
.tl-g { background: #28c840; }
.win-title {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: #6c7086;
  white-space: nowrap;
}
.win-body {
  display: flex;
  height: 300px;
}

/* ── Sidebar ── */
.win-sidebar {
  width: 175px;
  min-width: 175px;
  background: #12121f;
  border-right: 1px solid rgba(255,255,255,0.05);
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.win-sidebar--lg {
  width: 200px;
  min-width: 200px;
}
.sb-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 10px;
  font-weight: 700;
  color: #6c7086;
  letter-spacing: 0.06em;
}
.sb-count {
  font-size: 9px;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}
.sb-count--green { background: rgba(16,185,129,0.15); color: #10B981; }
.sb-count--red   { background: rgba(243,139,168,0.15); color: #f38ba8; }
.sb-count--yellow { background: rgba(249,226,175,0.15); color: #f9e2af; }
.sb-file {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 12px;
  font-size: 11px;
  color: #cdd6f4;
  cursor: default;
}
.sb-file--active { background: rgba(124,58,237,0.12); }
.sb-file--conflict { opacity: 0.9; }
.sb-badge {
  font-size: 9px;
  font-weight: 700;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}
.sb-added   { color: #a6e3a1; }
.sb-mod     { color: #f9e2af; }
.sb-conflict { color: #f38ba8; }
.sb-name {
  font-family: 'Courier New', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-commit {
  margin-top: auto;
  padding: 10px;
  border-top: 1px solid rgba(255,255,255,0.05);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sb-input {
  width: 100%;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  padding: 5px 8px;
  font-size: 10px;
  color: #94a3b8;
  outline: none;
}
.sb-btn {
  background: var(--gw-purple);
  color: #fff;
  border-radius: 5px;
  padding: 5px 0;
  font-size: 10px;
  font-weight: 600;
  cursor: default;
  text-align: center;
}

/* ── Diff viewer ── */
.win-diff {
  flex: 1;
  overflow: hidden;
  background: #0e0e1a;
  display: flex;
  flex-direction: column;
}
.win-diff--lg {
  flex: 1;
}
.diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  background: #12121f;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.diff-tabs {
  display: flex;
}
.diff-tab {
  font-size: 11px;
  padding: 8px 12px;
  color: #6c7086;
  border-bottom: 2px solid transparent;
  cursor: default;
}
.diff-tab--active {
  color: var(--gw-text);
  border-bottom-color: var(--gw-purple);
}
.diff-actions {
  display: flex;
  gap: 4px;
}
.diff-pill {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(124,58,237,0.15);
  color: var(--gw-purple-light);
  cursor: default;
}
.diff-pill--ghost {
  background: none;
  color: #6c7086;
}
.diff-lines {
  padding: 8px 0;
  overflow: hidden;
  flex: 1;
}
.dl {
  display: flex;
  font-family: 'Courier New', 'Fira Code', monospace;
  font-size: 10.5px;
  line-height: 1.7;
  white-space: nowrap;
}
.dl-n { color: #cdd6f4; }
.dl-a { color: #a6e3a1; background: rgba(166,227,161,0.07); }
.dl-d { color: #f38ba8; background: rgba(243,139,168,0.07); text-decoration: line-through; opacity: 0.7; }
.ln {
  width: 36px;
  text-align: right;
  padding-right: 12px;
  color: #45475a;
  flex-shrink: 0;
  user-select: none;
}
.dc { flex: 1; padding: 0 14px; }
.k  { color: #cba6f7; }
.s  { color: #a6e3a1; }
.fn { color: #89b4fa; }

/* ───────────────────────────────────────────
   STATS BAR
─────────────────────────────────────────── */
.stats-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 32px 28px;
  border-bottom: 1px solid var(--gw-border-soft);
  background: var(--gw-bg-2);
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0 48px;
}
.stat-n {
  font-size: 36px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--gw-purple-light), var(--gw-green));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  line-height: 1;
}
.stat-l {
  font-size: 12px;
  color: var(--gw-text-muted);
  text-align: center;
}
.stat-sep {
  width: 1px;
  height: 40px;
  background: var(--gw-border-soft);
}

/* ───────────────────────────────────────────
   FEATURES
─────────────────────────────────────────── */
.features {
  padding: 80px 0;
  background: var(--gw-bg);
}
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.feat-card {
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  padding: 28px;
  transition: border-color 0.2s, transform 0.15s;
}
.feat-card:hover {
  border-color: var(--gw-purple);
  transform: translateY(-2px);
}
.feat-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: rgba(124,58,237,0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.feat-card h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 10px;
  color: var(--gw-text);
}
.feat-card p {
  font-size: 13.5px;
  color: var(--gw-text-muted);
  line-height: 1.6;
  margin: 0;
}
.feat-card code {
  font-family: 'Courier New', monospace;
  background: rgba(124,58,237,0.12);
  color: var(--gw-purple-light);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}

/* ───────────────────────────────────────────
   CONFLICT RESOLUTION DEMO
─────────────────────────────────────────── */
.conflict-section {
  padding: 80px 0;
  background: var(--gw-bg-2);
  border-top: 1px solid var(--gw-border-soft);
  border-bottom: 1px solid var(--gw-border-soft);
}
.conflict-demo {
  display: flex;
  align-items: center;
  gap: 20px;
}
.conflict-panel {
  flex: 1;
  border-radius: var(--gw-radius);
  overflow: hidden;
  border: 1px solid var(--gw-border);
  background: #0e0e1a;
}
.conflict-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  font-size: 12px;
  font-weight: 600;
  background: #12121f;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  color: var(--gw-text-muted);
}
.conflict-panel-head--before { border-left: 3px solid #f38ba8; }
.conflict-panel-head--after  { border-left: 3px solid #10B981; }
.panel-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.panel-dot--red   { background: #f38ba8; }
.panel-dot--green { background: #10B981; }
.conflict-code {
  padding: 16px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.8;
}
.cc-line { padding: 1px 4px; border-radius: 3px; }
.cc-conflict { color: #6c7086; font-style: italic; }
.cc-ours     { color: #f38ba8; background: rgba(243,139,168,0.07); }
.cc-theirs   { color: #a6e3a1; background: rgba(166,227,161,0.07); }
.cc-resolved { color: #a6e3a1; background: rgba(166,227,161,0.07); }
.conflict-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  font-size: 11px;
  color: #10B981;
  background: rgba(16,185,129,0.08);
  border-top: 1px solid rgba(16,185,129,0.12);
}
.conflict-arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  color: var(--gw-purple-light);
  font-size: 11px;
  font-weight: 600;
}

/* ───────────────────────────────────────────
   APP PREVIEW
─────────────────────────────────────────── */
.preview-section {
  padding: 80px 0;
  background: var(--gw-bg);
}
.preview-window {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
  background: #12121f;
  margin-top: 8px;
}
.preview-window .win-body {
  height: 380px;
}

/* ───────────────────────────────────────────
   PLATFORMS
─────────────────────────────────────────── */
.platforms-section {
  padding: 80px 0;
  background: var(--gw-bg-2);
  border-top: 1px solid var(--gw-border-soft);
}
.platforms-grid {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
}
.platform-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 32px;
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  min-width: 140px;
  transition: border-color 0.15s, transform 0.1s;
}
.platform-card:hover {
  border-color: var(--gw-purple);
  transform: translateY(-2px);
}
.pl-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--gw-text);
}
.pl-sub {
  font-size: 11px;
  color: var(--gw-text-muted);
  text-align: center;
}

/* ───────────────────────────────────────────
   CTA FINAL
─────────────────────────────────────────── */
.cta-section {
  padding: 100px 0;
  background: radial-gradient(ellipse 70% 80% at 50% 100%, rgba(124,58,237,0.15) 0%, transparent 65%),
              var(--gw-bg);
  border-top: 1px solid var(--gw-border-soft);
}
.cta-inner {
  max-width: 600px;
  margin: 0 auto;
  padding: 0 28px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.cta-logo { opacity: 0.9; }
.cta-title {
  font-size: clamp(24px, 4vw, 36px);
  font-weight: 800;
  color: var(--gw-text);
  margin: 0;
  line-height: 1.2;
}
.cta-sub {
  font-size: 16px;
  color: var(--gw-text-muted);
  margin: 0;
}
.cta-btns {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 8px;
}

/* ───────────────────────────────────────────
   LLM / MCP SECTION
─────────────────────────────────────────── */
.llm-section {
  padding: 96px 0;
  background: linear-gradient(180deg, var(--gw-bg-2) 0%, var(--gw-bg) 100%);
  border-top: 1px solid var(--gw-border-soft);
  border-bottom: 1px solid var(--gw-border-soft);
}
.llm-section .section-sub {
  margin-bottom: 60px;
}
.llm-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 56px;
  align-items: start;
}
.llm-steps {
  display: flex;
  flex-direction: column;
}
.llm-step {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.llm-step-num {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(124,58,237,0.15);
  border: 1.5px solid rgba(124,58,237,0.4);
  color: var(--gw-purple-light);
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: 0;
}
.llm-step-num--ai {
  background: linear-gradient(135deg, rgba(124,58,237,0.25), rgba(16,185,129,0.2));
  border-color: rgba(16,185,129,0.5);
  color: #6ee7b7;
  font-size: 12px;
}
.llm-step-body {
  padding-top: 8px;
}
.llm-step-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--gw-text);
  margin: 0 0 6px;
}
.llm-step-desc {
  font-size: 14px;
  color: var(--gw-text-muted);
  line-height: 1.65;
  margin: 0;
}
.llm-connector {
  width: 1.5px;
  height: 32px;
  background: linear-gradient(180deg, rgba(124,58,237,0.4), rgba(124,58,237,0.15));
  margin: 6px 0 6px 19px;
}
.llm-code-card {
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  overflow: hidden;
}
.llm-code-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #1a1a2e;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.llm-code-title {
  font-size: 11px;
  color: #6c7086;
  margin-left: 6px;
}
.llm-code-block {
  margin: 0;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 13px;
  line-height: 1.7;
  color: var(--gw-text);
  background: transparent;
  border: none;
  overflow-x: auto;
}
.lc-k { color: #c4b5fd; }
.lc-s { color: #a6e3a1; }
.lc-p { color: #94a3b8; }
.llm-compat {
  padding: 16px 20px;
  border-top: 1px solid rgba(255,255,255,0.05);
}
.llm-compat-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--gw-text-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 10px;
}
.llm-compat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.llm-chip {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid var(--gw-border);
  color: var(--gw-purple-light);
  background: rgba(124,58,237,0.07);
}
.llm-docs-link {
  display: block;
  padding: 14px 20px;
  border-top: 1px solid rgba(255,255,255,0.05);
  font-size: 13px;
  font-weight: 600;
  color: var(--gw-purple-light);
  text-decoration: none;
  transition: color 0.15s;
}
.llm-docs-link:hover {
  color: var(--gw-green);
}

/* ───────────────────────────────────────────
   FAQ SECTION
─────────────────────────────────────────── */
.faq-section {
  padding: 96px 0;
  background: var(--gw-bg-2);
  border-top: 1px solid var(--gw-border-soft);
}
.faq-section .section-title {
  margin-bottom: 48px;
}
.faq-list {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.faq-item {
  border-bottom: 1px solid var(--gw-border-soft);
  cursor: pointer;
  transition: background 0.15s;
}
.faq-item:first-child {
  border-top: 1px solid var(--gw-border-soft);
}
.faq-item:hover .faq-q {
  color: var(--gw-text);
}
.faq-q {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--gw-text-muted);
  transition: color 0.15s;
  user-select: none;
}
.faq-item--open .faq-q {
  color: var(--gw-text);
}
.faq-chevron {
  flex-shrink: 0;
  color: var(--gw-purple-light);
  transition: transform 0.2s ease;
}
.faq-item--open .faq-chevron {
  transform: rotate(180deg);
}
.faq-a {
  padding: 0 4px 20px;
}
.faq-a p {
  margin: 0;
  font-size: 14px;
  color: var(--gw-text-muted);
  line-height: 1.75;
}

/* ───────────────────────────────────────────
   RESPONSIVE
─────────────────────────────────────────── */
@media (max-width: 900px) {
  .hero-inner {
    grid-template-columns: 1fr;
    gap: 40px;
  }
  .hero-visual { order: -1; }
  .features-grid { grid-template-columns: repeat(2, 1fr); }
  .stats-bar { flex-direction: column; gap: 24px; }
  .stat-sep { width: 60px; height: 1px; }
  .conflict-demo { flex-direction: column; }
  .conflict-arrow { flex-direction: row; }
  .llm-layout { grid-template-columns: 1fr; gap: 40px; }
}
@media (max-width: 600px) {
  .features-grid { grid-template-columns: 1fr; }
  .hero { padding: 60px 0 40px; }
  .platforms-grid { flex-direction: column; align-items: center; }
}
</style>
