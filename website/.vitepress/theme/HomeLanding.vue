<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

type Locale = 'en' | 'fr' | 'es' | 'pt-BR' | 'zh-CN'

// English is the canonical default for everyone — other languages are opt-in via the picker.
// The picker mirrors the 5 locales supported by the desktop app (apps/desktop/src/locales/).
const locale = ref<Locale>('en')
const faqOpen = ref<number | null>(null)
function toggleFaq(i: number) {
  faqOpen.value = faqOpen.value === i ? null : i
}

// ── Terminal demo (hero animation) ────────────────────────────────────────────
interface TermLine { text: string; type: 'cmd' | 'info' | 'ok' | 'warn' }
const termLines = ref<TermLine[]>([])
const termRunning = ref(false)

function runTerminalDemo() {
  if (termRunning.value) return
  termRunning.value = true
  termLines.value = []
  const steps: Array<{ delay: number } & TermLine> = [
    { delay: 0,    text: '$ gitwand resolve',                                                    type: 'cmd'  },
    { delay: 600,  text: 'Scanning 12 conflicted files…',                                        type: 'info' },
    { delay: 1100, text: '✓ package-lock.json    47/47  [same_change · certain]',                type: 'ok'   },
    { delay: 1500, text: '✓ src/config.ts         3/3   [one_side_change · certain]',            type: 'ok'   },
    { delay: 1900, text: '✓ tailwind.config.js    2/2   [non_overlapping · high]',               type: 'ok'   },
    { delay: 2300, text: '✓ README.md             5/5   [whitespace_only · high]',               type: 'ok'   },
    { delay: 2700, text: '○ src/auth.ts           1 hunk pending  [complex · review needed]',    type: 'warn' },
    { delay: 3100, text: '─────────────────────────────────────────────',                        type: 'info' },
    { delay: 3400, text: '57 hunks resolved · 1 left for you · 0 errors',                        type: 'cmd'  },
  ]
  steps.forEach(({ delay, text, type }) => {
    setTimeout(() => {
      termLines.value.push({ text, type })
      if (type === 'cmd' && termLines.value.length > 1) termRunning.value = false
    }, delay)
  })
}

// ── Feature tabs ──────────────────────────────────────────────────────────────
// "core" by default — first-time visitors land on workflow-essentials,
// the highlight banner above the tabs drives traffic to "new" for repeat visits.
type TabId = 'core' | 'power' | 'ai' | 'new'
const activeTab = ref<TabId>('core')

// Jump to "new" tab and smooth-scroll the features section into view —
// used by the "What's New" highlight banner CTA.
function jumpToNewTab(): void {
  activeTab.value = 'new'
  // Defer to next tick so the panel content has rendered before scrolling
  setTimeout(() => {
    if (typeof document === 'undefined') return
    document.querySelector('.features')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 0)
}

// ── 10 resolution patterns (technical — not localised) ────────────────────────
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

// Short labels keep the picker compact; `title` surfaces the full native name on hover.
const LOCALES: { code: Locale; label: string; title: string }[] = [
  { code: 'en',    label: 'EN', title: 'English' },
  { code: 'fr',    label: 'FR', title: 'Français' },
  { code: 'es',    label: 'ES', title: 'Español' },
  { code: 'pt-BR', label: 'PT', title: 'Português (Brasil)' },
  { code: 'zh-CN', label: '中',  title: '简体中文' },
]

function setLocale(code: Locale) {
  locale.value = code
}

// ── Smart download URL (OS detection) ─────────────────────────────────────
const LATEST = '2.14.0'
const RELEASES = 'https://github.com/devlint/GitWand/releases'

// SSR-safe: start with the generic releases page, then switch to the
// OS-specific direct download once the component mounts in the browser.
// A computed() won't work here because navigator.userAgent is not reactive —
// Vue would never re-evaluate it after SSR hydration.
const downloadUrl = ref(RELEASES)
onMounted(() => {
  const ua = navigator.userAgent
  if (/Mac|Macintosh/.test(ua))
    downloadUrl.value = `${RELEASES}/download/v${LATEST}/GitWand_${LATEST}_universal.dmg`
  else if (/Win|Windows/.test(ua))
    downloadUrl.value = `${RELEASES}/download/v${LATEST}/GitWand_${LATEST}_x64-setup.exe`
  else if (/Linux/.test(ua))
    downloadUrl.value = `${RELEASES}/download/v${LATEST}/git-wand_${LATEST}_amd64.AppImage`
  setTimeout(runTerminalDemo, 900)
})

const i18n: Record<Locale, any> = {
  fr: {
    badge: 'v2.14.0 · Open Source · MIT',
    heroH1a: 'Le client Git qui',
    heroH1b: 'résout les conflits pour vous.',
    heroSub: 'GitWand classifie chaque conflit de merge avec 10 patterns déterministes et un score de confiance par hunk. Les 95 % triviaux — résolus automatiquement. Les cas complexes — pour vous, avec traces complètes. Natif, gratuit, open source.',
    download: 'Télécharger',
    github: 'GitHub',
    whatsNew: 'Nouveautés v2.14',
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
    featResolveDesc: '10 patterns de résolution avec pattern registry (v1.4) et scoring de confiance. 95%+ des conflits triviaux résolus sans intervention.',
    featDiff: 'Diff visuel',
    featDiffDesc: 'Viewer de diff unifié avec coloration syntaxique, staging au niveau du hunk, et preview de merge.',
    featHistory: 'Historique & Graph',
    featHistoryDesc: 'Historique complet, graphe DAG interactif, blame de fichier, et recherche en langage naturel dans les commits.',
    featPR: 'Pull Requests intégrées',
    featPRDesc: 'Revue de PR GitHub directement dans l\'app. Commentaires, reviews, statuts CI et aperçu des conflits.',
    featUI: '3 interfaces',
    featUIDesc: 'App desktop (macOS/Linux/Windows), outil CLI gitwand resolve pour CI/CD, et extension VS Code.',
    featAIPR: 'AI code review & PR',
    featAIPRDesc: 'Titre et description de PR auto-générés, critique IA par hunk dans le panneau Review, suggestion de nom de branche depuis le diff.',
    featAIMerge: 'AI merge insight',
    featAIMergeDesc: 'Explication de conflit en langage naturel, résumé IA du risque avant rebase/merge, squash sémantique en rebase interactif.',
    featAIFlow: 'AI commit & history',
    featAIFlowDesc: 'Messages de commit et de stash générés, Absorb classé sémantiquement, blame contextuel et release notes depuis git log.',
    featImgDiff: 'Diff d\'images visuel',
    featImgDiffDesc: 'Comparez les PNG, JPG, WebP, GIF et SVG côte à côte, en overlay, en blink ou avec un slider. Fini « Binary file changed ».',
    featFolderTree: 'Diff en arbre de dossiers',
    featFolderTreeDesc: 'Bascule plat ↔ arbre dans la liste des fichiers avec totaux par dossier, filtrage au clic et sidebar redimensionnable persistée.',
    featWorktrees: 'Git Worktrees',
    featWorktreesDesc: 'Travaillez sur plusieurs branches simultanément sans stasher. Chaque worktree s\'ouvre comme un onglet. Créez-en depuis la liste des branches en un clic.',
    featSubmodules: 'Gestion des sous-modules',
    featSubmodulesDesc: 'Listez, initialisez et mettez à jour les sous-modules Git avec badges de statut. Ajoutez-en et ouvrez-les en onglet depuis le panneau.',
    featSplitCommit: 'Split de commit par hunks',
    featSplitCommitDesc: 'Découpez un commit en deux via sélection fichier-par-fichier et ligne-par-ligne. Protège contre les merge commits, préserve votre sélection au collapse/expand, supporte ajouts/suppressions/renommages.',
    featCommitCtx: 'Menu contextuel de commit',
    featCommitCtxDesc: '12 actions en un clic droit : checkout, reset (soft/mixed/hard), revert, nouvelle branche, tag, cherry-pick, vue sur le forge et copie SHA.',
    featTags: 'Gestionnaire de tags',
    featTagsDesc: 'Listez, créez, pushez et supprimez vos tags locaux et distants. Suggestion IA du prochain tag sémantique depuis l\'historique.',
    featTrailers: 'Trailers & Conventional Commits',
    featTrailersDesc: 'Ajoutez Signed-off-by et Reviewed-by en un clic. Choisissez le préfixe de commit (feat, fix, docs…) depuis un picker intégré.',
    featFileHistory: 'Historique de fichier avancé',
    featFileHistoryDesc: 'Recherche pickaxe (-S/-G) dans l\'historique d\'un fichier, blame par plage de lignes, et sélecteur d\'algorithme diff (histogram, patience, myers).',
    featForkWorkflow: 'Workflow fork & triangulaire',
    featForkWorkflowDesc: 'Badge "↑N fork" dans le bouton de sync pour les workflows fork : push remote ≠ upstream. Fini les push accidentels sur l\'origine.',
    featMcp: 'Serveur MCP',
    featMcpDesc: 'Exposez GitWand à Claude, Cursor, Windsurf et tout client MCP. Une commande : npx -y @gitwand/mcp. Publié avec provenance.',
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
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: 'Prêt à simplifier votre workflow Git ?',
    ctaSub: 'Gratuit, open source, et conçu pour les développeurs qui veulent aller vite.',
    ctaDownload: 'Télécharger GitWand',
    llmTitle: 'Vos agents IA dans la boucle',
    llmSub: 'Le serveur MCP de GitWand expose son moteur de conflits aux agents IA. GitWand résout le trivial — votre agent prend le relais pour les cas complexes.',
    llmBadge: 'MCP Server · Registre officiel · stdio · Sans clé API',
    llmStep1: 'Analyse',
    llmStep1Desc: 'L\'agent appelle gitwand_preview_merge pour évaluer le nombre de conflits, leur complexité, et le pourcentage que GitWand peut résoudre seul.',
    llmStep2: 'Auto-résolution',
    llmStep2Desc: 'GitWand résout instantanément les patterns triviaux (whitespace, one-side-change, same-change…) et retourne les hunks ambigus avec leur trace de classification.',
    llmStep3: 'Résolution IA',
    llmStep3Desc: 'Pour chaque conflit complexe, l\'agent dispose du contexte complet : contenu ours/theirs/base, trace de classification et scores de confiance.',
    llmCompat: 'Compatible avec',
    llmDocs: 'Voir la documentation MCP →',
    patternsTitle: '10 patterns. Déterministes. Auditables.',
    patternsSub: 'Chaque hunk passe par le classifieur. Chaque pattern a son profil de confiance et son résolveur automatique.',
    benchTitle: 'Des chiffres, pas des adjectifs.',
    benchSub: 'Performances mesurées sur puce M, dépôts types.',
    tabCore: 'Git de base', tabAI: 'IA', tabPower: 'Power user', tabNew: 'Nouveautés',
    featuresAria: 'Catégories de fonctionnalités',
    // 3 Pillars
    pillarsTitle: 'Trois piliers, une promesse',
    pillarsSub: 'Conflits auto-résolus, performance native, IA opt-in et auditable.',
    pillar1Title: 'Résolution auto de 95 % des conflits triviaux',
    pillar1Sub: '10 patterns déterministes. Score de confiance composite. Trace de décision pour chaque hunk.',
    pillar1Stat: '95 %',
    pillar1StatLabel: 'conflits triviaux résolus automatiquement',
    pillar1Cta: 'Voir le moteur →',
    pillar2Title: 'Tauri 2 + Rust. Natif, rapide, prévisible.',
    pillar2Sub: 'Panneaux lazy-load. Fast-path libgit2. Polling discipliné. Aucun overhead Electron.',
    pillar2Stat: '<1s',
    pillar2StatLabel: 'au démarrage à froid',
    pillar2Cta: 'Pourquoi natif →',
    pillar3Title: 'L\'IA prend le relais quand vous bloquez',
    pillar3Sub: 'Fallback LLM pour les hunks complexes. Serveur MCP pour les agents. Toujours opt-in, toujours audité.',
    pillar3Stat: 'Claude · OpenAI · Ollama',
    pillar3StatLabel: 'votre LLM, votre clé',
    pillar3Cta: 'Guide du fallback IA →',
    // Onglet Nouveautés (v2.9 → v2.13)
    featLaunchpad: 'Launchpad — dashboard cross-repo',
    featLaunchpadDesc: 'Agrège PRs, issues, WIP et activité d\'équipe sur tous les repos d\'un workspace. Pin, snooze, enrichissement Team lazy. ⌘L depuis n\'importe où.',
    featLlmFallback: 'Fallback LLM pour les hunks complexes',
    featLlmFallbackDesc: 'Résolution opt-in via Claude / OpenAI / Ollama / MCP. Validée par le même pipeline parse-tree que les patterns déterministes. Trace de décision et bouton reject inclus.',
    featForge: 'GitHub, GitLab & Bitbucket',
    featForgeDesc: 'Support PR natif sur les trois forges. Détection automatique du remote, choix du bon provider. Comptes gérés une seule fois dans les Réglages — sans re-authentification par repo.',
    featBranchMgmt: 'Branches : épinglage, archivage, identité',
    featBranchMgmtDesc: 'Épinglez vos branches les plus utilisées en haut de liste. Archivez les branchées mergées ou inactives. Identité par repo — email différent pour le perso et le pro.',
    featIdentities: 'Templates de commit & Conventional Commits',
    featIdentitiesDesc: 'Configurez des templates de commit par repo, chargés automatiquement à l\'ouverture. Choisissez un préfixe Conventional Commits (feat, fix, docs…) depuis un picker intégré.',
    featAISuggest: 'Suggestions de code IA inline',
    featAISuggestDesc: 'Sélectionnez un hunk dans le panneau Review, demandez une réécriture ciblée et acceptez la suggestion IA en un clic. Les presets de prompts ajoutent un contexte instantané.',
    // Encart Nouveautés
    newReleaseBadge: 'Nouveau dans la v2.13',
    newReleaseTitle: 'Revue de code IA, inline — directement dans votre diff PR',
    newReleaseSub: 'Sélectionnez un hunk dans le panneau Review, demandez une réécriture ciblée et acceptez en un clic. Les presets de prompts ajoutent un contexte instantané sur chaque feature IA.',
    newReleaseCta: 'Voir les nouveautés',
    faqTitle: 'Questions fréquentes',
    faqItems: [
      { q: 'GitWand est-il vraiment gratuit ?', a: 'Oui, GitWand est entièrement open source sous licence MIT. Vous pouvez l\'utiliser, le modifier et le redistribuer librement.' },
      { q: 'Comment fonctionne la résolution intelligente des conflits ?', a: 'GitWand analyse la sémantique du code avec 10 patterns de résolution (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orchestrés par un pattern registry (v1.4) et un scoring de confiance par hunk. Les conflits triviaux sont résolus automatiquement ; les cas complexes sont remontés avec une trace d\'explication complète.' },
      { q: 'Qu\'est-ce que le serveur MCP et pourquoi l\'utiliser ?', a: 'Le serveur MCP expose le moteur de GitWand aux agents IA — Claude Code, Cursor, Windsurf, et d\'autres. Il tourne en local via stdio, sans clé API ni accès réseau. GitWand gère 95%+ des conflits triviaux, l\'agent IA s\'occupe des cas ambigus avec tout le contexte nécessaire.' },
      { q: 'GitWand fonctionne-t-il avec n\'importe quel dépôt Git ?', a: 'Oui. GitWand fonctionne avec tous les dépôts Git locaux, quel que soit l\'hébergement (GitHub, GitLab, Bitbucket, Gitea…). La vue Pull Requests est pour l\'instant limitée à GitHub.' },
      { q: 'Quelle est la différence avec les autres clients Git ?', a: 'GitWand se distingue par son moteur de résolution intégré, son architecture native Tauri (pas d\'Electron), ses 3 interfaces cohérentes (desktop, CLI, VS Code), et son serveur MCP pour l\'intégration avec les agents IA.' },
      { q: 'Comment installer le serveur MCP ?', a: 'Avec Claude Code, une seule commande suffit : claude mcp add gitwand -- npx -y @gitwand/mcp. Pour Claude Desktop, Cursor ou Windsurf, ajoutez le bloc mcpServers à la config de votre client (voir la documentation). Le serveur est aussi listé sur le registre officiel MCP, donc les clients qui parcourent le registre le trouvent automatiquement.' },
    ],
    compareTitle: 'GitWand face à la concurrence',
    compareSub: 'Comparaison fonctionnalité par fonctionnalité avec les clients Git les plus populaires.',
  },
  en: {
    badge: 'v2.14.0 · Open Source · MIT',
    heroH1a: 'The Git client that',
    heroH1b: 'resolves conflicts for you.',
    heroSub: 'GitWand classifies every merge conflict using 10 deterministic patterns and per-hunk confidence scoring. The trivial 95% — auto-resolved. The complex — left for you with full traces. Native, free, open-source.',
    download: 'Download',
    github: 'GitHub',
    whatsNew: "What's new in v2.14",
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
    featResolveDesc: '10 resolution patterns with pattern registry (v1.4) and confidence scoring. 95%+ of trivial conflicts resolved without intervention.',
    featDiff: 'Visual diff',
    featDiffDesc: 'Unified diff viewer with syntax highlighting, hunk-level staging, and merge preview.',
    featHistory: 'History & Graph',
    featHistoryDesc: 'Full history, interactive DAG graph, file blame, and natural-language commit search.',
    featPR: 'Integrated Pull Requests',
    featPRDesc: 'Review GitHub PRs directly in the app. Comments, reviews, CI status, and conflict preview.',
    featUI: '3 interfaces',
    featUIDesc: 'Desktop app (macOS/Linux/Windows), gitwand resolve CLI for CI/CD, and VS Code extension.',
    featAIPR: 'AI code review & PR',
    featAIPRDesc: 'Auto-generated PR title and description, per-hunk AI critique in the Review panel, branch-name suggestions from the diff.',
    featAIMerge: 'AI merge insight',
    featAIMergeDesc: 'Plain-English conflict explanation, AI risk summary before rebase/merge, semantic squash in interactive rebase.',
    featAIFlow: 'AI commit & history',
    featAIFlowDesc: 'Generated commit and stash messages, semantically-ranked Absorb, blame context and release notes from git log.',
    featImgDiff: 'Visual image diffs',
    featImgDiffDesc: 'Compare PNG, JPG, WebP, GIF, and SVG changes side-by-side, overlayed, blinked, or with a reveal slider. No more "Binary file changed".',
    featFolderTree: 'Folder tree diff',
    featFolderTreeDesc: 'Flat ↔ tree toggle in the commit file list with per-folder aggregates, click-to-filter, and a resizable sidebar that remembers its width.',
    featWorktrees: 'Git Worktrees',
    featWorktreesDesc: 'Work on multiple branches simultaneously without stashing. Each worktree opens as a tab. Create one from the branch list with one click.',
    featSubmodules: 'Submodule management',
    featSubmodulesDesc: 'List, initialize, and update Git submodules with status badges. Add submodules and open them as tabs directly from the panel.',
    featSplitCommit: 'Split a commit by hunks',
    featSplitCommitDesc: 'Break a commit in two by picking files and lines. Blocks merge commits, preserves your selection across collapse/expand, and handles added/deleted/renamed files.',
    featCommitCtx: 'Commit context menu',
    featCommitCtxDesc: '12 actions on right-click: checkout, reset (soft/mixed/hard), revert, new branch, tag, cherry-pick, view on forge, and copy SHA.',
    featTags: 'Tags manager',
    featTagsDesc: 'List, create, push, and delete local and remote tags. AI-powered suggestion for the next semantic version from your commit history.',
    featTrailers: 'Trailers & Conventional Commits',
    featTrailersDesc: 'Add Signed-off-by and Reviewed-by in one click. Pick a commit prefix (feat, fix, docs…) from a built-in chip picker.',
    featFileHistory: 'Advanced file history',
    featFileHistoryDesc: 'Pickaxe search (-S/-G) in file history, blame by line range, and diff algorithm selector (histogram, patience, myers).',
    featForkWorkflow: 'Fork & triangular workflow',
    featForkWorkflowDesc: '"↑N fork" badge in the sync button for fork workflows where push remote ≠ upstream. No more accidental pushes to origin.',
    featMcp: 'MCP server',
    featMcpDesc: 'Expose GitWand to Claude, Cursor, Windsurf, and any MCP client. One command: npx -y @gitwand/mcp. Published with provenance.',
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
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: 'Ready to simplify your Git workflow?',
    ctaSub: 'Free, open source, and built for developers who want to move fast.',
    ctaDownload: 'Download GitWand',
    llmTitle: 'Your AI agents in the loop',
    llmSub: 'GitWand\'s MCP server exposes its conflict engine to AI agents. GitWand resolves the trivial — your agent takes over for the complex cases.',
    llmBadge: 'MCP Server · Official Registry · stdio · No API key',
    llmStep1: 'Preview',
    llmStep1Desc: 'The agent calls gitwand_preview_merge to assess the number of conflicts, their complexity, and the percentage GitWand can resolve on its own.',
    llmStep2: 'Auto-resolve',
    llmStep2Desc: 'GitWand instantly resolves trivial patterns (whitespace, one-side-change, same-change…) and returns ambiguous hunks with their classification trace.',
    llmStep3: 'AI resolution',
    llmStep3Desc: 'For each complex conflict, the agent has full context: ours/theirs/base content, classification trace, and confidence scores.',
    llmCompat: 'Compatible with',
    llmDocs: 'View MCP documentation →',
    patternsTitle: '10 patterns. Deterministic. Auditable.',
    patternsSub: 'Every hunk runs through the classifier. Each pattern has its own confidence profile and automatic resolver.',
    benchTitle: 'Numbers, not adjectives.',
    benchSub: 'Performance measured on an M-series chip with typical repositories.',
    tabCore: 'Core Git', tabAI: 'AI', tabPower: 'Power user', tabNew: "What's New",
    featuresAria: 'Feature categories',
    // 3 Pillars
    pillarsTitle: 'Three pillars, one promise',
    pillarsSub: 'Auto-resolved conflicts, native performance, opt-in and auditable AI.',
    pillar1Title: 'Auto-resolve 95% of trivial conflicts',
    pillar1Sub: '10 deterministic patterns. Composite confidence scoring. Decision traces for every hunk.',
    pillar1Stat: '95%',
    pillar1StatLabel: 'trivial conflicts auto-resolved',
    pillar1Cta: 'See the engine →',
    pillar2Title: 'Tauri 2 + Rust. Native, fast, predictable.',
    pillar2Sub: 'Lazy-loaded panels. libgit2 fast-path. Polling discipline. No Electron bloat.',
    pillar2Stat: '<1s',
    pillar2StatLabel: 'cold start',
    pillar2Cta: 'Why native →',
    pillar3Title: 'AI assists where humans get stuck',
    pillar3Sub: 'LLM fallback for complex hunks. MCP server for agents. Always opt-in, always audited.',
    pillar3Stat: 'Claude · OpenAI · Ollama',
    pillar3StatLabel: 'your LLM, your key',
    pillar3Cta: 'AI fallback guide →',
    // What's New tab (v2.9 → v2.13)
    featLaunchpad: 'Launchpad — cross-repo dashboard',
    featLaunchpadDesc: 'Aggregate PRs, issues, WIP, and team activity across every repo in a workspace. Pin, snooze, lazy team enrichment. ⌘L from anywhere.',
    featLlmFallback: 'LLM fallback for complex hunks',
    featLlmFallbackDesc: 'Opt-in resolution via Claude / OpenAI / Ollama / MCP. Validated through the same parse-tree pipeline as deterministic patterns. Decision trace and reject button included.',
    featForge: 'GitHub, GitLab & Bitbucket',
    featForgeDesc: 'Native PR support across all three forges. Auto-detects your remote and picks the right provider. Accounts managed once in Settings — no re-authentication per repo.',
    featBranchMgmt: 'Branch management: pin, archive, identity',
    featBranchMgmtDesc: 'Pin your most-used branches to the top. Archive merged or inactive ones with a configurable threshold. Per-repo committer identity — different email for work and personal repos.',
    featIdentities: 'Commit templates & Conventional Commits',
    featIdentitiesDesc: 'Configure per-repo commit templates loaded automatically on open. Pick a Conventional Commits prefix (feat, fix, docs…) from an inline chip picker.',
    featAISuggest: 'AI inline code suggestions',
    featAISuggestDesc: 'Select any hunk in the PR Review panel, request a targeted rewrite, and accept the AI suggestion in one click. Prompt presets add instant context across every AI feature.',
    // Highlight banner
    newReleaseBadge: 'New in v2.13',
    newReleaseTitle: 'AI code review, inline — right in your PR diff',
    newReleaseSub: 'Select a hunk in the Review panel, request a targeted rewrite, and accept in one click. Prompt presets add instant context across every AI feature.',
    newReleaseCta: 'See what\'s new',
    faqTitle: 'Frequently asked questions',
    faqItems: [
      { q: 'Is GitWand really free?', a: 'Yes, GitWand is fully open source under the MIT license. You can use, modify, and redistribute it freely.' },
      { q: 'How does smart conflict resolution work?', a: 'GitWand analyzes code semantics using 10 resolution patterns (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orchestrated by a pattern registry (v1.4) with per-hunk confidence scoring. Trivial conflicts are resolved automatically; complex cases are surfaced with a full explanation trace.' },
      { q: 'What is the MCP server and why use it?', a: 'The MCP server exposes GitWand\'s engine to AI agents — Claude Code, Cursor, Windsurf, and others. It runs locally over stdio, with no API key or network access required. GitWand handles 95%+ of trivial conflicts; the AI agent tackles the ambiguous ones with full context.' },
      { q: 'Does GitWand work with any Git repository?', a: 'Yes. GitWand works with any local Git repository, regardless of hosting (GitHub, GitLab, Bitbucket, Gitea…). The Pull Request view is currently limited to GitHub.' },
      { q: 'What sets GitWand apart from other Git clients?', a: 'GitWand stands out with its built-in resolution engine, native Tauri architecture (no Electron), three consistent interfaces (desktop, CLI, VS Code), and an MCP server for AI agent integration.' },
      { q: 'How do I install the MCP server?', a: 'With Claude Code, a single command is enough: claude mcp add gitwand -- npx -y @gitwand/mcp. For Claude Desktop, Cursor, or Windsurf, add the mcpServers block to your client config (see the docs). The server is also listed on the official MCP Registry, so clients that browse the registry discover it automatically.' },
    ],
    compareTitle: 'How does GitWand compare?',
    compareSub: 'Feature-by-feature breakdown against the most popular Git clients on the market.',
  },
  es: {
    badge: 'v2.14.0 · Open Source · MIT',
    heroH1a: 'El cliente Git que',
    heroH1b: 'resuelve conflictos por ti.',
    heroSub: 'GitWand clasifica cada conflicto de merge con 10 patrones deterministas y puntuación de confianza por hunk. El 95 % trivial — resuelto automáticamente. Lo complejo — para ti, con trazas completas. Nativo, gratuito, open source.',
    download: 'Descargar',
    github: 'GitHub',
    whatsNew: 'Novedades v2.14',
    docs: 'Documentación →',
    platforms: 'macOS · Linux · Windows',
    statPatterns: 'patrones de resolución',
    statResolved: 'conflictos resueltos automáticamente',
    statInterfaces: 'interfaces (Escritorio, CLI, VS Code)',
    featTitle: 'Todo lo que necesitas para Git',
    featSub: 'Un flujo de trabajo completo, sin compromisos de rendimiento.',
    featPerf: 'Rendimiento nativo',
    featPerfDesc: 'Construido con Tauri 2 y Vue 3. Arranque en menos de un segundo. Cero sobrecarga de Electron.',
    featResolve: 'Resolución inteligente',
    featResolveDesc: '10 patrones de resolución con registro de patrones (v1.4) y puntuación de confianza. Más del 95 % de los conflictos triviales resueltos sin intervención.',
    featDiff: 'Diff visual',
    featDiffDesc: 'Visor de diff unificado con resaltado de sintaxis, staging por hunk y vista previa de merge.',
    featHistory: 'Historial y grafo',
    featHistoryDesc: 'Historial completo, grafo DAG interactivo, blame de archivos y búsqueda en lenguaje natural en los commits.',
    featPR: 'Pull Requests integradas',
    featPRDesc: 'Revisa los PR de GitHub directamente en la app. Comentarios, revisiones, estado de CI y vista previa de conflictos.',
    featUI: '3 interfaces',
    featUIDesc: 'App de escritorio (macOS/Linux/Windows), CLI gitwand resolve para CI/CD y extensión de VS Code.',
    featAIPR: 'Revisión de código y PR con IA',
    featAIPRDesc: 'Título y descripción de PR generados automáticamente, crítica IA por hunk en el panel Review y sugerencias de nombre de rama a partir del diff.',
    featAIMerge: 'Insight de merge con IA',
    featAIMergeDesc: 'Explicación de conflictos en lenguaje natural, resumen de riesgo por IA antes de rebase/merge y squash semántico en rebase interactivo.',
    featAIFlow: 'Commits e historial con IA',
    featAIFlowDesc: 'Mensajes de commit y stash generados, Absorb ordenado semánticamente, contexto de blame y release notes a partir de git log.',
    featImgDiff: 'Diff visual de imágenes',
    featImgDiffDesc: 'Compara cambios en PNG, JPG, WebP, GIF y SVG lado a lado, superpuestos, parpadeando o con un slider. Se acabó el «Binary file changed».',
    featFolderTree: 'Diff en árbol de carpetas',
    featFolderTreeDesc: 'Alterna plano ↔ árbol en la lista de archivos del commit, con totales por carpeta, filtrado al clic y barra lateral redimensionable persistida.',
    featWorktrees: 'Git Worktrees',
    featWorktreesDesc: 'Trabaja en varias ramas simultáneamente sin hacer stash. Cada worktree se abre como pestaña. Créalo desde la lista de ramas con un clic.',
    featSubmodules: 'Gestión de submódulos',
    featSubmodulesDesc: 'Lista, inicializa y actualiza submódulos Git con insignias de estado. Añade submódulos y ábrelos como pestañas desde el panel.',
    featSplitCommit: 'Dividir un commit por hunks',
    featSplitCommitDesc: 'Divide un commit en dos seleccionando archivos y líneas. Bloquea commits de merge, conserva tu selección al contraer/expandir y soporta archivos añadidos, eliminados o renombrados.',
    featCommitCtx: 'Menú contextual de commit',
    featCommitCtxDesc: '12 acciones con clic derecho: checkout, reset, revert, nueva rama, tag, cherry-pick, ver en forge y copiar SHA.',
    featTags: 'Gestión de tags',
    featTagsDesc: 'Lista, crea, envía y elimina tags locales y remotos. Sugerencia IA del próximo tag semántico.',
    featTrailers: 'Trailers & Conventional Commits',
    featTrailersDesc: 'Añade Signed-off-by y Reviewed-by con un clic. Selector de prefijo de commit (feat, fix, docs…).',
    featFileHistory: 'Historial de archivo avanzado',
    featFileHistoryDesc: 'Búsqueda pickaxe (-S/-G), blame por rango de líneas y selector de algoritmo diff.',
    featForkWorkflow: 'Workflow fork & triangular',
    featForkWorkflowDesc: 'Badge "↑N fork" en el botón de sync para workflows donde push remote ≠ upstream.',
    featMcp: 'Servidor MCP',
    featMcpDesc: 'Expón GitWand a Claude, Cursor, Windsurf y cualquier cliente MCP. Un comando: npx -y @gitwand/mcp. Publicado con attestations de procedencia.',
    conflictTitle: 'Conflictos de merge, resueltos automáticamente',
    conflictSub: 'GitWand analiza la semántica del código, no solo las líneas. Elige la resolución correcta por ti.',
    conflictBefore: 'Antes — conflicto en bruto',
    conflictAfter: 'Después — resuelto automáticamente',
    conflictBadge: 'Confianza 97 % · prefer-theirs · semántico',
    previewTitle: 'Un cliente Git que te va a encantar',
    previewSub: 'Interfaz limpia, tema oscuro, todas las funciones de Git en un mismo lugar.',
    platformsTitle: 'Disponible en todas partes',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Instalador .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Marketplace de extensiones',
    ctaTitle: '¿Listo para simplificar tu flujo Git?',
    ctaSub: 'Gratis, open source y hecho para desarrolladores que quieren ir rápido.',
    ctaDownload: 'Descargar GitWand',
    llmTitle: 'Tus agentes IA en el bucle',
    llmSub: 'El servidor MCP de GitWand expone su motor de conflictos a los agentes IA. GitWand resuelve lo trivial — tu agente toma el relevo en los casos complejos.',
    llmBadge: 'Servidor MCP · Registro oficial · stdio · Sin clave API',
    llmStep1: 'Análisis',
    llmStep1Desc: 'El agente llama a gitwand_preview_merge para evaluar el número de conflictos, su complejidad y el porcentaje que GitWand puede resolver por sí solo.',
    llmStep2: 'Auto-resolución',
    llmStep2Desc: 'GitWand resuelve al instante los patrones triviales (whitespace, one-side-change, same-change…) y devuelve los hunks ambiguos con su traza de clasificación.',
    llmStep3: 'Resolución con IA',
    llmStep3Desc: 'Para cada conflicto complejo, el agente dispone del contexto completo: contenido ours/theirs/base, traza de clasificación y puntuaciones de confianza.',
    llmCompat: 'Compatible con',
    llmDocs: 'Ver la documentación de MCP →',
    patternsTitle: '10 patrones. Deterministas. Auditables.',
    patternsSub: 'Cada hunk pasa por el clasificador. Cada patrón tiene su perfil de confianza y resolución automática.',
    benchTitle: 'Números, no adjetivos.',
    benchSub: 'Rendimiento medido en chip M con repositorios típicos.',
    tabCore: 'Git básico', tabAI: 'IA', tabPower: 'Power user', tabNew: 'Novedades',
    featuresAria: 'Categorías de funcionalidades',
    // 3 Pillars
    pillarsTitle: 'Tres pilares, una promesa',
    pillarsSub: 'Conflictos auto-resueltos, rendimiento nativo, IA opt-in y auditable.',
    pillar1Title: 'Resuelve automáticamente el 95 % de los conflictos triviales',
    pillar1Sub: '10 patrones deterministas. Puntuación de confianza compuesta. Traza de decisión para cada hunk.',
    pillar1Stat: '95 %',
    pillar1StatLabel: 'conflictos triviales resueltos automáticamente',
    pillar1Cta: 'Ver el motor →',
    pillar2Title: 'Tauri 2 + Rust. Nativo, rápido, predecible.',
    pillar2Sub: 'Paneles con lazy-load. Fast-path libgit2. Polling disciplinado. Sin sobrecarga de Electron.',
    pillar2Stat: '<1s',
    pillar2StatLabel: 'arranque en frío',
    pillar2Cta: 'Por qué nativo →',
    pillar3Title: 'La IA toma el relevo cuando te atascas',
    pillar3Sub: 'Fallback LLM para hunks complejos. Servidor MCP para agentes. Siempre opt-in, siempre auditado.',
    pillar3Stat: 'Claude · OpenAI · Ollama',
    pillar3StatLabel: 'tu LLM, tu clave',
    pillar3Cta: 'Guía del fallback IA →',
    // Pestaña Novedades (v2.9 → v2.13)
    featLaunchpad: 'Launchpad — dashboard multi-repo',
    featLaunchpadDesc: 'Agrega PRs, issues, WIP y actividad del equipo en todos los repos de un workspace. Pin, snooze, enriquecimiento Team lazy. ⌘L desde cualquier lugar.',
    featLlmFallback: 'Fallback LLM para hunks complejos',
    featLlmFallbackDesc: 'Resolución opt-in vía Claude / OpenAI / Ollama / MCP. Validada por el mismo pipeline parse-tree que los patrones deterministas. Traza de decisión y botón reject incluidos.',
    featForge: 'GitHub, GitLab y Bitbucket',
    featForgeDesc: 'Soporte PR nativo en los tres forges. Detección automática del remote y elección del proveedor correcto. Cuentas gestionadas una sola vez en Ajustes — sin reautenticación por repo.',
    featBranchMgmt: 'Ramas: ancladas, archivadas, identidad',
    featBranchMgmtDesc: 'Fija tus ramas más usadas en la parte superior. Archiva las mergeadas o inactivas con un umbral configurable. Identidad por repo — email distinto para personal y trabajo.',
    featIdentities: 'Templates de commit & Conventional Commits',
    featIdentitiesDesc: 'Configura templates de commit por repo, cargados automáticamente al abrir. Elige un prefijo de Conventional Commits (feat, fix, docs…) desde un selector integrado.',
    featAISuggest: 'Sugerencias de código IA inline',
    featAISuggestDesc: 'Selecciona cualquier hunk en el panel Review, pide una reescritura enfocada y acepta la sugerencia IA con un clic. Los presets de prompts añaden contexto instantáneo.',
    // Encabezado Novedades
    newReleaseBadge: 'Nuevo en v2.13',
    newReleaseTitle: 'Revisión de código IA, inline — directamente en tu diff PR',
    newReleaseSub: 'Selecciona un hunk en el panel Review, pide una reescritura enfocada y acepta con un clic. Los presets de prompts añaden contexto instantáneo en cada función IA.',
    newReleaseCta: 'Ver las novedades',
    faqTitle: 'Preguntas frecuentes',
    faqItems: [
      { q: '¿GitWand es realmente gratis?', a: 'Sí, GitWand es totalmente open source bajo licencia MIT. Puedes usarlo, modificarlo y redistribuirlo libremente.' },
      { q: '¿Cómo funciona la resolución inteligente de conflictos?', a: 'GitWand analiza la semántica del código con 10 patrones de resolución (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orquestados por un pattern registry (v1.4) y una puntuación de confianza por hunk. Los conflictos triviales se resuelven automáticamente; los casos complejos se presentan con una traza de explicación completa.' },
      { q: '¿Qué es el servidor MCP y por qué usarlo?', a: 'El servidor MCP expone el motor de GitWand a los agentes IA — Claude Code, Cursor, Windsurf y otros. Funciona en local vía stdio, sin clave API ni acceso a la red. GitWand gestiona el 95 %+ de los conflictos triviales; el agente IA se ocupa de los casos ambiguos con todo el contexto necesario.' },
      { q: '¿GitWand funciona con cualquier repositorio Git?', a: 'Sí. GitWand funciona con cualquier repositorio Git local, sea cual sea el hosting (GitHub, GitLab, Bitbucket, Gitea…). La vista de Pull Requests está limitada a GitHub por ahora.' },
      { q: '¿Qué lo diferencia de otros clientes Git?', a: 'GitWand destaca por su motor de resolución integrado, su arquitectura nativa Tauri (sin Electron), sus 3 interfaces coherentes (escritorio, CLI, VS Code) y su servidor MCP para la integración con agentes IA.' },
      { q: '¿Cómo se instala el servidor MCP?', a: 'Con Claude Code basta un solo comando: claude mcp add gitwand -- npx -y @gitwand/mcp. Para Claude Desktop, Cursor o Windsurf, añade el bloque mcpServers a la configuración de tu cliente (ver la documentación). El servidor también está listado en el registro oficial MCP, así que los clientes que exploran el registro lo encuentran automáticamente.' },
    ],
    compareTitle: 'GitWand frente a la competencia',
    compareSub: 'Comparativa función a función con los clientes Git más populares del mercado.',
  },
  'pt-BR': {
    badge: 'v2.14.0 · Open Source · MIT',
    heroH1a: 'O cliente Git que',
    heroH1b: 'resolve conflitos por você.',
    heroSub: 'GitWand classifica cada conflito de merge com 10 padrões deterministas e pontuação de confiança por hunk. Os 95 % triviais — resolvidos automaticamente. Os complexos — para você, com traces completos. Nativo, gratuito, open source.',
    download: 'Baixar',
    github: 'GitHub',
    whatsNew: 'Novidades v2.14',
    docs: 'Documentação →',
    platforms: 'macOS · Linux · Windows',
    statPatterns: 'padrões de resolução',
    statResolved: 'conflitos resolvidos automaticamente',
    statInterfaces: 'interfaces (Desktop, CLI, VS Code)',
    featTitle: 'Tudo que você precisa para Git',
    featSub: 'Um fluxo completo, sem abrir mão do desempenho.',
    featPerf: 'Desempenho nativo',
    featPerfDesc: 'Construído com Tauri 2 e Vue 3. Inicialização em menos de um segundo. Zero overhead do Electron.',
    featResolve: 'Resolução inteligente',
    featResolveDesc: '10 padrões de resolução com pattern registry (v1.4) e pontuação de confiança. 95 %+ dos conflitos triviais resolvidos sem intervenção.',
    featDiff: 'Diff visual',
    featDiffDesc: 'Visualizador de diff unificado com syntax highlighting, staging por hunk e preview de merge.',
    featHistory: 'Histórico e grafo',
    featHistoryDesc: 'Histórico completo, grafo DAG interativo, blame de arquivo e busca em linguagem natural nos commits.',
    featPR: 'Pull Requests integradas',
    featPRDesc: 'Revise PRs do GitHub direto no app. Comentários, reviews, status de CI e preview de conflitos.',
    featUI: '3 interfaces',
    featUIDesc: 'App desktop (macOS/Linux/Windows), CLI gitwand resolve para CI/CD e extensão VS Code.',
    featAIPR: 'Code review e PR com IA',
    featAIPRDesc: 'Título e descrição de PR gerados automaticamente, crítica IA por hunk no painel Review e sugestão de nome de branch a partir do diff.',
    featAIMerge: 'Insight de merge com IA',
    featAIMergeDesc: 'Explicação de conflito em linguagem natural, resumo de risco por IA antes de rebase/merge e squash semântico no rebase interativo.',
    featAIFlow: 'Commits e histórico com IA',
    featAIFlowDesc: 'Mensagens de commit e stash geradas, Absorb ordenado semanticamente, contexto de blame e release notes a partir do git log.',
    featImgDiff: 'Diff visual de imagens',
    featImgDiffDesc: 'Compare mudanças em PNG, JPG, WebP, GIF e SVG lado a lado, sobrepostas, piscando ou com um slider. Chega de «Binary file changed».',
    featFolderTree: 'Diff em árvore de pastas',
    featFolderTreeDesc: 'Alterne plano ↔ árvore na lista de arquivos do commit, com totais por pasta, filtro ao clicar e sidebar redimensionável persistida.',
    featWorktrees: 'Git Worktrees',
    featWorktreesDesc: 'Trabalhe em várias branches simultaneamente sem fazer stash. Cada worktree abre como aba. Crie a partir da lista de branches com um clique.',
    featSubmodules: 'Gerenciamento de submódulos',
    featSubmodulesDesc: 'Liste, inicialize e atualize submódulos Git com badges de status. Adicione submódulos e abra-os como abas diretamente do painel.',
    featSplitCommit: 'Dividir commit por hunks',
    featSplitCommitDesc: 'Divida um commit em dois selecionando arquivos e linhas. Bloqueia merge commits, preserva sua seleção ao colapsar/expandir e suporta arquivos adicionados, excluídos ou renomeados.',
    featCommitCtx: 'Menu contextual de commit',
    featCommitCtxDesc: '12 ações com clique direito: checkout, reset, revert, nova branch, tag, cherry-pick, ver no forge e copiar SHA.',
    featTags: 'Gerenciador de tags',
    featTagsDesc: 'Liste, crie, envie e exclua tags locais e remotas. Sugestão de IA para o próximo tag semântico.',
    featTrailers: 'Trailers & Conventional Commits',
    featTrailersDesc: 'Adicione Signed-off-by e Reviewed-by com um clique. Seletor de prefixo (feat, fix, docs…).',
    featFileHistory: 'Histórico de arquivo avançado',
    featFileHistoryDesc: 'Busca pickaxe (-S/-G), blame por intervalo de linhas e seletor de algoritmo diff.',
    featForkWorkflow: 'Workflow fork & triangular',
    featForkWorkflowDesc: 'Badge "↑N fork" no botão de sync para workflows onde push remote ≠ upstream.',
    featMcp: 'Servidor MCP',
    featMcpDesc: 'Exponha o GitWand ao Claude, Cursor, Windsurf e qualquer cliente MCP. Um comando: npx -y @gitwand/mcp. Publicado com atestados de proveniência.',
    conflictTitle: 'Conflitos de merge, resolvidos automaticamente',
    conflictSub: 'GitWand analisa a semântica do código, não apenas as linhas. Ele escolhe a resolução certa por você.',
    conflictBefore: 'Antes — conflito bruto',
    conflictAfter: 'Depois — resolvido automaticamente',
    conflictBadge: 'Confiança 97 % · prefer-theirs · semântico',
    previewTitle: 'Um cliente Git que você vai amar',
    previewSub: 'Interface limpa, tema escuro, todos os recursos do Git no mesmo lugar.',
    platformsTitle: 'Disponível em todo lugar',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Instalador .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: 'Pronto para simplificar seu fluxo Git?',
    ctaSub: 'Gratuito, open source, feito para devs que querem ir rápido.',
    ctaDownload: 'Baixar o GitWand',
    llmTitle: 'Seus agentes de IA no loop',
    llmSub: 'O servidor MCP do GitWand expõe o motor de conflitos aos agentes de IA. O GitWand resolve o trivial — seu agente assume os casos complexos.',
    llmBadge: 'Servidor MCP · Registro oficial · stdio · Sem chave de API',
    llmStep1: 'Análise',
    llmStep1Desc: 'O agente chama gitwand_preview_merge para avaliar o número de conflitos, a complexidade e o percentual que o GitWand consegue resolver sozinho.',
    llmStep2: 'Auto-resolução',
    llmStep2Desc: 'O GitWand resolve instantaneamente os padrões triviais (whitespace, one-side-change, same-change…) e devolve os hunks ambíguos com o trace de classificação.',
    llmStep3: 'Resolução com IA',
    llmStep3Desc: 'Para cada conflito complexo, o agente tem o contexto completo: conteúdo ours/theirs/base, trace de classificação e scores de confiança.',
    llmCompat: 'Compatível com',
    llmDocs: 'Ver a documentação do MCP →',
    patternsTitle: '10 padrões. Deterministas. Auditáveis.',
    patternsSub: 'Cada hunk passa pelo classificador. Cada padrão tem seu perfil de confiança e resolução automática.',
    benchTitle: 'Números, não adjetivos.',
    benchSub: 'Performance medida em chip M com repositórios típicos.',
    tabCore: 'Git básico', tabAI: 'IA', tabPower: 'Power user', tabNew: 'Novidades',
    featuresAria: 'Categorias de funcionalidades',
    // 3 Pillars
    pillarsTitle: 'Três pilares, uma promessa',
    pillarsSub: 'Conflitos auto-resolvidos, desempenho nativo, IA opt-in e auditável.',
    pillar1Title: 'Resolva 95% dos conflitos triviais automaticamente',
    pillar1Sub: '10 padrões deterministas. Score de confiança composto. Trace de decisão em cada hunk.',
    pillar1Stat: '95%',
    pillar1StatLabel: 'conflitos triviais resolvidos automaticamente',
    pillar1Cta: 'Ver o motor →',
    pillar2Title: 'Tauri 2 + Rust. Nativo, rápido, previsível.',
    pillar2Sub: 'Painéis lazy-load. Fast-path libgit2. Polling disciplinado. Zero overhead do Electron.',
    pillar2Stat: '<1s',
    pillar2StatLabel: 'inicialização a frio',
    pillar2Cta: 'Por que nativo →',
    pillar3Title: 'A IA assume quando você empaca',
    pillar3Sub: 'Fallback LLM para hunks complexos. Servidor MCP para agentes. Sempre opt-in, sempre auditado.',
    pillar3Stat: 'Claude · OpenAI · Ollama',
    pillar3StatLabel: 'seu LLM, sua chave',
    pillar3Cta: 'Guia do fallback IA →',
    // Aba Novidades (v2.9 → v2.13)
    featLaunchpad: 'Launchpad — dashboard cross-repo',
    featLaunchpadDesc: 'Agrega PRs, issues, WIP e atividade da equipe em todos os repos de um workspace. Pin, snooze, enriquecimento Team lazy. ⌘L de qualquer lugar.',
    featLlmFallback: 'Fallback LLM para hunks complexos',
    featLlmFallbackDesc: 'Resolução opt-in via Claude / OpenAI / Ollama / MCP. Validada pelo mesmo pipeline parse-tree dos padrões deterministas. Trace de decisão e botão reject inclusos.',
    featForge: 'GitHub, GitLab e Bitbucket',
    featForgeDesc: 'Suporte a PR nativo nos três forges. Detecta automaticamente o remote e escolhe o provedor certo. Contas gerenciadas uma única vez em Configurações — sem reautenticação por repo.',
    featBranchMgmt: 'Branches: fixadas, arquivadas, identidade',
    featBranchMgmtDesc: 'Fixe suas branches mais usadas no topo. Arquive as mergeadas ou inativas com um limite configurável. Identidade por repo — e-mail diferente para pessoal e trabalho.',
    featIdentities: 'Templates de commit & Conventional Commits',
    featIdentitiesDesc: 'Configure templates de commit por repo, carregados automaticamente ao abrir. Escolha um prefixo de Conventional Commits (feat, fix, docs…) a partir de um seletor integrado.',
    featAISuggest: 'Sugestões de código IA inline',
    featAISuggestDesc: 'Selecione qualquer hunk no painel Review, peça uma reescrita focada e aceite a sugestão de IA com um clique. Presets de prompts adicionam contexto instantâneo.',
    // Banner de Novidades
    newReleaseBadge: 'Novo na v2.13',
    newReleaseTitle: 'Review de código IA, inline — direto no seu diff de PR',
    newReleaseSub: 'Selecione um hunk no painel Review, peça uma reescrita focada e aceite com um clique. Presets de prompts adicionam contexto instantâneo em cada funcionalidade IA.',
    newReleaseCta: 'Ver as novidades',
    faqTitle: 'Perguntas frequentes',
    faqItems: [
      { q: 'O GitWand é realmente gratuito?', a: 'Sim, o GitWand é totalmente open source sob licença MIT. Você pode usar, modificar e redistribuir livremente.' },
      { q: 'Como funciona a resolução inteligente de conflitos?', a: 'O GitWand analisa a semântica do código com 10 padrões de resolução (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orquestrados por um pattern registry (v1.4) e pontuação de confiança por hunk. Conflitos triviais são resolvidos automaticamente; casos complexos são apresentados com trace de explicação completo.' },
      { q: 'O que é o servidor MCP e por que usá-lo?', a: 'O servidor MCP expõe o motor do GitWand a agentes de IA — Claude Code, Cursor, Windsurf e outros. Roda localmente via stdio, sem chave de API nem acesso à rede. O GitWand cuida de 95 %+ dos conflitos triviais; o agente de IA lida com os ambíguos com todo o contexto necessário.' },
      { q: 'O GitWand funciona com qualquer repositório Git?', a: 'Sim. O GitWand funciona com qualquer repositório Git local, independente do hosting (GitHub, GitLab, Bitbucket, Gitea…). A view de Pull Requests está limitada ao GitHub por enquanto.' },
      { q: 'Qual é a diferença para outros clientes Git?', a: 'O GitWand se destaca pelo motor de resolução integrado, arquitetura nativa Tauri (sem Electron), 3 interfaces coerentes (desktop, CLI, VS Code) e servidor MCP para integração com agentes de IA.' },
      { q: 'Como instalar o servidor MCP?', a: 'Com Claude Code basta um único comando: claude mcp add gitwand -- npx -y @gitwand/mcp. Para Claude Desktop, Cursor ou Windsurf, adicione o bloco mcpServers à configuração do seu cliente (veja a documentação). O servidor também está listado no registro oficial MCP, então clientes que navegam o registro o encontram automaticamente.' },
    ],
    compareTitle: 'GitWand comparado à concorrência',
    compareSub: 'Comparação recurso a recurso com os clientes Git mais populares do mercado.',
  },
  'zh-CN': {
    badge: 'v2.14.0 · 开源 · MIT',
    heroH1a: '自动解决冲突的',
    heroH1b: 'Git 客户端',
    heroSub: 'GitWand 通过 10 种确定性模式与逐 hunk 置信度评分，对每个合并冲突进行分类。95% 的简单冲突自动解决。复杂的留给你，附带完整追踪。原生、免费、开源。',
    download: '下载',
    github: 'GitHub',
    whatsNew: 'v2.14 新特性',
    docs: '文档 →',
    platforms: 'macOS · Linux · Windows',
    statPatterns: '种解决模式',
    statResolved: '冲突自动解决',
    statInterfaces: '种界面(桌面端、CLI、VS Code)',
    featTitle: 'Git 所需的一切',
    featSub: '完整的工作流,无需牺牲性能。',
    featPerf: '原生性能',
    featPerfDesc: '基于 Tauri 2 与 Vue 3 构建。亚秒级启动。零 Electron 开销。',
    featResolve: '智能解决',
    featResolveDesc: '10 种解决模式,配合模式注册表(v1.4)和置信度评分。95% 以上的简单冲突无需干预即可解决。',
    featDiff: '可视化 Diff',
    featDiffDesc: '统一的 diff 查看器,支持语法高亮、按 hunk 暂存和合并预览。',
    featHistory: '历史与图谱',
    featHistoryDesc: '完整历史、交互式 DAG 图谱、文件 blame,以及对提交的自然语言搜索。',
    featPR: '集成的 Pull Requests',
    featPRDesc: '直接在应用中审阅 GitHub PR。评论、评审、CI 状态与冲突预览。',
    featUI: '3 种界面',
    featUIDesc: '桌面应用(macOS/Linux/Windows)、用于 CI/CD 的 gitwand resolve CLI,以及 VS Code 扩展。',
    featAIPR: 'AI 代码评审与 PR',
    featAIPRDesc: '自动生成 PR 标题和描述,在 Review 面板中按 hunk 进行 AI 评审,并基于 diff 提供分支命名建议。',
    featAIMerge: 'AI 合并洞察',
    featAIMergeDesc: '用自然语言解释冲突,在 rebase/merge 前给出 AI 风险摘要,并在交互式 rebase 中进行语义 squash。',
    featAIFlow: 'AI 提交与历史',
    featAIFlowDesc: '生成 commit 与 stash 信息、按语义排序的 Absorb、blame 上下文,以及基于 git log 的发布说明。',
    featImgDiff: '图像 diff 查看器',
    featImgDiffDesc: '以并排、叠加、闪烁或滑动方式比较 PNG、JPG、WebP、GIF、SVG 的变化。告别「Binary file changed」。',
    featFolderTree: '文件夹树状 diff',
    featFolderTreeDesc: '提交文件列表中平铺 ↔ 树状切换,按文件夹聚合统计、点击过滤,侧边栏宽度可调且持久保存。',
    featWorktrees: 'Git 工作树',
    featWorktreesDesc: '无需 stash 即可同时处理多个分支。每个工作树可直接作为标签页打开。在分支列表中一键创建。',
    featSubmodules: '子模块管理',
    featSubmodulesDesc: '列出、初始化并更新 Git 子模块,带状态标记。从面板中添加子模块并直接以标签页形式打开。',
    featSplitCommit: '按 hunk 拆分提交',
    featSplitCommitDesc: '通过选择文件和行将一次提交拆分为两次。阻止合并提交,在折叠/展开时保留选择,支持新增、删除、重命名文件。',
    featCommitCtx: '提交右键菜单',
    featCommitCtxDesc: '右键 12 个操作:checkout、reset、revert、新建分支、tag、cherry-pick、在 forge 查看及复制 SHA。',
    featTags: 'Tag 管理器',
    featTagsDesc: '列出、创建、推送和删除本地及远程 tag。AI 自动建议下一个语义版本号。',
    featTrailers: 'Trailers & 约定式提交',
    featTrailersDesc: '一键添加 Signed-off-by 和 Reviewed-by。内置提交前缀选择器(feat、fix、docs…)。',
    featFileHistory: '高级文件历史',
    featFileHistoryDesc: '文件历史 pickaxe 搜索(-S/-G)、按行范围 blame,以及 diff 算法选择器。',
    featForkWorkflow: 'Fork & 三角工作流',
    featForkWorkflowDesc: '同步按钮上的"↑N fork"标记,适用于 push remote ≠ upstream 的 fork 场景。',
    featMcp: 'MCP 服务器',
    featMcpDesc: '将 GitWand 暴露给 Claude、Cursor、Windsurf 等 MCP 客户端。一条命令:npx -y @gitwand/mcp。附带 provenance 签名发布。',
    conflictTitle: '合并冲突,自动解决',
    conflictSub: 'GitWand 分析代码语义,而不仅仅是文本行。它为你挑选正确的解决方案。',
    conflictBefore: '之前 — 原始冲突',
    conflictAfter: '之后 — 自动解决',
    conflictBadge: '置信度 97% · prefer-theirs · 语义化',
    previewTitle: '你会爱上的 Git 客户端',
    previewSub: '简洁的界面、深色主题,所有 Git 功能集于一处。',
    platformsTitle: '处处可用',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: '.exe · .msi 安装程序',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: '扩展市场',
    ctaTitle: '准备好简化你的 Git 工作流了吗?',
    ctaSub: '免费、开源,为追求效率的开发者而生。',
    ctaDownload: '下载 GitWand',
    llmTitle: '让你的 AI 代理参与其中',
    llmSub: 'GitWand 的 MCP 服务器将其冲突引擎开放给 AI 代理。GitWand 处理简单情况 — 你的代理接管复杂情况。',
    llmBadge: 'MCP 服务器 · 官方注册表 · stdio · 无需 API 密钥',
    llmStep1: '分析',
    llmStep1Desc: '代理调用 gitwand_preview_merge 来评估冲突数量、复杂度,以及 GitWand 能独立解决的比例。',
    llmStep2: '自动解决',
    llmStep2Desc: 'GitWand 立即解决简单模式(whitespace、one-side-change、same-change…),并返回带有分类追踪的模糊 hunk。',
    llmStep3: 'AI 解决',
    llmStep3Desc: '对于每个复杂冲突,代理都能获得完整上下文:ours/theirs/base 内容、分类追踪以及置信度评分。',
    llmCompat: '兼容',
    llmDocs: '查看 MCP 文档 →',
    patternsTitle: '10 种模式。确定性的。可审计的。',
    patternsSub: '每个 hunk 都经过分类器处理。每种模式都有自己的置信度配置和自动解析器。',
    benchTitle: '数字，而非形容词。',
    benchSub: '在 M 系列芯片上使用典型仓库测量的性能。',
    tabCore: 'Git 核心', tabAI: 'AI', tabPower: '高级玩法', tabNew: '最新特性',
    featuresAria: '功能类别',
    // 3 Pillars
    pillarsTitle: '三大支柱,一个承诺',
    pillarsSub: '冲突自动解决、原生性能、可选可审计的 AI。',
    pillar1Title: '自动解决 95% 的简单冲突',
    pillar1Sub: '10 种确定性模式。组合式置信度评分。每个 hunk 都有决策追踪。',
    pillar1Stat: '95%',
    pillar1StatLabel: '简单冲突自动解决',
    pillar1Cta: '查看引擎 →',
    pillar2Title: 'Tauri 2 + Rust。原生、快速、可预测。',
    pillar2Sub: '懒加载面板。libgit2 快路径。轮询自律。零 Electron 开销。',
    pillar2Stat: '<1 秒',
    pillar2StatLabel: '冷启动',
    pillar2Cta: '为什么选原生 →',
    pillar3Title: 'AI 在你卡住的地方接管',
    pillar3Sub: '复杂 hunk 的 LLM fallback。面向代理的 MCP 服务器。始终可选,始终可审计。',
    pillar3Stat: 'Claude · OpenAI · Ollama',
    pillar3StatLabel: '你的 LLM,你的密钥',
    pillar3Cta: 'AI fallback 指南 →',
    // 最新特性标签页 (v2.9 → v2.13)
    featLaunchpad: 'Launchpad — 跨仓库仪表盘',
    featLaunchpadDesc: '聚合 workspace 中所有仓库的 PR、issues、WIP 和团队动态。固定、暂缓、Team 懒加载。从任意位置按 ⌘L 唤起。',
    featLlmFallback: '复杂 hunk 的 LLM fallback',
    featLlmFallbackDesc: '通过 Claude / OpenAI / Ollama / MCP 进行可选解析。与确定性模式走同一条 parse-tree 校验管线。附带决策追踪与拒绝按钮。',
    featForge: 'GitHub、GitLab 与 Bitbucket',
    featForgeDesc: '三大 forge 的原生 PR 支持，自动检测远端并选择正确的提供商。账号在设置中统一管理，无需按仓库重复验证。',
    featBranchMgmt: '分支管理：置顶、归档、身份',
    featBranchMgmtDesc: '将最常用的分支置顶显示。按可配置阈值归档已合并或不活跃的分支。按仓库设置提交者身份 — 个人与工作仓库使用不同邮箱。',
    featIdentities: '提交模板与约定式提交',
    featIdentitiesDesc: '为每个仓库配置提交模板，打开时自动加载。通过内置选择器选择约定式提交前缀（feat、fix、docs…）。',
    featAISuggest: '内联 AI 代码建议',
    featAISuggestDesc: '在 Review 面板中选择任意 hunk，请求针对性重写，一键接受 AI 建议。提示词预设为所有 AI 功能即时注入上下文。',
    // 最新特性横幅
    newReleaseBadge: 'v2.13 新特性',
    newReleaseTitle: '内联 AI 代码审查 — 直接在 PR diff 中',
    newReleaseSub: '在 Review 面板中选择一个 hunk，请求针对性重写，一键接受。提示词预设为每项 AI 功能即时注入上下文。',
    newReleaseCta: '查看新特性',
    faqTitle: '常见问题',
    faqItems: [
      { q: 'GitWand 真的免费吗?', a: '是的,GitWand 在 MIT 许可下完全开源。你可以自由使用、修改和分发。' },
      { q: '智能冲突解决是如何工作的?', a: 'GitWand 使用 10 种解决模式(whitespace_only、same_change、one_side_change、reorder_only、insertion_at_boundary…)分析代码语义,由模式注册表(v1.4)进行编排,并对每个 hunk 打出置信度评分。简单冲突自动解决;复杂情况会附上完整的解释追踪呈现出来。' },
      { q: 'MCP 服务器是什么?为什么要用?', a: 'MCP 服务器将 GitWand 的引擎开放给 AI 代理 — Claude Code、Cursor、Windsurf 等。通过 stdio 在本地运行,无需 API 密钥,也不需要网络访问。GitWand 处理 95%+ 的简单冲突;AI 代理则在完整上下文下应对模糊情况。' },
      { q: 'GitWand 适用于任何 Git 仓库吗?', a: '是的。GitWand 适用于任何本地 Git 仓库,无论托管在哪里(GitHub、GitLab、Bitbucket、Gitea…)。Pull Requests 视图目前仅限 GitHub。' },
      { q: '与其他 Git 客户端有什么区别?', a: 'GitWand 的亮点在于内置的解决引擎、原生的 Tauri 架构(非 Electron)、3 种一致的界面(桌面端、CLI、VS Code),以及用于 AI 代理集成的 MCP 服务器。' },
      { q: '如何安装 MCP 服务器?', a: '使用 Claude Code 一条命令即可:claude mcp add gitwand -- npx -y @gitwand/mcp。对于 Claude Desktop、Cursor 或 Windsurf,将 mcpServers 块添加到你的客户端配置(见文档)。该服务器也已列入官方 MCP 注册表,浏览注册表的客户端会自动发现它。' },
    ],
    compareTitle: 'GitWand 与同类对比',
    compareSub: '与市场上最流行的 Git 客户端逐功能对比。',
  },
}

const t = computed(() => i18n[locale.value])

// ── Comparison table ──────────────────────────────────────────────────────────
type CompareValue = boolean | 'partial' | 'soon'
interface CompareRow {
  category?: boolean
  label: string
  note?: string
  highlight?: boolean
  gw?: CompareValue
  ghd?: CompareValue
  gk?: CompareValue
  fork?: CompareValue
  tower?: CompareValue
  sm?: CompareValue
}

const COMPARE_ROWS: CompareRow[] = [
  { category: true, label: 'Workflow' },
  { label: 'Free & open source',       gw: true,      ghd: true,      gk: false,     fork: false,   tower: false,  sm: false },
  { label: 'Native app (no Electron)', gw: true,      ghd: false,     gk: false,     fork: true,    tower: true,   sm: true  },
  { label: 'macOS',                    gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Linux',                    gw: true,      ghd: false,     gk: true,      fork: false,   tower: false,  sm: true  },
  { label: 'Windows',                  gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'CLI tool',                 gw: true,      ghd: false,     gk: false,     fork: false,   tower: false,  sm: false },
  { label: 'VS Code extension',        gw: true,      ghd: false,     gk: false,     fork: false,   tower: false,  sm: false },

  { category: true, label: 'Diff & Staging' },
  { label: 'Syntax highlighting',      gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Hunk-level staging',       gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Line-level staging',       gw: true,      ghd: false,     gk: 'partial', fork: 'partial', tower: true, sm: false },
  { label: 'Side-by-side diff',        gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Image diff (visual)',      gw: true,      ghd: false,     gk: false,     fork: false,   tower: false,  sm: true  },
  { label: 'Folder tree diff',         gw: true,      ghd: false,     gk: false,     fork: false,   tower: false,  sm: false },

  { category: true, label: 'Conflict Resolution' },
  { label: 'Auto-resolve conflicts',        gw: true, ghd: false, gk: 'partial', fork: false, tower: false, sm: false, highlight: true },
  { label: 'Confidence scoring per hunk',   gw: true, ghd: false, gk: false,     fork: false, tower: false, sm: false, highlight: true },
  { label: '3-way merge editor',            gw: true, ghd: false, gk: true,      fork: true,  tower: true,  sm: true  },
  { label: 'Zero-impact merge preview',     gw: true, ghd: false, gk: false,     fork: false, tower: false, sm: false, highlight: true },
  { label: 'Proactive conflict prevention', gw: true, ghd: false, gk: 'partial', fork: false, tower: 'partial', sm: false },

  { category: true, label: 'Power Git' },
  { label: 'Interactive rebase',            gw: true, ghd: 'partial', gk: true, fork: true, tower: true, sm: true  },
  { label: 'Worktrees',                     gw: true, ghd: false,     gk: true,  fork: true,  tower: true, sm: false },
  { label: 'Submodule management',          gw: true, ghd: false,     gk: true,  fork: true,  tower: true, sm: true  },
  { label: 'Split commit by hunks',         gw: true, ghd: false,     gk: false, fork: false, tower: false, sm: false },
  { label: 'File blame + line-range',       gw: true, ghd: false,     gk: true,  fork: true,  tower: true, sm: true  },
  { label: 'Conventional commits',          gw: true, ghd: false,     gk: false, fork: false, tower: false, sm: false },
  { label: 'Multi-repo workspaces',         gw: true, ghd: false,     gk: true,  fork: false, tower: 'partial', sm: false },
  { label: 'Cross-repo dashboard',          gw: true, ghd: false,     gk: true,  fork: false, tower: false,     sm: false },

  { category: true, label: 'Forge integrations' },
  { label: 'GitHub PRs',                    gw: true,   ghd: true,  gk: true,  fork: 'partial', tower: 'partial', sm: false },
  { label: 'GitLab MRs',                    gw: 'soon', ghd: false, gk: true,  fork: false,     tower: 'partial', sm: false },
  { label: 'Bitbucket PRs',                 gw: 'soon', ghd: false, gk: true,  fork: false,     tower: 'partial', sm: false },
  { label: 'Git hooks manager',             gw: true,   ghd: false, gk: false, fork: false,     tower: false,     sm: false },

  { category: true, label: 'AI & Agents', note: 'GitWand connects to your own LLM — Claude, OpenAI-compatible, or Ollama. No built-in model.' },
  { label: 'AI commit messages',            gw: true,   ghd: true,      gk: true,      fork: 'partial', tower: true,  sm: false },
  { label: 'AI conflict explanation',       gw: true,   ghd: false,     gk: 'partial', fork: false,     tower: false, sm: false, highlight: true },
  { label: 'AI PR description',             gw: true,   ghd: false,     gk: true,      fork: false,     tower: false, sm: false },
  { label: 'MCP server for AI agents',      gw: true,   ghd: false,     gk: true,      fork: false,     tower: false, sm: false },
  { label: 'Agent Sessions panel',          gw: true,   ghd: false,     gk: true,      fork: false,     tower: false, sm: false },
  { label: 'Voice input (offline Whisper)', gw: 'soon', ghd: false,     gk: false,     fork: false,     tower: false, sm: false },
]

function cellIcon(v: CompareValue | undefined): string {
  if (v === true) return '✓'
  if (v === 'partial') return '~'
  if (v === 'soon') return 'soon'
  return '✗'
}
function cellClass(v: CompareValue | undefined): string {
  if (v === true) return 'cell-yes'
  if (v === 'partial') return 'cell-partial'
  if (v === 'soon') return 'cell-soon'
  return 'cell-no'
}
</script>

<template>
  <div class="gw-landing">

    <!-- Language picker (mirrors the 5 locales of the desktop app) -->
    <div class="lang-picker" role="group" aria-label="Language">
      <button
        v-for="L in LOCALES"
        :key="L.code"
        class="lang-pill"
        :class="{ 'lang-pill--active': locale === L.code }"
        :title="L.title"
        :aria-pressed="locale === L.code"
        @click="setLocale(L.code)"
      >
        {{ L.label }}
      </button>
    </div>

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
            <div class="btn-split">
              <a :href="downloadUrl" class="btn-primary btn-split__main">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v10M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                {{ t.download }}
              </a>
              <a href="https://github.com/devlint/GitWand/releases" class="btn-primary btn-split__aside" target="_blank" rel="noopener" :title="t.github">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </a>
            </div>
            <a href="/guide/getting-started" class="btn-ghost">
              {{ t.docs }}
            </a>
          </div>
          <p class="hero-platforms">{{ t.platforms }}</p>
        </div>

        <!-- Right: terminal animation -->
        <div class="hero-visual">
          <div class="hero-term">
            <div class="hero-term__bar">
              <span class="tl tl-r"></span><span class="tl tl-y"></span><span class="tl tl-g"></span>
              <span class="hero-term__title">~/projects/myapp — gitwand</span>
              <button class="hero-term__replay" :disabled="termRunning" @click="runTerminalDemo" :title="'↻ Replay'">↻</button>
            </div>
            <div class="hero-term__body">
              <div
                v-for="(line, i) in termLines" :key="i"
                class="hero-term__line"
                :class="`hero-term__line--${line.type}`"
              >{{ line.text }}</div>
              <span v-if="termRunning" class="hero-term__cursor">▋</span>
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
        <span class="stat-n">10</span>
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
         3 PILLARS — strategic positioning under the Hero/Stats
    ══════════════════════════════════════ -->
    <section class="hl-pillars">
      <div class="section-inner">
        <h2 class="section-title">{{ t.pillarsTitle }}</h2>
        <p class="section-sub">{{ t.pillarsSub }}</p>
        <div class="hl-pillars__grid">
          <!-- Pillar 1 — Conflict resolution -->
          <article class="hl-pillar">
            <div class="hl-pillar__icon hl-pillar__icon--purple">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6"/>
                <circle cx="6" cy="3" r="1.5"/>
                <circle cx="18" cy="21" r="1.5"/>
                <path d="M9 12l2 2 4-4"/>
              </svg>
            </div>
            <h3 class="hl-pillar__title">{{ t.pillar1Title }}</h3>
            <p class="hl-pillar__sub">{{ t.pillar1Sub }}</p>
            <div class="hl-pillar__stat">
              <span class="hl-pillar__stat-n">{{ t.pillar1Stat }}</span>
              <span class="hl-pillar__stat-l">{{ t.pillar1StatLabel }}</span>
            </div>
            <a href="/guide/conflict-resolution" class="hl-pillar__cta">{{ t.pillar1Cta }}</a>
          </article>

          <!-- Pillar 2 — Native performance -->
          <article class="hl-pillar">
            <div class="hl-pillar__icon hl-pillar__icon--green">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
            </div>
            <h3 class="hl-pillar__title">{{ t.pillar2Title }}</h3>
            <p class="hl-pillar__sub">{{ t.pillar2Sub }}</p>
            <div class="hl-pillar__stat">
              <span class="hl-pillar__stat-n">{{ t.pillar2Stat }}</span>
              <span class="hl-pillar__stat-l">{{ t.pillar2StatLabel }}</span>
            </div>
            <a href="/guide/desktop" class="hl-pillar__cta">{{ t.pillar2Cta }}</a>
          </article>

          <!-- Pillar 3 — AI assists -->
          <article class="hl-pillar">
            <div class="hl-pillar__icon hl-pillar__icon--gradient">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>
                <circle cx="12" cy="12" r="3.2"/>
              </svg>
            </div>
            <h3 class="hl-pillar__title">{{ t.pillar3Title }}</h3>
            <p class="hl-pillar__sub">{{ t.pillar3Sub }}</p>
            <div class="hl-pillar__stat">
              <span class="hl-pillar__stat-n hl-pillar__stat-n--small">{{ t.pillar3Stat }}</span>
              <span class="hl-pillar__stat-l">{{ t.pillar3StatLabel }}</span>
            </div>
            <a href="/guide/llm-fallback" class="hl-pillar__cta">{{ t.pillar3Cta }}</a>
          </article>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         CONFLICT RESOLUTION DEMO (moved before features)
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
         10 PATTERNS GRID
    ══════════════════════════════════════ -->
    <section class="patterns-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.patternsTitle }}</h2>
        <p class="section-sub">{{ t.patternsSub }}</p>
        <div class="patterns-grid">
          <div
            v-for="p in PATTERNS" :key="p.name"
            class="pat-card"
            :class="{ 'pat-card--dim': !p.auto }"
          >
            <div class="pat-head">
              <code class="pat-name">{{ p.name }}</code>
              <span class="pat-conf" :class="`pat-conf--${p.conf}`">{{ p.conf }}</span>
            </div>
            <p class="pat-desc">{{ p.desc }}</p>
            <div class="pat-auto" :class="p.auto ? 'pat-auto--yes' : 'pat-auto--no'">
              {{ p.auto ? '⚡ Auto-resolved' : '○ Review needed' }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         WHAT'S NEW HIGHLIGHT BANNER — drives traffic to the "new" tab
    ══════════════════════════════════════ -->
    <section class="hl-new-release">
      <div class="hl-new-release__inner">
        <div class="hl-new-release__copy">
          <span class="hl-new-release__badge">{{ t.newReleaseBadge }}</span>
          <h2 class="hl-new-release__title">{{ t.newReleaseTitle }}</h2>
          <p class="hl-new-release__sub">{{ t.newReleaseSub }}</p>
        </div>
        <div class="hl-new-release__cta">
          <a class="hl-new-release__link" href="/changelog" @click.prevent="jumpToNewTab">
            {{ t.newReleaseCta }} →
          </a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         FEATURES (tabbed — replaces flat grid)
    ══════════════════════════════════════ -->
    <section class="features">
      <div class="section-inner">
        <h2 class="section-title">{{ t.featTitle }}</h2>
        <p class="section-sub">{{ t.featSub }}</p>

        <!-- Tab navigation -->
        <div class="feat-tabs" role="tablist" :aria-label="t.featuresAria">
          <button role="tab" class="feat-tab" :aria-selected="activeTab === 'core'" :class="{ 'feat-tab--active': activeTab === 'core' }" @click="activeTab = 'core'">{{ t.tabCore }}</button>
          <button role="tab" class="feat-tab" :aria-selected="activeTab === 'power'" :class="{ 'feat-tab--active': activeTab === 'power' }" @click="activeTab = 'power'">{{ t.tabPower }}</button>
          <button role="tab" class="feat-tab" :aria-selected="activeTab === 'ai'" :class="{ 'feat-tab--active': activeTab === 'ai' }" @click="activeTab = 'ai'">{{ t.tabAI }}</button>
          <button role="tab" class="feat-tab feat-tab--highlight" :aria-selected="activeTab === 'new'" :class="{ 'feat-tab--active': activeTab === 'new' }" @click="activeTab = 'new'">{{ t.tabNew }}</button>
        </div>

        <!-- Core Git tab — daily workflow essentials -->
        <Transition name="hl-tab-fade" mode="out-in">
          <div v-if="activeTab === 'core'" key="core" class="features-grid" role="tabpanel">
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 100 14A7 7 0 0012 2z" stroke="#7C3AED" stroke-width="1.8"/><path d="M9 12l2 2 4-4" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3>{{ t.featResolve }}</h3><p>{{ t.featResolveDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3>{{ t.featPR }}</h3><p>{{ t.featPRDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="14" rx="2" stroke="#7C3AED" stroke-width="1.8"/><path d="M8 21h8M12 17v4" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featDiff }}</h3><p>{{ t.featDiffDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 5a1 1 0 011-1h4l2 2h10a1 1 0 011 1v2H3V5z" stroke="#7C3AED" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 9h18v11a1 1 0 01-1 1H4a1 1 0 01-1-1V9z" stroke="#7C3AED" stroke-width="1.8"/><path d="M7 13h4M7 17h7" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featFolderTree }}</h3><p>{{ t.featFolderTreeDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.5" stroke="#7C3AED" stroke-width="1.8"/><circle cx="18" cy="6" r="2.5" stroke="#7C3AED" stroke-width="1.8"/><circle cx="12" cy="18" r="2.5" stroke="#7C3AED" stroke-width="1.8" fill="rgba(124,58,237,0.07)"/><path d="M6 8.5v3a2 2 0 002 2h8a2 2 0 002-2v-3M12 13.5V16" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featSplitCommit }}</h3><p>{{ t.featSplitCommitDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7 7h10M7 12h6" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/><circle cx="17" cy="17" r="4" stroke="#7C3AED" stroke-width="1.8"/><path d="M17 15v2l1 1" stroke="#7C3AED" stroke-width="1.5" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featTags }}</h3><p>{{ t.featTagsDesc }}</p>
            </div>
          </div>

          <!-- Power user tab (was "Integrations") -->
          <div v-else-if="activeTab === 'power'" key="power" class="features-grid" role="tabpanel">
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="9" height="18" rx="1.5" stroke="#7C3AED" stroke-width="1.8"/><rect x="13" y="3" width="9" height="18" rx="1.5" stroke="#7C3AED" stroke-width="1.8" fill="rgba(124,58,237,0.07)"/><path d="M6 8h2M6 12h2M6 16h2M17 8h1M17 12h1M17 16h1" stroke="#7C3AED" stroke-width="1.5" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featWorktrees }}</h3><p>{{ t.featWorktreesDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="9" height="7" rx="1.5" stroke="#7C3AED" stroke-width="1.8"/><rect x="13" y="2" width="9" height="7" rx="1.5" stroke="#7C3AED" stroke-width="1.8" fill="rgba(124,58,237,0.07)"/><path d="M6.5 9v3.5a1 1 0 001 1h9a1 1 0 001-1V9" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/><rect x="8" y="14" width="8" height="8" rx="1.5" stroke="#7C3AED" stroke-width="1.8"/></svg></div>
              <h3>{{ t.featSubmodules }}</h3><p>{{ t.featSubmodulesDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h10M4 18h7" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/><circle cx="19" cy="17" r="3" stroke="#7C3AED" stroke-width="1.6"/><path d="M21.5 19.5l1.5 1.5" stroke="#7C3AED" stroke-width="1.6" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featFileHistory }}</h3><p>{{ t.featFileHistoryDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2" stroke="#7C3AED" stroke-width="1.8"/><circle cx="18" cy="6" r="2" stroke="#7C3AED" stroke-width="1.8"/><circle cx="12" cy="18" r="2" stroke="#7C3AED" stroke-width="1.8"/><path d="M8 6h8M7 8l-2 8M17 8l2 8" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featHistory }}</h3><p>{{ t.featHistoryDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2" stroke="#7C3AED" stroke-width="1.8"/><circle cx="18" cy="6" r="2" stroke="#7C3AED" stroke-width="1.8"/><circle cx="12" cy="20" r="2" stroke="#7C3AED" stroke-width="1.8"/><path d="M6 8v4a2 2 0 002 2h4M18 8v4a2 2 0 01-2 2h-4M12 14v4" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featCommitCtx }}</h3><p>{{ t.featCommitCtxDesc }}</p>
            </div>
            <div class="feat-card">
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="2.5" stroke="#7C3AED" stroke-width="1.8"/><circle cx="19" cy="6" r="2.5" stroke="#7C3AED" stroke-width="1.8"/><circle cx="19" cy="18" r="2.5" stroke="#7C3AED" stroke-width="1.8"/><path d="M7.5 12h9M16.5 6l-4 4.5M16.5 18l-4-4.5" stroke="#7C3AED" stroke-width="1.5" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featForkWorkflow }}</h3><p>{{ t.featForkWorkflowDesc }}</p>
            </div>
          </div>

          <!-- AI tab -->
          <div v-else-if="activeTab === 'ai'" key="ai" class="features-grid" role="tabpanel">
            <div class="feat-card feat-card--ai">
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9v4a2 2 0 01-2 2H8" stroke="#10B981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3>{{ t.featAIMerge }}</h3><p>{{ t.featAIMergeDesc }}</p>
            </div>
            <div class="feat-card feat-card--ai">
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="#10B981" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="#10B981" stroke-width="1.8"/></svg></div>
              <h3>{{ t.featAIPR }}</h3><p>{{ t.featAIPRDesc }}</p>
            </div>
            <div class="feat-card feat-card--ai">
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#10B981" stroke-width="1.8"/><path d="M12 7v5l3 2" stroke="#10B981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3>{{ t.featAIFlow }}</h3><p>{{ t.featAIFlowDesc }}</p>
            </div>
            <div class="feat-card feat-card--ai">
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="#10B981" stroke-width="1.8"/><path d="M3 9h18M8 13h3M8 16h5" stroke="#10B981" stroke-width="1.5" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featTrailers }}</h3><p>{{ t.featTrailersDesc }}</p>
            </div>
            <div class="feat-card feat-card--ai">
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 22v-5M9 7V3M15 7V3M5 11V9a2 2 0 012-2h10a2 2 0 012 2v2a5 5 0 01-5 5h-4a5 5 0 01-5-5z" stroke="#10B981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3>{{ t.featMcp }}</h3><p>{{ t.featMcpDesc }}</p>
            </div>
            <div class="feat-card feat-card--ai">
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2" stroke="#10B981" stroke-width="1.8"/><circle cx="18" cy="6" r="2" stroke="#10B981" stroke-width="1.8"/><circle cx="12" cy="20" r="2" stroke="#10B981" stroke-width="1.8"/><path d="M6 8v4a2 2 0 002 2h4M18 8v4a2 2 0 01-2 2h-4M12 14v4" stroke="#10B981" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <h3>{{ t.featCommitCtx }}</h3><p>{{ t.featCommitCtxDesc }}</p>
            </div>
          </div>

          <!-- What's New tab — 6 highlights from v2.9 → v2.13 -->
          <div v-else-if="activeTab === 'new'" key="new" class="features-grid" role="tabpanel">
            <!-- AI inline code suggestions — v2.13 -->
            <div class="feat-card feat-card--new">
              <div class="feat-badge">v2.13</div>
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 9h4M7 12h6M15 12l2 2-2 2"/><path d="M8 21h8M12 17v4"/></svg></div>
              <h3>{{ t.featAISuggest }}</h3><p>{{ t.featAISuggestDesc }}</p>
            </div>
            <!-- Forge integrations — v2.10 -->
            <div class="feat-card feat-card--new">
              <div class="feat-badge">v2.10</div>
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M10.3 14.5L6.8 17M13.7 14.5l3.5 2.5M10 11h4"/></svg></div>
              <h3>{{ t.featForge }}</h3><p>{{ t.featForgeDesc }}</p>
            </div>
            <!-- Branch management — v2.12 -->
            <div class="feat-card feat-card--new">
              <div class="feat-badge">v2.12</div>
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><path d="M6 8v8M18 6a4 4 0 00-4 4v4a4 4 0 008 0v-1"/><path d="M15 3l3 3-3 3"/></svg></div>
              <h3>{{ t.featBranchMgmt }}</h3><p>{{ t.featBranchMgmtDesc }}</p>
            </div>
            <!-- Commit templates & identities — v2.12 -->
            <div class="feat-card feat-card--new">
              <div class="feat-badge">v2.12</div>
              <div class="feat-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M8 13h3M8 16h5M16 13l1.5 1.5L20 12"/></svg></div>
              <h3>{{ t.featIdentities }}</h3><p>{{ t.featIdentitiesDesc }}</p>
            </div>
            <!-- Launchpad — v2.9 -->
            <div class="feat-card feat-card--new">
              <div class="feat-badge">v2.9</div>
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>
              <h3>{{ t.featLaunchpad }}</h3><p>{{ t.featLaunchpadDesc }}</p>
            </div>
            <!-- LLM fallback — v2.5 -->
            <div class="feat-card feat-card--new">
              <div class="feat-badge">v2.5</div>
              <div class="feat-icon feat-icon--ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/></svg></div>
              <h3>{{ t.featLlmFallback }}</h3><p>{{ t.featLlmFallbackDesc }}</p>
            </div>
          </div>
        </Transition>

      </div>
    </section>

    <!-- ══════════════════════════════════════
         BENCHMARKS
    ══════════════════════════════════════ -->
    <section class="bench-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.benchTitle }}</h2>
        <p class="section-sub">{{ t.benchSub }}</p>
        <div class="bench-grid">
          <div class="bench-card">
            <div class="bench-val">249k<span class="bench-unit">ops/sec</span></div>
            <div class="bench-label">1 conflict · ~30 lines · M-series</div>
          </div>
          <div class="bench-card">
            <div class="bench-val">40k<span class="bench-unit">ops/sec</span></div>
            <div class="bench-label">5 conflicts · ~140 lines</div>
          </div>
          <div class="bench-card">
            <div class="bench-val">4.5k<span class="bench-unit">ops/sec</span></div>
            <div class="bench-label">50 conflicts · ~1350 lines</div>
          </div>
          <div class="bench-card bench-card--purple">
            <div class="bench-val">~8<span class="bench-unit">MB</span></div>
            <div class="bench-label">Binary size — vs ~150MB Electron</div>
          </div>
          <div class="bench-card bench-card--purple">
            <div class="bench-val">322<span class="bench-unit">tests</span></div>
            <div class="bench-label">Engine · CLI · App · all passing</div>
          </div>
          <div class="bench-card bench-card--green">
            <div class="bench-val">0</div>
            <div class="bench-label">Hallucinations — fully deterministic</div>
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
            <a href="/guide/mcp" class="llm-docs-link">{{ t.llmDocs }}</a>
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

        <img src="/screenshots/app-dashboard.png" alt="GitWand — dashboard with repo health, commit history and contributors" class="preview-window preview-screenshot" />
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
         COMPARISON TABLE
    ══════════════════════════════════════ -->
    <section class="compare-section">
      <div class="section-inner">
        <h2 id="compare" class="section-title">{{ t.compareTitle }}</h2>
        <p class="section-sub">{{ t.compareSub }}</p>
        <div class="compare-wrap">
          <table class="compare-table">
            <thead>
              <tr>
                <th class="compare-feat-col"></th>
                <th class="compare-app-col compare-app--gw">
                  <span class="compare-app-name">GitWand</span>
                  <span class="compare-app-meta">Free · MIT</span>
                </th>
                <th class="compare-app-col">
                  <span class="compare-app-name">GitHub Desktop</span>
                  <span class="compare-app-meta">Free · Electron</span>
                </th>
                <th class="compare-app-col">
                  <span class="compare-app-name">GitKraken</span>
                  <span class="compare-app-meta">$8/mo · Electron</span>
                </th>
                <th class="compare-app-col">
                  <span class="compare-app-name">Fork</span>
                  <span class="compare-app-meta">$50 · Native</span>
                </th>
                <th class="compare-app-col">
                  <span class="compare-app-name">Tower</span>
                  <span class="compare-app-meta">$69/yr · Native</span>
                </th>
                <th class="compare-app-col">
                  <span class="compare-app-name">Sublime Merge</span>
                  <span class="compare-app-meta">$99 · Native</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in COMPARE_ROWS" :key="row.label">
                <tr v-if="row.category" class="compare-category-row">
                  <td colspan="7">
                    {{ row.label }}
                    <span v-if="row.note" class="compare-category-note">{{ row.note }}</span>
                  </td>
                </tr>
                <tr v-else class="compare-feat-row" :class="{ 'compare-feat-row--highlight': row.highlight }">
                  <td class="compare-feat-name">
                    <span>{{ row.label }}</span>
                    <span v-if="row.highlight" class="compare-exclusive">unique</span>
                  </td>
                  <td class="compare-cell compare-app--gw"><span :class="cellClass(row.gw)">{{ cellIcon(row.gw) }}</span></td>
                  <td class="compare-cell"><span :class="cellClass(row.ghd)">{{ cellIcon(row.ghd) }}</span></td>
                  <td class="compare-cell"><span :class="cellClass(row.gk)">{{ cellIcon(row.gk) }}</span></td>
                  <td class="compare-cell"><span :class="cellClass(row.fork)">{{ cellIcon(row.fork) }}</span></td>
                  <td class="compare-cell"><span :class="cellClass(row.tower)">{{ cellIcon(row.tower) }}</span></td>
                  <td class="compare-cell"><span :class="cellClass(row.sm)">{{ cellIcon(row.sm) }}</span></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p class="compare-note">~ partial &nbsp;·&nbsp; SOON on the roadmap &nbsp;·&nbsp; data accurate as of April 2026</p>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         BLOG TEASER
    ══════════════════════════════════════ -->
    <section class="blog-teaser-section">
      <div class="section-inner">
        <div class="blog-teaser-header">
          <span class="blog-teaser-label">From the blog</span>
        </div>
        <a href="/blog/v2-13-ai-inline-suggestions" class="blog-teaser-card">
          <div class="blog-teaser-meta">May 18, 2026 · 14 min read</div>
          <h3 class="blog-teaser-title">AI code review in your PR diff: how GitWand v2.13 works</h3>
          <p class="blog-teaser-excerpt">Per-hunk AI critique with a four-tier verdict (ok / nit / suggestion / risk), an inline suggestion editor that stages GitHub suggestion blocks without leaving the diff, and named AI prompt presets for commit messages.</p>
          <span class="blog-teaser-cta">Read article →</span>
        </a>
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
          <div class="btn-split btn-split--lg">
            <a :href="downloadUrl" class="btn-primary btn-lg btn-split__main">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M8 1v10M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              {{ t.ctaDownload }}
            </a>
            <a href="https://github.com/devlint/GitWand/releases" class="btn-primary btn-lg btn-split__aside" target="_blank" rel="noopener" :title="t.github">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </a>
          </div>
          <a href="/changelog" class="btn-ghost btn-lg">
            ✨ {{ t.whatsNew }}
          </a>
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
/* ───────────────────────────────────────────
   Language picker (5 locales, segmented)
─────────────────────────────────────────── */
.lang-picker {
  position: fixed;
  top: 78px;
  right: 20px;
  z-index: 100;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: rgba(124, 58, 237, 0.12);
  border: 1px solid rgba(124, 58, 237, 0.35);
  border-radius: 10px;
  backdrop-filter: blur(8px);
}
.lang-pill {
  background: transparent;
  border: none;
  color: #c4b5fd;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 5px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  min-width: 30px;
  line-height: 1.1;
}
.lang-pill:hover {
  background: rgba(124, 58, 237, 0.2);
  color: #e9e5ff;
}
.lang-pill--active {
  background: rgba(124, 58, 237, 0.45);
  color: #ffffff;
}
.lang-pill--active:hover {
  background: rgba(124, 58, 237, 0.55);
  color: #ffffff;
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

/* Split button: Download | GitHub icon */
.btn-split {
  display: inline-flex;
  align-items: stretch;
}
.btn-split__main {
  border-radius: 8px 0 0 8px;
  border-right: 1px solid rgba(255,255,255,0.2);
}
.btn-split__aside {
  border-radius: 0 8px 8px 0;
  padding: 12px 14px;
}
.btn-split--lg .btn-split__aside {
  padding: 14px 16px;
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
.app-screenshot {
  display: block;
  width: 100%;
  height: auto;
}
.preview-screenshot {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 8px;
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
.feat-icon--ai {
  background: linear-gradient(135deg, rgba(124,58,237,0.12), rgba(16,185,129,0.14));
}
.feat-card--ai {
  border-color: rgba(16,185,129,0.28);
}
.feat-card--ai:hover {
  border-color: var(--gw-green);
}
.feat-card--new {
  position: relative;
  border-color: rgba(124,58,237,0.35);
}
.feat-badge {
  position: absolute;
  top: 12px;
  right: 14px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--gw-purple-light);
  background: rgba(124,58,237,0.12);
  border-radius: 4px;
  padding: 2px 6px;
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
.preview-window.preview-screenshot {
  background: transparent;
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
.platforms-section .section-title {
  margin-bottom: 48px;
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
   BLOG TEASER
─────────────────────────────────────────── */
.blog-teaser-section {
  padding: 64px 24px;
  border-top: 1px solid var(--gw-border);
}
.blog-teaser-header {
  margin-bottom: 1.5rem;
}
.blog-teaser-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--gw-purple);
  font-family: var(--vp-font-family-mono, monospace);
}
.blog-teaser-card {
  display: block;
  padding: 1.75rem 2rem;
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.2s, background 0.2s;
  max-width: 760px;
}
.blog-teaser-card:hover {
  border-color: var(--gw-purple);
  background: var(--gw-surface);
}
.blog-teaser-meta {
  font-size: 11px;
  color: var(--gw-text-muted);
  margin-bottom: 0.5rem;
  font-family: var(--vp-font-family-mono, monospace);
}
.blog-teaser-title {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 0 0 0.6rem;
  line-height: 1.45;
  color: var(--gw-text);
}
.blog-teaser-excerpt {
  font-size: 0.875rem;
  color: var(--gw-text-muted);
  margin: 0 0 1rem;
  line-height: 1.65;
}
.blog-teaser-cta {
  font-size: 0.85rem;
  color: var(--gw-purple);
  font-weight: 500;
}

/* ───────────────────────────────────────────
   COMPARISON TABLE
─────────────────────────────────────────── */
.compare-section {
  padding: 96px 0;
  background: var(--gw-bg-2);
  border-top: 1px solid var(--gw-border-soft);
}
.compare-section .section-title { margin-bottom: 12px; }
.compare-section .section-sub   { margin-bottom: 48px; }

.compare-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
}

.compare-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 13px;
}

/* ── Header row ── */
.compare-table thead th {
  padding: 14px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--gw-text-muted);
  border-bottom: 1px solid var(--gw-border);
  background: var(--gw-bg);
  white-space: nowrap;
  vertical-align: bottom;
}
.compare-feat-col {
  text-align: left !important;
  width: 220px;
  min-width: 160px;
}
.compare-app-col { min-width: 110px; }

.compare-app--gw {
  background: rgba(139, 92, 246, 0.07) !important;
  border-left: 1px solid rgba(139, 92, 246, 0.25);
  border-right: 1px solid rgba(139, 92, 246, 0.25);
}
.compare-app-name {
  display: block;
  font-weight: 700;
  font-size: 13px;
  color: var(--gw-text);
  margin-bottom: 3px;
}
.compare-app--gw .compare-app-name { color: var(--gw-purple-light); }
.compare-app-meta {
  display: block;
  font-size: 10px;
  color: var(--gw-text-muted);
  font-family: var(--vp-font-family-mono, monospace);
}

/* ── Category rows ── */
.compare-category-row td {
  padding: 20px 16px 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--gw-purple);
  font-family: var(--vp-font-family-mono, monospace);
  background: var(--gw-bg);
  border-bottom: 1px solid var(--gw-border-soft);
}
.compare-category-row:first-child td { padding-top: 16px; }
.compare-category-note {
  display: block;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: var(--gw-text-muted);
  font-family: inherit;
  margin-top: 3px;
  opacity: 0.8;
}

/* ── Feature rows ── */
.compare-feat-row {
  border-bottom: 1px solid var(--gw-border-soft);
  transition: background 0.1s;
}
.compare-feat-row:last-child { border-bottom: none; }
.compare-feat-row:hover { background: var(--gw-surface); }
.compare-feat-row--highlight { background: rgba(139, 92, 246, 0.03); }
.compare-feat-row--highlight:hover { background: rgba(139, 92, 246, 0.06); }

.compare-feat-name {
  padding: 11px 16px 11px 16px;
  font-size: 13px;
  color: var(--gw-text-muted);
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.compare-exclusive {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gw-purple-light);
  background: rgba(139, 92, 246, 0.15);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: var(--vp-font-family-mono, monospace);
  flex-shrink: 0;
}

/* ── Value cells ── */
.compare-cell {
  text-align: center;
  padding: 11px 8px;
  font-size: 15px;
  font-weight: 700;
  font-family: var(--vp-font-family-mono, monospace);
}
.compare-cell.compare-app--gw {
  background: rgba(139, 92, 246, 0.07);
  border-left: 1px solid rgba(139, 92, 246, 0.15);
  border-right: 1px solid rgba(139, 92, 246, 0.15);
}
.cell-yes     { color: var(--gw-green); }
.cell-partial { color: #f59e0b; font-size: 17px; }
.cell-no      { color: var(--gw-border); font-size: 13px; font-weight: 400; }
.cell-soon    { color: var(--gw-purple-light); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; font-family: var(--vp-font-family-mono, monospace); }

.compare-note {
  margin-top: 14px;
  text-align: center;
  font-size: 11px;
  color: var(--gw-text-muted);
  font-family: var(--vp-font-family-mono, monospace);
  opacity: 0.7;
}

/* ───────────────────────────────────────────
   HERO TERMINAL ANIMATION
─────────────────────────────────────────── */
.hero-visual {
  display: flex;
  align-items: center;
  justify-content: center;
}
.hero-term {
  width: 100%;
  max-width: 520px;
  background: #0d1117;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(124,58,237,0.12);
  font-family: var(--vp-font-family-mono, 'ui-monospace', monospace);
}
.hero-term__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: #161b22;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.hero-term__title {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: rgba(255,255,255,0.35);
  pointer-events: none;
  letter-spacing: 0.01em;
}
.hero-term__replay {
  background: none;
  border: none;
  cursor: pointer;
  color: rgba(255,255,255,0.25);
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.hero-term__replay:hover:not(:disabled) {
  color: rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.06);
}
.hero-term__replay:disabled { opacity: 0.3; cursor: default; }
.hero-term__body {
  padding: 16px 18px 20px;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hero-term__line {
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre;
  animation: termFadeIn 0.18s ease both;
}
@keyframes termFadeIn {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}
.hero-term__line--cmd  { color: rgba(255,255,255,0.92); font-weight: 600; }
.hero-term__line--info { color: rgba(255,255,255,0.38); }
.hero-term__line--ok   { color: #3fb950; }
.hero-term__line--warn { color: #d29922; }
.hero-term__cursor {
  display: inline-block;
  color: var(--gw-purple-light);
  animation: termBlink 1s step-end infinite;
  font-size: 14px;
  line-height: 1;
  margin-top: 4px;
}
@keyframes termBlink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}

/* ───────────────────────────────────────────
   10 PATTERNS GRID
─────────────────────────────────────────── */
.patterns-section {
  padding: 96px 0;
  background: var(--gw-bg-2);
  border-top: 1px solid var(--gw-border-soft);
}
.patterns-section .section-title { margin-bottom: 12px; }
.patterns-section .section-sub   { margin-bottom: 48px; }

.patterns-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.pat-card {
  background: var(--gw-surface);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  padding: 18px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.2s, transform 0.15s;
}
.pat-card:hover {
  border-color: var(--gw-purple);
  transform: translateY(-2px);
}
.pat-card--dim {
  opacity: 0.7;
  background: var(--gw-bg);
}
.pat-card--dim:hover { opacity: 1; }

.pat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pat-name {
  font-family: var(--vp-font-family-mono, monospace);
  font-size: 11.5px;
  color: var(--gw-purple-light);
  background: rgba(139, 92, 246, 0.1);
  border-radius: 4px;
  padding: 2px 6px;
  white-space: nowrap;
}
.pat-conf {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  border-radius: 3px;
  padding: 2px 6px;
  font-family: var(--vp-font-family-mono, monospace);
  flex-shrink: 0;
}
.pat-conf--certain { background: rgba(16,185,129,0.15); color: #10b981; }
.pat-conf--high    { background: rgba(59,130,246,0.15); color: #60a5fa; }
.pat-conf--medium  { background: rgba(245,158,11,0.15); color: #f59e0b; }
.pat-conf--low     { background: rgba(239,68,68,0.12);  color: #f87171; }

.pat-desc {
  font-size: 12.5px;
  color: var(--gw-text-muted);
  line-height: 1.6;
  margin: 0;
  flex: 1;
}
.pat-auto {
  font-size: 11px;
  font-weight: 600;
  font-family: var(--vp-font-family-mono, monospace);
}
.pat-auto--yes { color: #3fb950; }
.pat-auto--no  { color: rgba(255,255,255,0.3); }

/* ───────────────────────────────────────────
   TABBED FEATURES
─────────────────────────────────────────── */
.feat-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 28px;
  border-bottom: 1px solid var(--gw-border-soft);
  padding-bottom: 0;
  flex-wrap: wrap;
}
.feat-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 500;
  color: var(--gw-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
  border-radius: 6px 6px 0 0;
}
.feat-tab:hover { color: var(--gw-text); }
.feat-tab--active {
  color: var(--gw-text);
  border-bottom-color: var(--gw-purple);
  background: rgba(139, 92, 246, 0.05);
}
.feat-tab--highlight {
  color: var(--gw-purple-light);
}
.feat-tab--highlight.feat-tab--active {
  border-bottom-color: var(--gw-purple-light);
}

/* ───────────────────────────────────────────
   BENCHMARKS
─────────────────────────────────────────── */
.bench-section {
  padding: 96px 0;
  background: var(--gw-bg);
  border-top: 1px solid var(--gw-border-soft);
}
.bench-section .section-title { margin-bottom: 12px; }
.bench-section .section-sub   { margin-bottom: 48px; }

.bench-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.bench-card {
  background: var(--gw-surface);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  padding: 28px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.2s;
}
.bench-card:hover { border-color: var(--gw-purple); }

.bench-card--purple {
  border-color: rgba(139, 92, 246, 0.3);
  background: rgba(139, 92, 246, 0.04);
}
.bench-card--green {
  border-color: rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.04);
}

.bench-val {
  font-size: 2.6rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--gw-text);
  line-height: 1;
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.bench-card--purple .bench-val { color: var(--gw-purple-light); }
.bench-card--green  .bench-val { color: #10b981; }

.bench-unit {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--gw-text-muted);
  letter-spacing: 0;
}
.bench-label {
  font-size: 12px;
  color: var(--gw-text-muted);
  line-height: 1.5;
}

/* ───────────────────────────────────────────
   3 PILLARS (Wave 1)
─────────────────────────────────────────── */
.hl-pillars {
  padding: 72px 0 64px;
  background: var(--gw-bg);
  border-bottom: 1px solid var(--gw-border-soft);
}
.hl-pillars__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
  margin-top: 8px;
}
.hl-pillar {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px 26px 26px;
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  transition: border-color 0.2s, transform 0.15s, box-shadow 0.2s;
}
.hl-pillar:hover {
  border-color: var(--gw-purple);
  transform: translateY(-2px);
  box-shadow: 0 16px 32px -16px rgba(124, 58, 237, 0.35);
}
.hl-pillar__icon {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
}
.hl-pillar__icon--purple {
  color: var(--gw-purple-light);
  background: rgba(124, 58, 237, 0.12);
}
.hl-pillar__icon--green {
  color: var(--gw-green);
  background: rgba(16, 185, 129, 0.12);
}
.hl-pillar__icon--gradient {
  color: var(--gw-green);
  background: linear-gradient(135deg, rgba(124, 58, 237, 0.14), rgba(16, 185, 129, 0.16));
}
.hl-pillar__title {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--gw-text);
  line-height: 1.3;
}
.hl-pillar__sub {
  font-size: 14px;
  line-height: 1.6;
  color: var(--gw-text-muted);
  margin: 0;
}
.hl-pillar__stat {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-top: 12px;
  margin-top: auto;
  border-top: 1px dashed var(--gw-border-soft);
}
.hl-pillar__stat-n {
  font-size: 30px;
  font-weight: 800;
  line-height: 1;
  background: linear-gradient(135deg, var(--gw-purple-light), var(--gw-green));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -0.02em;
}
.hl-pillar__stat-n--small {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
}
.hl-pillar__stat-l {
  font-size: 12px;
  color: var(--gw-text-muted);
  line-height: 1.4;
}
.hl-pillar__cta {
  font-size: 13px;
  font-weight: 600;
  color: var(--gw-purple-light);
  text-decoration: none;
  align-self: flex-start;
  margin-top: 2px;
  transition: color 0.15s, transform 0.1s;
}
.hl-pillar__cta:hover {
  color: var(--gw-green);
  transform: translateX(2px);
}

/* ───────────────────────────────────────────
   "NEW IN v2.9" HIGHLIGHT BANNER (Wave 3)
─────────────────────────────────────────── */
.hl-new-release {
  padding: 56px 0 8px;
  background: var(--gw-bg);
}
.hl-new-release__inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 28px 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  flex-wrap: wrap;
  background: linear-gradient(135deg, rgba(124, 58, 237, 0.18) 0%, rgba(16, 185, 129, 0.08) 60%, transparent 100%);
  border: 1px solid rgba(124, 58, 237, 0.35);
  border-radius: var(--gw-radius);
  box-shadow: 0 8px 28px -16px rgba(124, 58, 237, 0.4);
}
.hl-new-release__copy {
  flex: 1 1 460px;
  min-width: 0;
}
.hl-new-release__badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(124, 58, 237, 0.22);
  color: #c4b5fd;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 10px;
}
.hl-new-release__title {
  font-size: clamp(20px, 2.6vw, 26px);
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--gw-text);
  letter-spacing: -0.01em;
}
.hl-new-release__sub {
  font-size: 14px;
  line-height: 1.55;
  color: var(--gw-text-muted);
  margin: 0;
  max-width: 64ch;
}
.hl-new-release__cta {
  flex-shrink: 0;
}
.hl-new-release__link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 11px 20px;
  background: var(--gw-purple);
  color: #fff;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
  transition: background 0.15s, transform 0.1s;
}
.hl-new-release__link:hover {
  background: var(--gw-purple-light);
  transform: translateY(-1px);
}

/* ───────────────────────────────────────────
   FEATURE TAB FADE TRANSITION (Wave 2)
─────────────────────────────────────────── */
.hl-tab-fade-enter-active,
.hl-tab-fade-leave-active {
  transition: opacity 180ms ease-out, transform 180ms ease-out;
}
.hl-tab-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.hl-tab-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
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
  .bench-grid { grid-template-columns: repeat(2, 1fr); }
  .patterns-grid { grid-template-columns: repeat(2, 1fr); }
  .hl-pillars__grid { grid-template-columns: 1fr; gap: 16px; }
  .hl-new-release__inner { flex-direction: column; align-items: flex-start; padding: 24px 26px; }
}
@media (max-width: 600px) {
  .features-grid { grid-template-columns: 1fr; }
  .hero { padding: 60px 0 40px; }
  .platforms-grid { flex-direction: column; align-items: center; }
  .bench-grid { grid-template-columns: 1fr; }
  .patterns-grid { grid-template-columns: 1fr; }
  .feat-tabs { gap: 2px; }
  .feat-tab { padding: 8px 12px; font-size: 12px; }
  .hero-term { max-width: 100%; }
  .hero-term__line { white-space: pre-wrap; word-break: break-all; }
  .hl-pillars { padding: 56px 0 48px; }
  .hl-pillar { padding: 22px 20px; }
  .hl-new-release__title { font-size: 19px; }
  .hl-new-release__sub { font-size: 13px; }
}
</style>
