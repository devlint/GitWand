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


// ── Resolution patterns (technical — not localised) ───────────────────────────
// 8 deterministic patterns auto-apply (auto: true). token_level_merge proposes
// a merge you confirm; refactoring_aware_merge and llm_proposed are opt-in;
// complex is the fallback that always hands the hunk back with its trace.
const PATTERNS = [
  { name: 'same_change',           conf: 'certain', auto: true,  desc: 'Both branches made the exact same edit.' },
  { name: 'one_side_change',       conf: 'certain', auto: true,  desc: 'Only one branch touched this block.' },
  { name: 'delete_no_change',      conf: 'certain', auto: true,  desc: 'One side deleted the block, the other left it untouched.' },
  { name: 'non_overlapping',       conf: 'high',    auto: true,  desc: 'Additions at different positions in the block.' },
  { name: 'whitespace_only',       conf: 'high',    auto: true,  desc: 'Same logic, different indentation or spacing.' },
  { name: 'reorder_only',          conf: 'high',    auto: true,  desc: 'Same lines, different order.' },
  { name: 'insertion_at_boundary', conf: 'high',    auto: true,  desc: 'New lines added at the edge of a hunk.' },
  { name: 'value_only_change',     conf: 'high',    auto: true,  desc: 'A scalar value (version, timestamp, hash) updated on both sides — keeps the higher semver / later timestamp.' },
  { name: 'token_level_merge',     conf: 'medium',  auto: false, desc: 'Both sides changed disjoint tokens on the same line — proposes a merge you confirm, never auto-applied.' },
  { name: 'refactoring_aware_merge', conf: 'high',  auto: false, desc: 'Rename/move detected and replayed across the conflict (opt-in).' },
  { name: 'llm_proposed',          conf: 'medium',  auto: false, desc: 'AI-proposed resolution, validated post-merge (opt-in).' },
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
const LATEST = '3.6.0'
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
    downloadUrl.value = `${RELEASES}/download/v${LATEST}/GitWand_${LATEST}_amd64.AppImage`
  setTimeout(runTerminalDemo, 900)
})

// ── Hero visual: CLI ⇄ GUI toggle (#71) ───────────────────────────────────
// The hero used to show only the terminal animation, which made GitWand read
// as a CLI-only tool. This tab lets visitors flip to the desktop GUI screenshot
// so the product's two faces are both visible above the fold. Defaults to the
// GUI — GitWand is first and foremost a desktop app, so lead with it.
const heroTab = ref<'cli' | 'gui'>('gui')

// ── Screenshot slideshow ───────────────────────────────────────────────────
const slides = [
  { src: '/screenshots/GitWand_dashboard.png',        alt: 'GitWand — dashboard' },
  { src: '/screenshots/GitWand_changes.png',          alt: 'GitWand — changes view' },
  { src: '/screenshots/GitWand_GitTree.png',          alt: 'GitWand — git commit tree' },
  { src: '/screenshots/GitWand_Branches_manager.png', alt: 'GitWand — branch manager' },
  { src: '/screenshots/GitWand_Worktree.png',         alt: 'GitWand — worktrees' },
  { src: '/screenshots/GitWand_settingAI.png',        alt: 'GitWand — AI settings' },
]
const slideIndex = ref(0)
function goToSlide(i: number) { slideIndex.value = i }
function prevSlide() { slideIndex.value = (slideIndex.value - 1 + slides.length) % slides.length }
function nextSlide() { slideIndex.value = (slideIndex.value + 1) % slides.length }

const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
function openLightbox(i: number) { lightboxIndex.value = i; lightboxOpen.value = true }
function closeLightbox() { lightboxOpen.value = false }
function lightboxPrev() { lightboxIndex.value = (lightboxIndex.value - 1 + slides.length) % slides.length }
function lightboxNext() { lightboxIndex.value = (lightboxIndex.value + 1) % slides.length }

onMounted(() => {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!lightboxOpen.value) return
    if (e.key === 'Escape') closeLightbox()
    else if (e.key === 'ArrowLeft') lightboxPrev()
    else if (e.key === 'ArrowRight') lightboxNext()
  })
})

// ── Destinations for the clickable platform cards (#71) ───────────────────
// Desktop cards point at the primary installer for each OS; asset names mirror
// the release bundle (verified against the GitHub release). CLI/VS Code cards
// point at their install homes. `${LATEST}` is kept in sync by bump-version.sh.
const dlMac = `${RELEASES}/download/v${LATEST}/GitWand_${LATEST}_universal.dmg`
const dlLinux = `${RELEASES}/download/v${LATEST}/GitWand_${LATEST}_amd64.AppImage`
const dlWin = `${RELEASES}/download/v${LATEST}/GitWand_${LATEST}_x64-setup.exe`

const i18n: Record<Locale, any> = {
  fr: {
    conflictCta: "Voir comment fonctionne le moteur →",
    trustStar: "Star sur GitHub",
    trustFree: "gratuit · open source",
    trustNative: "natif · sans Electron",
    trustDeterministic: "hallucination",
    whyTitle: "Déterministe là où les autres devinent",
    whySub: "Quatre raisons pour lesquelles GitWand n’est pas un client Git de plus.",
    why1t: "0 hallucination",
    why1d: "Un score de confiance et une trace de décision pour chaque hunk — jamais au hasard.",
    why2t: "Gratuit · MIT",
    why2d: "Entièrement open source. Pas de prix par siège, pas de mur d’essai, pas de compte.",
    why3t: "~8 Mo, natif",
    why3d: "Tauri 2 + Rust. Démarrage en moins d’une seconde, pas 150 Mo d’Electron.",
    why4t: "MCP pour les agents",
    why4d: "Votre moteur de résolution, à disposition de Claude Code, Cursor et tout client MCP.",
    miniCompareTitle: "GitWand face aux autres",
    miniCompareSub: "Là où il fait vraiment la différence par rapport aux clients populaires.",
    miniCompareCta: "Voir le comparatif complet →",
    mcRow1: "Résolution auto déterministe",
    mcRow2: "Gratuit / open source",
    mcRow3: "Natif (sans Electron)",
    mcRow4: "Serveur MCP pour agents",
    agentsCta: "Découvrir IA & agents →",
    heroAnnounce: "Nouveau dans la v3.6 — les conflits de rebase ne vous piègent plus derrière une fenêtre modale, et une invite de mise à jour de branche en un clic",
    heroPoint1: "8 patterns déterministes — zéro pari sur ton code",
    heroPoint2: "100 % local — ton code ne quitte jamais ta machine",
    heroPoint3: "Un seul moteur — Desktop, CLI, VS Code & agents IA",
    heroMeta: "Gratuit · sans compte · sans télémétrie",
    heroToastTitle: "57 hunks résolus automatiquement",
    heroToastSub: "1 à relire · 0 hallucination",
    contribYouName: "+ toi ?",
    contribYouRole: "Ouvre ta première PR",
    sponsorTitle: "Soutiens GitWand",
    sponsorSub: "GitWand est gratuit et open source. Un sponsoring GitHub finance le temps de développement et l'hébergement.",
    sponsorCta: "Devenir sponsor",
    heroH1a: "Les conflits de merge s'arrêtent ici.",
    heroH1b: "Retrouve ton flow.",
    heroSub: "Ce petit coup au moral quand 12 fichiers passent au rouge ? Terminé. GitWand classe chaque hunk avec 8 patterns déterministes — sans deviner, sans halluciner — résout les 95 % triviaux tout seul, et ne te rend que ce qui mérite ton cerveau. Natif, gratuit, MIT.",
    download: 'Télécharger',
    github: 'GitHub',
    whatsNew: 'Nouveautés v3.6',
    docs: 'Documentation →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'App desktop',
    heroGuiAlt: 'GitWand — tableau de bord du dépôt',
    heroVisualAria: 'Aperçu : CLI ou interface graphique',
    statPatterns: 'patterns de résolution',
    statResolved: 'conflits résolus automatiquement',
    statInterfaces: 'interfaces (Desktop, CLI, VS Code)',
    conflictTitle: "Regardez-le résoudre un conflit en une seconde",
    conflictSub: 'GitWand analyse la sémantique du code, pas seulement les lignes. Il choisit la bonne résolution à votre place.',
    conflictBefore: 'Avant — conflit brut',
    conflictAfter: 'Après — résolu automatiquement',
    conflictBadge: 'Confiance 97% · prefer-theirs · sémantique',
    previewTitle: "Un client Git que vous aurez envie d'ouvrir",
    previewSub: "Toutes les actions Git dans une seule fenêtre native et rapide — le graphe de commits, les diffs, les pull requests, les worktrees et ton inbox Today.",
    platformsTitle: 'Disponible partout',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Installeur .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: "Arrête d'arbitrer les conflits de merge.",
    ctaSub: "Gratuit, open source, natif. Télécharge GitWand et laisse le moteur prendre les 95 % ennuyeux.",
    ctaDownload: 'Télécharger GitWand',
    llmTitle: "Tes agents IA, avec un vrai moteur Git à portée de main",
    llmSub: "Les agents sont excellents pour le code et catastrophiques sur les merges. Le serveur MCP de GitWand résout les 95 % triviaux de façon déterministe et confie à ton agent les hunks difficiles avec tout le contexte — ours, theirs, base et la trace.",
    llmBadge: 'MCP Server · Registre officiel · stdio · Sans clé API',
    // 3 Pillars
    pillarsTitle: 'Trois piliers, une promesse',
    pillarsSub: "Des conflits résolus de façon déterministe, une performance vraiment native, et une IA qui n'intervient que si tu le demandes.",
    pillar1Title: 'Résolution auto de 95 % des conflits triviaux',
    pillar1Sub: '8 patterns déterministes. Score de confiance composite. Trace de décision pour chaque hunk.',
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
    faqTitle: 'Questions fréquentes',
    faqItems: [
      { q: 'GitWand est-il vraiment gratuit ?', a: 'Oui, GitWand est entièrement open source sous licence MIT. Vous pouvez l\'utiliser, le modifier et le redistribuer librement.' },
      { q: 'Comment fonctionne la résolution intelligente des conflits ?', a: 'GitWand analyse la sémantique du code avec 8 patterns déterministes (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orchestrés par un pattern registry (v1.4) et un scoring de confiance par hunk. Les conflits triviaux sont résolus automatiquement ; les cas complexes sont remontés avec une trace d\'explication complète.' },
      { q: 'Qu\'est-ce que le serveur MCP et pourquoi l\'utiliser ?', a: 'Le serveur MCP expose le moteur de GitWand aux agents IA — Claude Code, Cursor, Windsurf, et d\'autres. Il tourne en local via stdio, sans clé API ni accès réseau. GitWand gère 95%+ des conflits triviaux, l\'agent IA s\'occupe des cas ambigus avec tout le contexte nécessaire.' },
      { q: 'GitWand fonctionne-t-il avec n\'importe quel dépôt Git ?', a: 'Oui. GitWand fonctionne avec tous les dépôts Git locaux, quel que soit l\'hébergement (GitHub, GitLab, Bitbucket, Gitea…). La vue Pull Requests prend en charge GitHub, GitLab, Bitbucket et Azure DevOps.' },
      { q: 'Quelle est la différence avec les autres clients Git ?', a: 'GitWand se distingue par son moteur de résolution intégré, son architecture native Tauri (pas d\'Electron), ses 3 interfaces cohérentes (desktop, CLI, VS Code), et son serveur MCP pour l\'intégration avec les agents IA.' },
      { q: 'Comment installer le serveur MCP ?', a: 'Avec Claude Code, une seule commande suffit : claude mcp add gitwand -- npx -y @gitwand/mcp. Pour Claude Desktop, Cursor ou Windsurf, ajoutez le bloc mcpServers à la config de votre client (voir la documentation). Le serveur est aussi listé sur le registre officiel MCP, donc les clients qui parcourent le registre le trouvent automatiquement.' },
    ],
  },
  en: {
    conflictCta: "See how the engine works →",
    trustStar: "Star on GitHub",
    trustFree: "free · open source",
    trustNative: "native · no Electron",
    trustDeterministic: "hallucinations",
    whyTitle: "Deterministic where others guess",
    whySub: "Four reasons GitWand isn’t just another Git GUI.",
    why1t: "0 hallucinations",
    why1d: "A confidence score and a decision trace for every hunk — never a guess.",
    why2t: "Free · MIT",
    why2d: "Fully open source. No seat pricing, no trial wall, no account.",
    why3t: "~8 MB, native",
    why3d: "Tauri 2 + Rust. Sub-second start, not 150 MB of Electron.",
    why4t: "MCP for agents",
    why4d: "Your resolution engine, on tap for Claude Code, Cursor and any MCP client.",
    miniCompareTitle: "How GitWand compares",
    miniCompareSub: "Where it is genuinely different from the popular clients.",
    miniCompareCta: "See the full comparison →",
    mcRow1: "Deterministic auto-resolve",
    mcRow2: "Free / open source",
    mcRow3: "Native (no Electron)",
    mcRow4: "MCP server for agents",
    agentsCta: "Explore AI & agents →",
    heroAnnounce: "New in v3.6 — rebase conflicts no longer trap you behind a modal, plus a one-click branch update prompt",
    heroPoint1: "8 deterministic patterns — zero gambling with your code",
    heroPoint2: "100% local — your code never leaves your machine",
    heroPoint3: "One engine — Desktop, CLI, VS Code & AI agents",
    heroMeta: "Free · no account · no telemetry",
    heroToastTitle: "57 hunks auto-resolved",
    heroToastSub: "1 left for review · 0 hallucinations",
    contribYouName: "+ you?",
    contribYouRole: "Open your first PR",
    sponsorTitle: "Support GitWand",
    sponsorSub: "GitWand is free and open source. GitHub Sponsors funds development time and hosting.",
    sponsorCta: "Become a sponsor",
    heroH1a: "Merge conflicts end here.",
    heroH1b: "Get your flow back.",
    heroSub: "That sinking feeling when 12 files turn red? Gone. GitWand classifies every hunk with 8 deterministic patterns — no guessing, no hallucinations — auto-resolves the trivial 95%, and hands you only what's worth your brain. Native, free, MIT.",
    download: 'Download',
    github: 'GitHub',
    whatsNew: "What's new in v3.6",
    docs: 'Documentation →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'Desktop app',
    heroGuiAlt: 'GitWand — repository dashboard',
    heroVisualAria: 'Preview: CLI or graphical interface',
    statPatterns: 'resolution patterns',
    statResolved: 'conflicts auto-resolved',
    statInterfaces: 'interfaces (Desktop, CLI, VS Code)',
    conflictTitle: "See it resolve a conflict in one second",
    conflictSub: 'GitWand analyzes code semantics, not just lines. It picks the right resolution for you.',
    conflictBefore: 'Before — raw conflict',
    conflictAfter: 'After — auto-resolved',
    conflictBadge: 'Confidence 97% · prefer-theirs · semantic',
    previewTitle: "A Git client you'll actually want to open",
    previewSub: "Every Git action in one fast, native window — the commit graph, diffs, pull requests, worktrees, and your Today inbox.",
    platformsTitle: 'Available everywhere',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Installer .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: "Stop refereeing merge conflicts.",
    ctaSub: "Free, open source, native. Download GitWand and let the engine take the boring 95%.",
    ctaDownload: 'Download GitWand',
    llmTitle: "Your AI agents, with a real Git engine on tap",
    llmSub: "Agents are great at code and terrible at merges. GitWand's MCP server resolves the trivial 95% deterministically and hands your agent the hard hunks with full context — ours, theirs, base and the trace.",
    llmBadge: 'MCP Server · Official Registry · stdio · No API key',
    // 3 Pillars
    pillarsTitle: 'Three pillars, one promise',
    pillarsSub: "Conflicts resolved deterministically, performance that's actually native, and AI that only steps in when you ask.",
    pillar1Title: 'Auto-resolve 95% of trivial conflicts',
    pillar1Sub: '8 deterministic patterns. Composite confidence scoring. Decision traces for every hunk.',
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
    faqTitle: 'Frequently asked questions',
    faqItems: [
      { q: 'Is GitWand really free?', a: 'Yes, GitWand is fully open source under the MIT license. You can use, modify, and redistribute it freely.' },
      { q: 'How does smart conflict resolution work?', a: 'GitWand analyzes code semantics using 8 deterministic patterns (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orchestrated by a pattern registry (v1.4) with per-hunk confidence scoring. Trivial conflicts are resolved automatically; complex cases are surfaced with a full explanation trace.' },
      { q: 'What is the MCP server and why use it?', a: 'The MCP server exposes GitWand\'s engine to AI agents — Claude Code, Cursor, Windsurf, and others. It runs locally over stdio, with no API key or network access required. GitWand handles 95%+ of trivial conflicts; the AI agent tackles the ambiguous ones with full context.' },
      { q: 'Does GitWand work with any Git repository?', a: 'Yes. GitWand works with any local Git repository, regardless of hosting (GitHub, GitLab, Bitbucket, Gitea…). The Pull Request view supports GitHub, GitLab, Bitbucket, and Azure DevOps.' },
      { q: 'What sets GitWand apart from other Git clients?', a: 'GitWand stands out with its built-in resolution engine, native Tauri architecture (no Electron), three consistent interfaces (desktop, CLI, VS Code), and an MCP server for AI agent integration.' },
      { q: 'How do I install the MCP server?', a: 'With Claude Code, a single command is enough: claude mcp add gitwand -- npx -y @gitwand/mcp. For Claude Desktop, Cursor, or Windsurf, add the mcpServers block to your client config (see the docs). The server is also listed on the official MCP Registry, so clients that browse the registry discover it automatically.' },
    ],
  },
  es: {
    conflictCta: "Ver cómo funciona el motor →",
    trustStar: "Dale una estrella en GitHub",
    trustFree: "gratis · open source",
    trustNative: "nativo · sin Electron",
    trustDeterministic: "alucinaciones",
    whyTitle: "Determinista donde otros adivinan",
    whySub: "Cuatro razones por las que GitWand no es un cliente Git más.",
    why1t: "0 alucinaciones",
    why1d: "Una puntuación de confianza y una traza de decisión para cada hunk — nunca a ciegas.",
    why2t: "Gratis · MIT",
    why2d: "Totalmente open source. Sin precio por asiento, sin muro de prueba, sin cuenta.",
    why3t: "~8 MB, nativo",
    why3d: "Tauri 2 + Rust. Arranque en menos de un segundo, no 150 MB de Electron.",
    why4t: "MCP para agentes",
    why4d: "Tu motor de resolución, disponible para Claude Code, Cursor y cualquier cliente MCP.",
    miniCompareTitle: "GitWand frente a los demás",
    miniCompareSub: "Donde realmente marca la diferencia frente a los clientes populares.",
    miniCompareCta: "Ver la comparativa completa →",
    mcRow1: "Auto-resolución determinista",
    mcRow2: "Gratis / open source",
    mcRow3: "Nativo (sin Electron)",
    mcRow4: "Servidor MCP para agentes",
    agentsCta: "Explorar IA y agentes →",
    heroAnnounce: "Nuevo en la v3.6 — los conflictos de rebase ya no te atrapan detrás de un modal, más un aviso de actualización de rama con un clic",
    heroPoint1: "8 patrones deterministas — cero apuestas con tu código",
    heroPoint2: "100 % local — tu código nunca sale de tu máquina",
    heroPoint3: "Un solo motor — Desktop, CLI, VS Code y agentes de IA",
    heroMeta: "Gratis · sin cuenta · sin telemetría",
    heroToastTitle: "57 hunks resueltos automáticamente",
    heroToastSub: "1 por revisar · 0 alucinaciones",
    contribYouName: "+ ¿tú?",
    contribYouRole: "Abre tu primera PR",
    sponsorTitle: "Apoya a GitWand",
    sponsorSub: "GitWand es gratis y open source. GitHub Sponsors financia el tiempo de desarrollo y el hosting.",
    sponsorCta: "Ser sponsor",
    heroH1a: "Los conflictos de merge terminan aquí.",
    heroH1b: "Recupera tu flow.",
    heroSub: "¿Esa sensación de vacío cuando 12 archivos se ponen en rojo? Se acabó. GitWand clasifica cada hunk con 8 patrones deterministas — sin adivinar, sin alucinar — resuelve solo el 95 % trivial y te entrega únicamente lo que merece tu cerebro. Nativo, gratis, MIT.",
    download: 'Descargar',
    github: 'GitHub',
    whatsNew: 'Novedades v3.6',
    docs: 'Documentación →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'App de escritorio',
    heroGuiAlt: 'GitWand — panel del repositorio',
    heroVisualAria: 'Vista previa: CLI o interfaz gráfica',
    statPatterns: 'patrones de resolución',
    statResolved: 'conflictos resueltos automáticamente',
    statInterfaces: 'interfaces (Escritorio, CLI, VS Code)',
    conflictTitle: "Míralo resolver un conflicto en un segundo",
    conflictSub: 'GitWand analiza la semántica del código, no solo las líneas. Elige la resolución correcta por ti.',
    conflictBefore: 'Antes — conflicto en bruto',
    conflictAfter: 'Después — resuelto automáticamente',
    conflictBadge: 'Confianza 97 % · prefer-theirs · semántico',
    previewTitle: "Un cliente Git que querrás abrir",
    previewSub: "Todas las acciones de Git en una única ventana nativa y rápida — el grafo de commits, los diffs, las pull requests, los worktrees y tu inbox Today.",
    platformsTitle: 'Disponible en todas partes',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Instalador .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Marketplace de extensiones',
    ctaTitle: "Deja de arbitrar los conflictos de merge.",
    ctaSub: "Gratis, open source, nativo. Descarga GitWand y deja que el motor se encargue del 95 % aburrido.",
    ctaDownload: 'Descargar GitWand',
    llmTitle: "Tus agentes IA, con un motor Git de verdad a mano",
    llmSub: "Los agentes son geniales con el código y pésimos con los merges. El servidor MCP de GitWand resuelve el 95 % trivial de forma determinista y le pasa a tu agente los hunks difíciles con todo el contexto — ours, theirs, base y la traza.",
    llmBadge: 'Servidor MCP · Registro oficial · stdio · Sin clave API',
    // 3 Pillars
    pillarsTitle: 'Tres pilares, una promesa',
    pillarsSub: "Conflictos resueltos de forma determinista, rendimiento realmente nativo, e IA que solo interviene cuando se lo pides.",
    pillar1Title: 'Resuelve automáticamente el 95 % de los conflictos triviales',
    pillar1Sub: '8 patrones deterministas. Puntuación de confianza compuesta. Traza de decisión para cada hunk.',
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
    faqTitle: 'Preguntas frecuentes',
    faqItems: [
      { q: '¿GitWand es realmente gratis?', a: 'Sí, GitWand es totalmente open source bajo licencia MIT. Puedes usarlo, modificarlo y redistribuirlo libremente.' },
      { q: '¿Cómo funciona la resolución inteligente de conflictos?', a: 'GitWand analiza la semántica del código con 8 patrones deterministas (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orquestados por un pattern registry (v1.4) y una puntuación de confianza por hunk. Los conflictos triviales se resuelven automáticamente; los casos complejos se presentan con una traza de explicación completa.' },
      { q: '¿Qué es el servidor MCP y por qué usarlo?', a: 'El servidor MCP expone el motor de GitWand a los agentes IA — Claude Code, Cursor, Windsurf y otros. Funciona en local vía stdio, sin clave API ni acceso a la red. GitWand gestiona el 95 %+ de los conflictos triviales; el agente IA se ocupa de los casos ambiguos con todo el contexto necesario.' },
      { q: '¿GitWand funciona con cualquier repositorio Git?', a: 'Sí. GitWand funciona con cualquier repositorio Git local, sea cual sea el hosting (GitHub, GitLab, Bitbucket, Gitea…). La vista de Pull Requests es compatible con GitHub, GitLab, Bitbucket y Azure DevOps.' },
      { q: '¿Qué lo diferencia de otros clientes Git?', a: 'GitWand destaca por su motor de resolución integrado, su arquitectura nativa Tauri (sin Electron), sus 3 interfaces coherentes (escritorio, CLI, VS Code) y su servidor MCP para la integración con agentes IA.' },
      { q: '¿Cómo se instala el servidor MCP?', a: 'Con Claude Code basta un solo comando: claude mcp add gitwand -- npx -y @gitwand/mcp. Para Claude Desktop, Cursor o Windsurf, añade el bloque mcpServers a la configuración de tu cliente (ver la documentación). El servidor también está listado en el registro oficial MCP, así que los clientes que exploran el registro lo encuentran automáticamente.' },
    ],
  },
  'pt-BR': {
    conflictCta: "Ver como o motor funciona →",
    trustStar: "Dê uma estrela no GitHub",
    trustFree: "gratuito · open source",
    trustNative: "nativo · sem Electron",
    trustDeterministic: "alucinações",
    whyTitle: "Determinista onde os outros chutam",
    whySub: "Quatro motivos pelos quais o GitWand não é só mais um cliente Git.",
    why1t: "0 alucinações",
    why1d: "Um score de confiança e um trace de decisão para cada hunk — nunca no chute.",
    why2t: "Gratuito · MIT",
    why2d: "Totalmente open source. Sem preço por assento, sem muro de teste, sem conta.",
    why3t: "~8 MB, nativo",
    why3d: "Tauri 2 + Rust. Inicialização em menos de um segundo, não 150 MB de Electron.",
    why4t: "MCP para agentes",
    why4d: "Seu motor de resolução, à disposição do Claude Code, Cursor e qualquer cliente MCP.",
    miniCompareTitle: "GitWand frente aos demais",
    miniCompareSub: "Onde ele realmente se diferencia dos clientes populares.",
    miniCompareCta: "Ver a comparação completa →",
    mcRow1: "Auto-resolução determinista",
    mcRow2: "Gratuito / open source",
    mcRow3: "Nativo (sem Electron)",
    mcRow4: "Servidor MCP para agentes",
    agentsCta: "Explorar IA e agentes →",
    heroAnnounce: "Novidade na v3.6 — conflitos de rebase não prendem mais você atrás de um modal, além de um aviso de atualização de branch com um clique",
    heroPoint1: "8 padrões deterministas — zero aposta com seu código",
    heroPoint2: "100 % local — seu código nunca sai da sua máquina",
    heroPoint3: "Um único motor — Desktop, CLI, VS Code e agentes de IA",
    heroMeta: "Gratuito · sem conta · sem telemetria",
    heroToastTitle: "57 hunks resolvidos automaticamente",
    heroToastSub: "1 para revisar · 0 alucinações",
    contribYouName: "+ você?",
    contribYouRole: "Abra sua primeira PR",
    sponsorTitle: "Apoie o GitWand",
    sponsorSub: "GitWand é gratuito e open source. O GitHub Sponsors financia o tempo de desenvolvimento e a hospedagem.",
    sponsorCta: "Ser sponsor",
    heroH1a: "Conflitos de merge terminam aqui.",
    heroH1b: "Recupere seu flow.",
    heroSub: "Aquele frio na barriga quando 12 arquivos ficam vermelhos? Acabou. O GitWand classifica cada hunk com 8 padrões deterministas — sem chutar, sem alucinar — resolve os 95 % triviais sozinho e devolve só o que merece seu cérebro. Nativo, gratuito, MIT.",
    download: 'Baixar',
    github: 'GitHub',
    whatsNew: 'Novidades v3.6',
    docs: 'Documentação →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'App desktop',
    heroGuiAlt: 'GitWand — painel do repositório',
    heroVisualAria: 'Prévia: CLI ou interface gráfica',
    statPatterns: 'padrões de resolução',
    statResolved: 'conflitos resolvidos automaticamente',
    statInterfaces: 'interfaces (Desktop, CLI, VS Code)',
    conflictTitle: "Veja-o resolver um conflito em um segundo",
    conflictSub: 'GitWand analisa a semântica do código, não apenas as linhas. Ele escolhe a resolução certa por você.',
    conflictBefore: 'Antes — conflito bruto',
    conflictAfter: 'Depois — resolvido automaticamente',
    conflictBadge: 'Confiança 97 % · prefer-theirs · semântico',
    previewTitle: "Um cliente Git que você vai querer abrir",
    previewSub: "Todas as ações do Git em uma única janela nativa e rápida — o grafo de commits, diffs, pull requests, worktrees e sua inbox Today.",
    platformsTitle: 'Disponível em todo lugar',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: 'Instalador .exe · .msi',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: "Pare de arbitrar conflitos de merge.",
    ctaSub: "Gratuito, open source, nativo. Baixe o GitWand e deixe o motor cuidar dos 95 % chatos.",
    ctaDownload: 'Baixar o GitWand',
    llmTitle: "Seus agentes de IA, com um motor Git de verdade à mão",
    llmSub: "Agentes são ótimos com código e péssimos com merges. O servidor MCP do GitWand resolve os 95 % triviais de forma determinista e entrega ao seu agente os hunks difíceis com todo o contexto — ours, theirs, base e o trace.",
    llmBadge: 'Servidor MCP · Registro oficial · stdio · Sem chave de API',
    // 3 Pillars
    pillarsTitle: 'Três pilares, uma promessa',
    pillarsSub: "Conflitos resolvidos de forma determinista, desempenho realmente nativo e IA que só entra quando você pede.",
    pillar1Title: 'Resolva 95% dos conflitos triviais automaticamente',
    pillar1Sub: '8 padrões deterministas. Score de confiança composto. Trace de decisão em cada hunk.',
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
    faqTitle: 'Perguntas frequentes',
    faqItems: [
      { q: 'O GitWand é realmente gratuito?', a: 'Sim, o GitWand é totalmente open source sob licença MIT. Você pode usar, modificar e redistribuir livremente.' },
      { q: 'Como funciona a resolução inteligente de conflitos?', a: 'O GitWand analisa a semântica do código com 8 padrões deterministas (whitespace_only, same_change, one_side_change, reorder_only, insertion_at_boundary…) orquestrados por um pattern registry (v1.4) e pontuação de confiança por hunk. Conflitos triviais são resolvidos automaticamente; casos complexos são apresentados com trace de explicação completo.' },
      { q: 'O que é o servidor MCP e por que usá-lo?', a: 'O servidor MCP expõe o motor do GitWand a agentes de IA — Claude Code, Cursor, Windsurf e outros. Roda localmente via stdio, sem chave de API nem acesso à rede. O GitWand cuida de 95 %+ dos conflitos triviais; o agente de IA lida com os ambíguos com todo o contexto necessário.' },
      { q: 'O GitWand funciona com qualquer repositório Git?', a: 'Sim. O GitWand funciona com qualquer repositório Git local, independente do hosting (GitHub, GitLab, Bitbucket, Gitea…). A view de Pull Requests é compatível com GitHub, GitLab, Bitbucket e Azure DevOps.' },
      { q: 'Qual é a diferença para outros clientes Git?', a: 'O GitWand se destaca pelo motor de resolução integrado, arquitetura nativa Tauri (sem Electron), 3 interfaces coerentes (desktop, CLI, VS Code) e servidor MCP para integração com agentes de IA.' },
      { q: 'Como instalar o servidor MCP?', a: 'Com Claude Code basta um único comando: claude mcp add gitwand -- npx -y @gitwand/mcp. Para Claude Desktop, Cursor ou Windsurf, adicione o bloco mcpServers à configuração do seu cliente (veja a documentação). O servidor também está listado no registro oficial MCP, então clientes que navegam o registro o encontram automaticamente.' },
    ],
  },
  'zh-CN': {
    conflictCta: "了解引擎如何工作 →",
    trustStar: "在 GitHub 上加星",
    trustFree: "免费 · 开源",
    trustNative: "原生 · 无 Electron",
    trustDeterministic: "幻觉",
    whyTitle: "别人靠猜，它靠确定性",
    whySub: "GitWand 不只是又一个 Git 客户端的四个理由。",
    why1t: "0 幻觉",
    why1d: "每个 hunk 都有置信度评分和决策追踪 — 从不靠猜。",
    why2t: "免费 · MIT",
    why2d: "完全开源。没有按席位收费，没有试用墙，无需账号。",
    why3t: "~8 MB，原生",
    why3d: "Tauri 2 + Rust。亚秒级启动，而非 150 MB 的 Electron。",
    why4t: "面向代理的 MCP",
    why4d: "你的解决引擎，随时供 Claude Code、Cursor 及任意 MCP 客户端调用。",
    miniCompareTitle: "GitWand 与其他客户端对比",
    miniCompareSub: "与热门客户端相比，它真正不同之处。",
    miniCompareCta: "查看完整对比 →",
    mcRow1: "确定性自动解决",
    mcRow2: "免费 / 开源",
    mcRow3: "原生（无 Electron）",
    mcRow4: "面向代理的 MCP 服务器",
    agentsCta: "探索 AI 与代理 →",
    heroAnnounce: "v3.6 新功能 — rebase 冲突不再把你困在弹窗后面，还带来一键分支更新提示",
    heroPoint1: "8 种确定性模式 — 绝不拿你的代码赌运气",
    heroPoint2: "100% 本地运行 — 代码永不离开你的机器",
    heroPoint3: "一个引擎 — 桌面端、CLI、VS Code 与 AI 代理",
    heroMeta: "免费 · 无需账号 · 无遥测",
    heroToastTitle: "57 个 hunk 已自动解决",
    heroToastSub: "1 个待复查 · 0 幻觉",
    contribYouName: "+ 你？",
    contribYouRole: "提交你的第一个 PR",
    sponsorTitle: "支持 GitWand",
    sponsorSub: "GitWand 免费且开源。GitHub Sponsors 资助开发时间与托管费用。",
    sponsorCta: "成为赞助者",
    heroH1a: "合并冲突，到此为止。",
    heroH1b: "找回你的心流。",
    heroSub: "12 个文件同时变红的那种心凉？不会再有。GitWand 用 8 种确定性模式分类每个 hunk——不猜测、无幻觉——自动解决 95% 的简单冲突，只把真正值得你思考的部分交还给你。原生、免费、MIT。",
    download: '下载',
    github: 'GitHub',
    whatsNew: 'v3.6 新特性',
    docs: '文档 →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: '命令行',
    heroTabGui: '桌面应用',
    heroGuiAlt: 'GitWand — 仓库仪表盘',
    heroVisualAria: '预览：命令行或图形界面',
    statPatterns: '种解决模式',
    statResolved: '冲突自动解决',
    statInterfaces: '种界面(桌面端、CLI、VS Code)',
    conflictTitle: "看它一秒解决一个冲突",
    conflictSub: 'GitWand 分析代码语义,而不仅仅是文本行。它为你挑选正确的解决方案。',
    conflictBefore: '之前 — 原始冲突',
    conflictAfter: '之后 — 自动解决',
    conflictBadge: '置信度 97% · prefer-theirs · 语义化',
    previewTitle: "一个你真正想打开的 Git 客户端",
    previewSub: "所有 Git 操作集于一个快速的原生窗口——提交图谱、diff、pull request、worktree,以及你的 Today 收件箱。",
    platformsTitle: '处处可用',
    plMacSub: 'Intel + Apple Silicon',
    plLinuxSub: '.deb · .AppImage · .rpm',
    plWinSub: '.exe · .msi 安装程序',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: '扩展市场',
    ctaTitle: "别再当合并冲突的裁判了。",
    ctaSub: "免费、开源、原生。下载 GitWand,把无聊的 95% 交给引擎。",
    ctaDownload: '下载 GitWand',
    llmTitle: "让你的 AI 代理,随时用上真正的 Git 引擎",
    llmSub: "代理擅长写代码,却搞不定合并。GitWand 的 MCP 服务器以确定性方式解决 95% 的简单冲突,并把困难的 hunk 连同完整上下文——ours、theirs、base 和追踪——交给你的代理。",
    llmBadge: 'MCP 服务器 · 官方注册表 · stdio · 无需 API 密钥',
    // 3 Pillars
    pillarsTitle: '三大支柱,一个承诺',
    pillarsSub: "以确定性方式解决冲突、真正原生的性能，以及只有你需要时才介入的 AI。",
    pillar1Title: '自动解决 95% 的简单冲突',
    pillar1Sub: '8 种确定性模式。组合式置信度评分。每个 hunk 都有决策追踪。',
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
    // 最新特性横幅
    faqTitle: '常见问题',
    faqItems: [
      { q: 'GitWand 真的免费吗?', a: '是的,GitWand 在 MIT 许可下完全开源。你可以自由使用、修改和分发。' },
      { q: '智能冲突解决是如何工作的?', a: 'GitWand 使用 8 种确定性模式(whitespace_only、same_change、one_side_change、reorder_only、insertion_at_boundary…)分析代码语义,由模式注册表(v1.4)进行编排,并对每个 hunk 打出置信度评分。简单冲突自动解决;复杂情况会附上完整的解释追踪呈现出来。' },
      { q: 'MCP 服务器是什么?为什么要用?', a: 'MCP 服务器将 GitWand 的引擎开放给 AI 代理 — Claude Code、Cursor、Windsurf 等。通过 stdio 在本地运行,无需 API 密钥,也不需要网络访问。GitWand 处理 95%+ 的简单冲突;AI 代理则在完整上下文下应对模糊情况。' },
      { q: 'GitWand 适用于任何 Git 仓库吗?', a: '是的。GitWand 适用于任何本地 Git 仓库,无论托管在哪里(GitHub、GitLab、Bitbucket、Gitea…)。Pull Requests 视图支持 GitHub、GitLab、Bitbucket 和 Azure DevOps。' },
      { q: '与其他 Git 客户端有什么区别?', a: 'GitWand 的亮点在于内置的解决引擎、原生的 Tauri 架构(非 Electron)、3 种一致的界面(桌面端、CLI、VS Code),以及用于 AI 代理集成的 MCP 服务器。' },
      { q: '如何安装 MCP 服务器?', a: '使用 Claude Code 一条命令即可:claude mcp add gitwand -- npx -y @gitwand/mcp。对于 Claude Desktop、Cursor 或 Windsurf,将 mcpServers 块添加到你的客户端配置(见文档)。该服务器也已列入官方 MCP 注册表,浏览注册表的客户端会自动发现它。' },
    ],
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
  { label: 'CLI tool',                 gw: true,      ghd: false,     gk: true,      fork: false,   tower: false,  sm: false },
  { label: 'VS Code extension',        gw: true,      ghd: false,     gk: true,      fork: false,   tower: false,  sm: false },

  { category: true, label: 'Diff & Staging' },
  { label: 'Syntax highlighting',      gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Hunk-level staging',       gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Line-level staging',       gw: true,      ghd: true,      gk: 'partial', fork: 'partial', tower: true, sm: false },
  { label: 'Side-by-side diff',        gw: true,      ghd: true,      gk: true,      fork: true,    tower: true,   sm: true  },
  { label: 'Image diff (visual)',      gw: true,      ghd: false,     gk: false,     fork: true,    tower: true,   sm: true  },
  { label: 'Folder tree diff',         gw: true,      ghd: false,     gk: false,     fork: false,   tower: false,  sm: false },

  { category: true, label: 'Conflict Resolution' },
  { label: 'Auto-resolve conflicts',        gw: true, ghd: false, gk: 'partial', fork: false, tower: false, sm: false, highlight: true },
  { label: 'Confidence scoring per hunk',   gw: true, ghd: false, gk: true,      fork: false, tower: false, sm: false, highlight: true },
  { label: '3-way merge editor',            gw: true, ghd: false, gk: true,      fork: true,  tower: true,  sm: true  },
  { label: 'Zero-impact merge / rebase preview', gw: true, ghd: false, gk: 'partial', fork: false, tower: false, sm: false, highlight: true },
  { label: 'Predict rebase & cherry-pick conflicts', gw: true, ghd: false, gk: 'partial', fork: 'partial', tower: false, sm: false, highlight: true },
  { label: 'Scratch worktree for isolated resolution', gw: true, ghd: false, gk: false, fork: false, tower: false, sm: false, highlight: true },
  { label: 'Proactive conflict prevention', gw: true, ghd: false, gk: 'partial', fork: 'partial', tower: 'partial', sm: false },
  { label: 'Conflict validation feedback (residual markers, parse errors)', gw: true, ghd: false, gk: false, fork: false, tower: false, sm: false, highlight: true },

  { category: true, label: 'Power Git' },
  { label: 'Interactive rebase',            gw: true, ghd: 'partial', gk: true, fork: true, tower: true, sm: true  },
  { label: 'Worktrees',                     gw: true, ghd: false,     gk: true,  fork: true,  tower: true, sm: false },
  { label: 'Submodule management',          gw: true, ghd: false,     gk: true,  fork: true,  tower: true, sm: true  },
  { label: 'Split commit by hunks',         gw: true, ghd: false,     gk: false, fork: false, tower: false, sm: false },
  { label: 'File blame + line-range',       gw: true, ghd: false,     gk: true,  fork: true,  tower: true, sm: true  },
  { label: 'Conventional commits',          gw: true, ghd: false,     gk: false, fork: false, tower: false, sm: false },
  { label: 'Multi-repo workspaces',         gw: true, ghd: false,     gk: true,  fork: true,  tower: 'partial', sm: false },
  { label: 'Cross-repo dashboard',          gw: true, ghd: false,     gk: true,  fork: false, tower: false,     sm: false },

  { category: true, label: 'Forge integrations' },
  { label: 'GitHub PRs',                    gw: true,   ghd: true,  gk: true,  fork: 'partial', tower: 'partial', sm: false },
  { label: 'GitLab MRs',                    gw: true,   ghd: false, gk: true,  fork: false,     tower: 'partial', sm: false },
  { label: 'Bitbucket PRs',                 gw: true,   ghd: false, gk: true,  fork: false,     tower: 'partial', sm: false },
  { label: 'Azure DevOps PRs',              gw: true,   ghd: false, gk: true,  fork: false,     tower: 'partial', sm: false },
  { label: 'Git hooks manager',             gw: 'partial', ghd: 'partial', gk: false, fork: false,   tower: false,     sm: false },

  { category: true, label: 'AI & Agents', note: 'GitWand connects to your own LLM — Claude, OpenAI-compatible, or Ollama. No built-in model.' },
  { label: 'AI commit messages',            gw: true,   ghd: true,      gk: true,      fork: true,      tower: true,  sm: false },
  { label: 'AI conflict explanation',       gw: true,   ghd: false,     gk: 'partial', fork: false,     tower: false, sm: false, highlight: true },
  { label: 'AI PR description',             gw: true,   ghd: false,     gk: true,      fork: false,     tower: false, sm: false },
  { label: 'MCP server for AI agents',      gw: true,   ghd: false,     gk: true,      fork: false,     tower: false, sm: false },
  { label: 'PR activity notifications',     gw: true,   ghd: false,     gk: true,      fork: false,     tower: false, sm: false },
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
         1 · HERO
    ══════════════════════════════════════ -->
    <section class="hero">
      <!-- Ambient depth layers: dot grid + aurora glows (pure CSS, decorative) -->
      <div class="hero-bg" aria-hidden="true">
        <div class="hero-bg__grid"></div>
        <div class="hero-bg__orb hero-bg__orb--purple"></div>
        <div class="hero-bg__orb hero-bg__orb--green"></div>
      </div>
      <div class="hero-inner">

        <!-- Left: text -->
        <div class="hero-text">
          <a class="hero-announce" href="/changelog">
            <span class="hero-announce__dot"></span>
            <span class="hero-announce__txt">{{ t.heroAnnounce }}</span>
            <span class="hero-announce__arrow">→</span>
          </a>
          <h1 class="hero-h1">
            {{ t.heroH1a }}<br>
            <span class="gradient">{{ t.heroH1b }}</span>
          </h1>
          <p class="hero-sub">
            {{ t.heroSub }}
          </p>
          <ul class="hero-points">
            <li v-for="p in [t.heroPoint1, t.heroPoint2, t.heroPoint3]" :key="p" class="hero-point">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.4" opacity="0.35"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span>{{ p }}</span>
            </li>
          </ul>
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
          <p class="hero-platforms">{{ t.platforms }}<span class="hero-meta"> · {{ t.heroMeta }}</span></p>
        </div>

        <!-- Right: CLI ⇄ GUI toggle — GitWand is both a desktop app and a CLI -->
        <div class="hero-visual">
          <div class="hero-tabs" role="tablist" :aria-label="t.heroVisualAria">
            <button
              class="hero-tab" :class="{ 'hero-tab--active': heroTab === 'gui' }"
              role="tab" :aria-selected="heroTab === 'gui'" @click="heroTab = 'gui'"
            >{{ t.heroTabGui }}</button>
            <button
              class="hero-tab" :class="{ 'hero-tab--active': heroTab === 'cli' }"
              role="tab" :aria-selected="heroTab === 'cli'" @click="heroTab = 'cli'"
            >{{ t.heroTabCli }}</button>
          </div>

          <div class="hero-stage">
          <!-- GUI: desktop dashboard screenshot -->
          <div class="hero-gui" :class="{ 'hero-pane--hidden': heroTab !== 'gui' }" role="tabpanel" :aria-hidden="heroTab !== 'gui'">
            <img
              src="/screenshots/GitWand_dashboard.png" :alt="t.heroGuiAlt"
              class="hero-gui__img" width="1842" height="931"
              loading="lazy" decoding="async"
            />
            <!-- Floating proof card: the engine's outcome, in one glance -->
            <div class="hero-toast" aria-hidden="true">
              <span class="hero-toast__icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </span>
              <span class="hero-toast__body">
                <span class="hero-toast__title">{{ t.heroToastTitle }}</span>
                <span class="hero-toast__sub">{{ t.heroToastSub }}</span>
              </span>
            </div>
          </div>

          <!-- CLI: terminal animation -->
          <div class="hero-term" :class="{ 'hero-pane--hidden': heroTab !== 'cli' }" role="tabpanel" :aria-hidden="heroTab !== 'cli'">
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
      </div>
    </section>

    <!-- ══════════════════════════════════════
         2 · STATS BAR
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
         3 · TRUST BAR
    ══════════════════════════════════════ -->
    <section class="trust-bar">
      <a class="trust-item trust-item--link" href="https://github.com/devlint/GitWand" target="_blank" rel="noopener">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2l2.9 6.3 6.6.6-5 4.4 1.5 6.6L12 17.8 5.5 20.5 7 13.9l-5-4.4 6.6-.6L12 2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <span class="trust-txt">{{ t.trustStar }}</span>
      </a>
      <div class="trust-item"><span class="trust-strong">MIT</span><span class="trust-txt">{{ t.trustFree }}</span></div>
      <div class="trust-item"><span class="trust-strong">~8&nbsp;MB</span><span class="trust-txt">{{ t.trustNative }}</span></div>
      <div class="trust-item"><span class="trust-strong">0</span><span class="trust-txt">{{ t.trustDeterministic }}</span></div>
    </section>

    <!-- ══════════════════════════════════════
         4 · CONFLICT DEMO — the "aha" moment
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
        <div class="section-cta-row">
          <a href="/conflict-engine" class="btn-ghost">{{ t.conflictCta }}</a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         5 · 3 DOORS (pillars → pillar pages)
    ══════════════════════════════════════ -->
    <section class="hl-pillars">
      <div class="section-inner">
        <h2 class="section-title">{{ t.pillarsTitle }}</h2>
        <p class="section-sub">{{ t.pillarsSub }}</p>
        <div class="hl-pillars__grid">
          <!-- Pillar 1 — Conflict resolution -->
          <a class="hl-pillar hl-pillar--link" href="/conflict-engine">
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
            <span class="hl-pillar__cta">{{ t.pillar1Cta }}</span>
          </a>

          <!-- Pillar 2 — Native performance -->
          <a class="hl-pillar hl-pillar--link" href="/features">
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
            <span class="hl-pillar__cta">{{ t.pillar2Cta }}</span>
          </a>

          <!-- Pillar 3 — AI assists -->
          <a class="hl-pillar hl-pillar--link" href="/ai-agents">
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
            <span class="hl-pillar__cta">{{ t.pillar3Cta }}</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         6 · SHOW THE INTERFACE (slideshow, moved up)
    ══════════════════════════════════════ -->
    <section class="preview-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.previewTitle }}</h2>
        <p class="section-sub">{{ t.previewSub }}</p>

        <div class="preview-slideshow preview-window">
          <button class="slideshow-arrow slideshow-arrow--prev" @click="prevSlide" aria-label="Previous screenshot">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="slideshow-track" :style="{ transform: `translateX(-${slideIndex * 100}%)` }">
            <img
              v-for="(slide, i) in slides"
              :key="i"
              :src="slide.src"
              :alt="slide.alt"
              class="slideshow-img"
              @click="openLightbox(i)"
            />
          </div>
          <button class="slideshow-arrow slideshow-arrow--next" @click="nextSlide" aria-label="Next screenshot">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <div class="slideshow-dots">
          <button
            v-for="(_, i) in slides"
            :key="i"
            :class="['slideshow-dot', { 'slideshow-dot--active': i === slideIndex }]"
            @click="goToSlide(i)"
            :aria-label="`Screenshot ${i + 1}`"
          />
        </div>

        <Teleport to="body">
          <div v-if="lightboxOpen" class="lightbox-overlay" @click.self="closeLightbox">
            <button class="lightbox-close" @click="closeLightbox" aria-label="Close lightbox">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <button class="lightbox-arrow lightbox-arrow--prev" @click="lightboxPrev" aria-label="Previous">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <img :src="slides[lightboxIndex].src" :alt="slides[lightboxIndex].alt" class="lightbox-img" />
            <button class="lightbox-arrow lightbox-arrow--next" @click="lightboxNext" aria-label="Next">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <div class="lightbox-dots">
              <button
                v-for="(_, i) in slides"
                :key="i"
                :class="['lightbox-dot', { 'lightbox-dot--active': i === lightboxIndex }]"
                @click="lightboxIndex = i"
                :aria-label="`Screenshot ${i + 1}`"
              />
            </div>
          </div>
        </Teleport>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         7 · WHY GITWAND — the 4 differentiators
    ══════════════════════════════════════ -->
    <section class="why-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.whyTitle }}</h2>
        <p class="section-sub">{{ t.whySub }}</p>
        <div class="why-grid">
          <article class="why-card">
            <div class="why-card__badge why-card__badge--purple">0</div>
            <h3 class="why-card__title">{{ t.why1t }}</h3>
            <p class="why-card__desc">{{ t.why1d }}</p>
          </article>
          <article class="why-card">
            <div class="why-card__badge why-card__badge--green">MIT</div>
            <h3 class="why-card__title">{{ t.why2t }}</h3>
            <p class="why-card__desc">{{ t.why2d }}</p>
          </article>
          <article class="why-card">
            <div class="why-card__badge why-card__badge--purple">~8&nbsp;MB</div>
            <h3 class="why-card__title">{{ t.why3t }}</h3>
            <p class="why-card__desc">{{ t.why3d }}</p>
          </article>
          <article class="why-card">
            <div class="why-card__badge why-card__badge--green">MCP</div>
            <h3 class="why-card__title">{{ t.why4t }}</h3>
            <p class="why-card__desc">{{ t.why4d }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         8 · MINI COMPARE
    ══════════════════════════════════════ -->
    <section class="mini-compare-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.miniCompareTitle }}</h2>
        <p class="section-sub">{{ t.miniCompareSub }}</p>
        <div class="mini-compare-wrap">
          <table class="mini-compare">
            <thead>
              <tr>
                <th></th>
                <th class="mc-gw">GitWand</th>
                <th>GitHub Desktop</th>
                <th>GitKraken</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="mc-feat">{{ t.mcRow1 }}</td>
                <td class="mc-gw"><span class="mc-yes">✓</span></td>
                <td><span class="mc-no">✗</span></td>
                <td><span class="mc-partial">AI only</span></td>
              </tr>
              <tr>
                <td class="mc-feat">{{ t.mcRow2 }}</td>
                <td class="mc-gw"><span class="mc-yes">✓</span></td>
                <td><span class="mc-yes">✓</span></td>
                <td><span class="mc-no">✗</span></td>
              </tr>
              <tr>
                <td class="mc-feat">{{ t.mcRow3 }}</td>
                <td class="mc-gw"><span class="mc-yes">✓</span></td>
                <td><span class="mc-no">✗</span></td>
                <td><span class="mc-no">✗</span></td>
              </tr>
              <tr>
                <td class="mc-feat">{{ t.mcRow4 }}</td>
                <td class="mc-gw"><span class="mc-yes">✓</span></td>
                <td><span class="mc-no">✗</span></td>
                <td><span class="mc-yes">✓</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="section-cta-row">
          <a href="/features" class="btn-ghost">{{ t.miniCompareCta }}</a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         9 · AI AGENTS TEASER
    ══════════════════════════════════════ -->
    <section class="agents-teaser">
      <div class="section-inner">
        <span class="badge">{{ t.llmBadge }}</span>
        <h2 class="section-title" style="margin-top:16px">{{ t.llmTitle }}</h2>
        <p class="section-sub">{{ t.llmSub }}</p>
        <div class="agents-chips">
          <span class="llm-chip">Claude Code</span>
          <span class="llm-chip">Cursor</span>
          <span class="llm-chip">opencode</span>
          <span class="llm-chip">Windsurf</span>
          <span class="llm-chip">Continue</span>
        </div>
        <div class="section-cta-row">
          <a href="/ai-agents" class="btn-primary">{{ t.agentsCta }}</a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         10 · FAQ
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
         11 · PLATFORMS (download)
    ══════════════════════════════════════ -->
    <section class="platforms-section">
      <div class="section-inner">
        <h2 class="section-title">{{ t.platformsTitle }}</h2>
        <div class="platforms-grid">
          <a class="platform-card" :href="dlMac" target="_blank" rel="noopener">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z" stroke="#8B5CF6" stroke-width="1.5"/><path d="M8 12.5c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4-4-1.8-4-4z" stroke="#8B5CF6" stroke-width="1.5"/></svg>
            <span class="pl-name">macOS</span>
            <span class="pl-sub">{{ t.plMacSub }}</span>
          </a>
          <a class="platform-card" :href="dlLinux" target="_blank" rel="noopener">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#8B5CF6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="pl-name">Linux</span>
            <span class="pl-sub">{{ t.plLinuxSub }}</span>
          </a>
          <a class="platform-card" :href="dlWin" target="_blank" rel="noopener">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/><rect x="13" y="3" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/><rect x="3" y="13" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/><rect x="13" y="13" width="8" height="8" rx="1" stroke="#8B5CF6" stroke-width="1.5"/></svg>
            <span class="pl-name">Windows</span>
            <span class="pl-sub">{{ t.plWinSub }}</span>
          </a>
          <a class="platform-card" href="/guide/cli">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7l3-7z" stroke="#10B981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="pl-name">{{ t.plCli }}</span>
            <span class="pl-sub">{{ t.plCliSub }}</span>
          </a>
          <a class="platform-card" href="https://marketplace.visualstudio.com/items?itemName=Gitwand.gitwand-vscode" target="_blank" rel="noopener">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="4" stroke="#10B981" stroke-width="1.5"/><path d="M8 14l2.5-5L13 14M9 12h3" stroke="#10B981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 9v6" stroke="#10B981" stroke-width="1.5" stroke-linecap="round"/></svg>
            <span class="pl-name">{{ t.plVscode }}</span>
            <span class="pl-sub">{{ t.plVscodeSub }}</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         12 · BLOG TEASER
    ══════════════════════════════════════ -->
    <section class="blog-teaser-section">
      <div class="section-inner">
        <div class="blog-teaser-header">
          <span class="blog-teaser-label">From the blog</span>
        </div>
        <a href="/blog/v3-5-pr-review-2-secrets-scanner" class="blog-teaser-card">
          <div class="blog-teaser-meta">July 10, 2026 · 9 min read</div>
          <h3 class="blog-teaser-title">PR Review 2.0, a local secrets scanner, and smarter PR badges</h3>
          <p class="blog-teaser-excerpt">v3.5 rebuilds in-app PR review around a keyboard-first flow and a local AI pre-review pipeline, adds a zero-network pre-commit secrets scanner, and fixes branch badges that only ever saw the first page of open PRs.</p>
          <span class="blog-teaser-cta">Read article →</span>
        </a>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         13 · CONTRIBUTORS
    ══════════════════════════════════════ -->
    <section class="contributors-section">
      <div class="section-inner">
        <div class="contributors-header">
          <span class="contributors-label">Contributors</span>
        </div>
        <div class="contributors-grid">
          <a href="https://github.com/devlint" class="contributor-card" target="_blank" rel="noopener">
            <img src="https://github.com/devlint.png" alt="devlint on GitHub" class="contributor-avatar" width="48" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <span class="contributor-meta">
              <span class="contributor-name">devlint</span>
              <span class="contributor-role">Creator &amp; maintainer</span>
            </span>
          </a>
          <a href="https://github.com/t1gu1" class="contributor-card" target="_blank" rel="noopener">
            <img src="https://github.com/t1gu1.png" alt="t1gu1 on GitHub" class="contributor-avatar" width="48" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <span class="contributor-meta">
              <span class="contributor-name">t1gu1</span>
              <span class="contributor-role">Contributor</span>
            </span>
          </a>
          <a href="https://github.com/devlint/GitWand/blob/main/CONTRIBUTING.md" class="contributor-card contributor-card--you" target="_blank" rel="noopener">
            <span class="contributor-avatar contributor-avatar--you" aria-hidden="true">+</span>
            <span class="contributor-meta">
              <span class="contributor-name">{{ t.contribYouName }}</span>
              <span class="contributor-role">{{ t.contribYouRole }}</span>
            </span>
          </a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         13b · SPONSOR
    ══════════════════════════════════════ -->
    <section class="sponsor-section">
      <div class="section-inner">
        <div class="sponsor-card">
          <span class="sponsor-icon" aria-hidden="true">♥</span>
          <div class="sponsor-text">
            <h3 class="sponsor-title">{{ t.sponsorTitle }}</h3>
            <p class="sponsor-sub">{{ t.sponsorSub }}</p>
          </div>
          <a href="https://github.com/sponsors/devlint" class="btn-primary sponsor-btn" target="_blank" rel="noopener">
            {{ t.sponsorCta }}
          </a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         14 · FINAL CTA
    ══════════════════════════════════════ -->
    <section class="cta-section">
      <div class="cta-inner">
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

    <!-- Featured badges -->
    <section class="badge-section">
      <a href="https://nicklaunches.com/products/gitwand/?utm_source=gitwand.app&utm_medium=badge&utm_campaign=featured" target="_blank" rel="noopener">
        <img src="https://nicklaunches.com/badges/featured-dark.png" alt="GitWand on Nick Launches" width="244" height="56" />
      </a>
      <a href="https://www.foundrlist.com/product/gitwand?utm_source=badge&utm_medium=embed" target="_blank" rel="noopener">
        <img src="https://www.foundrlist.com/api/badge/gitwand" alt="Featured on FoundrList" width="150" height="48" />
      </a>
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
  position: relative;
  overflow: hidden;
  padding: 88px 0 68px;
  background: var(--gw-bg);
  border-bottom: 1px solid var(--gw-border-soft);
}

/* ── Ambient depth layers ── */
.hero-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hero-bg__grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(148,163,184,0.13) 1px, transparent 1px);
  background-size: 28px 28px;
  /* Fade the dots out toward the bottom so the grid doesn't fight the content */
  -webkit-mask-image: radial-gradient(ellipse 90% 75% at 50% 0%, #000 30%, transparent 75%);
  mask-image: radial-gradient(ellipse 90% 75% at 50% 0%, #000 30%, transparent 75%);
}
.hero-bg__orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.55;
  animation: orbFloat 14s ease-in-out infinite alternate;
}
.hero-bg__orb--purple {
  width: 560px;
  height: 420px;
  top: -160px;
  right: -80px;
  background: radial-gradient(circle, rgba(124,58,237,0.38) 0%, transparent 70%);
}
.hero-bg__orb--green {
  width: 420px;
  height: 340px;
  bottom: -180px;
  left: -120px;
  background: radial-gradient(circle, rgba(16,185,129,0.20) 0%, transparent 70%);
  animation-delay: -7s;
}
@keyframes orbFloat {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to   { transform: translate3d(-30px, 24px, 0) scale(1.08); }
}
@media (prefers-reduced-motion: reduce) {
  .hero-bg__orb { animation: none; }
}
.hero-inner { position: relative; z-index: 1; }

/* ── Announcement pill (replaces the static version badge) ── */
.hero-announce {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px 6px 11px;
  margin-bottom: 22px;
  border-radius: 999px;
  border: 1px solid var(--gw-border);
  background: linear-gradient(120deg, rgba(124,58,237,0.14), rgba(16,185,129,0.07));
  font-size: 12.5px;
  font-weight: 600;
  color: var(--gw-purple-light);
  letter-spacing: 0.01em;
  text-decoration: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.hero-announce:hover {
  border-color: rgba(124,58,237,0.55);
  box-shadow: 0 0 20px rgba(124,58,237,0.25);
}
.hero-announce__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gw-green);
  box-shadow: 0 0 0 0 rgba(16,185,129,0.5);
  animation: announcePulse 2.4s ease-out infinite;
}
@keyframes announcePulse {
  0%   { box-shadow: 0 0 0 0 rgba(16,185,129,0.45); }
  70%  { box-shadow: 0 0 0 7px rgba(16,185,129,0); }
  100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
}
@media (prefers-reduced-motion: reduce) {
  .hero-announce__dot { animation: none; }
}
.hero-announce__arrow {
  transition: transform 0.15s;
}
.hero-announce:hover .hero-announce__arrow { transform: translateX(3px); }

/* ── Benefit checklist ── */
.hero-points {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 0 0 30px;
  padding: 0;
}
.hero-point {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: var(--gw-text);
}
.hero-point svg { color: var(--gw-green); flex-shrink: 0; }
.hero-point span { color: var(--gw-text-muted); }
.hero-meta { color: var(--gw-text-muted); opacity: 0.85; }
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
  margin: 0 0 22px;
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
  align-items: stretch;
  justify-content: center;
  gap: 18px;
  padding: 36px 28px;
  border-bottom: 1px solid var(--gw-border-soft);
  background: var(--gw-bg-2);
}
.stat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 22px 44px 20px;
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  overflow: hidden;
  transition: border-color 0.2s, transform 0.15s, box-shadow 0.2s;
}
/* Gradient hairline across the top of each stat card */
.stat::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--gw-purple-light), var(--gw-green));
  opacity: 0.55;
  transition: opacity 0.2s;
}
.stat:hover {
  border-color: rgba(124,58,237,0.45);
  transform: translateY(-3px);
  box-shadow: 0 14px 34px rgba(0,0,0,0.35);
}
.stat:hover::before { opacity: 1; }
.stat-n {
  font-size: 38px;
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
.stat-sep { display: none; }

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
.preview-slideshow {
  overflow: hidden;
  position: relative;
}
.slideshow-track {
  display: flex;
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
}
.slideshow-img {
  flex: 0 0 100%;
  width: 100%;
  display: block;
  object-fit: cover;
}
.slideshow-dots {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 20px;
}
.slideshow-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255,255,255,0.18);
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background 0.2s, transform 0.2s;
}
.slideshow-dot--active {
  background: var(--gw-purple-light);
  transform: scale(1.4);
}
.slideshow-dot:hover:not(.slideshow-dot--active) {
  background: rgba(255,255,255,0.4);
}
.slideshow-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(0,0,0,0.5);
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.85);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s, color 0.2s;
  backdrop-filter: blur(4px);
}
.slideshow-arrow--prev { left: 12px; }
.slideshow-arrow--next { right: 12px; }
.slideshow-arrow:hover { background: rgba(124,58,237,0.6); color: #fff; }
.slideshow-img { cursor: zoom-in; }

/* ── Lightbox ──────────────────────────────── */
.lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0,0,0,0.92);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 64px 16px 80px;
}
.lightbox-img {
  max-width: min(90vw, 1400px);
  max-height: 85vh;
  border-radius: 10px;
  box-shadow: 0 40px 120px rgba(0,0,0,0.8);
  object-fit: contain;
  flex-shrink: 1;
}
.lightbox-close {
  position: fixed;
  top: 16px;
  right: 20px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.8);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s, color 0.2s;
  z-index: 10000;
}
.lightbox-close:hover { background: rgba(255,255,255,0.15); color: #fff; }
.lightbox-arrow {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.8);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s, color 0.2s;
}
.lightbox-arrow:hover { background: rgba(124,58,237,0.6); color: #fff; }
.lightbox-dots {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
}
.lightbox-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255,255,255,0.25);
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background 0.2s, transform 0.2s;
}
.lightbox-dot--active {
  background: #8B5CF6;
  transform: scale(1.4);
}
@media (max-width: 600px) {
  .lightbox-arrow { display: none; }
  .lightbox-overlay { gap: 0; padding: 56px 8px 72px; }
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
  text-decoration: none;
  color: inherit;
  cursor: pointer;
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
.badge-section {
  padding: 40px 0 60px;
  background: var(--gw-bg);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 20px;
}
.badge-section img {
  display: block;
  border: 0;
}
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
   CONTRIBUTORS
─────────────────────────────────────────── */
.contributors-section {
  padding: 64px 24px;
  border-top: 1px solid var(--gw-border);
}
.contributors-header {
  margin-bottom: 1.5rem;
}
.contributors-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--gw-purple);
  font-family: var(--vp-font-family-mono, monospace);
}
.contributors-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
.contributor-card {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.2s, background 0.2s;
  min-width: 220px;
}
.contributor-card:hover {
  border-color: var(--gw-purple);
  background: var(--gw-surface);
}
.contributor-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1px solid var(--gw-border);
  flex-shrink: 0;
}
.contributor-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.contributor-name {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--gw-text);
}
.contributor-role {
  font-size: 0.8rem;
  color: var(--gw-text-muted);
}

/* "+ you?" recruitment card — dashed placeholder slot in the grid */
.contributor-card--you {
  border-style: dashed;
  border-color: rgba(124,58,237,0.4);
  background: rgba(124,58,237,0.04);
}
.contributor-card--you:hover {
  border-style: solid;
  background: rgba(124,58,237,0.10);
}
.contributor-card--you .contributor-name { color: var(--gw-purple-light); }
.contributor-avatar--you {
  display: grid;
  place-items: center;
  font-size: 22px;
  font-weight: 700;
  color: var(--gw-purple-light);
  background: rgba(124,58,237,0.10);
  border-style: dashed;
  border-color: rgba(124,58,237,0.4);
}

/* ───────────────────────────────────────────
   SPONSOR
─────────────────────────────────────────── */
.sponsor-section {
  padding: 64px 24px;
  border-top: 1px solid var(--gw-border);
}
.sponsor-card {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 1.5rem 1.75rem;
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  flex-wrap: wrap;
}
.sponsor-icon {
  font-size: 22px;
  color: var(--gw-purple-light);
  flex-shrink: 0;
}
.sponsor-text {
  flex: 1 1 320px;
}
.sponsor-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.35rem;
  color: var(--gw-text);
}
.sponsor-sub {
  font-size: 0.875rem;
  color: var(--gw-text-muted);
  margin: 0;
  line-height: 1.6;
}
.sponsor-btn {
  flex-shrink: 0;
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
   HERO VISUAL — CLI ⇄ GUI toggle (#71)
─────────────────────────────────────────── */
.hero-visual {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.hero-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: 999px;
}
.hero-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--gw-text-muted);
  font-size: 13px;
  font-weight: 600;
  padding: 6px 18px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.hero-tab:hover { color: var(--gw-text); }
.hero-tab--active {
  background: var(--gw-purple);
  color: #fff;
}
/* Stack both panels in a single grid cell: the stage sizes to the taller of the
   two, so toggling the tab never changes the visual's height (no reflow). */
.hero-stage {
  display: grid;
  width: 100%;
  justify-items: center;
  position: relative;
}
/* Soft dual-tone glow anchoring the visual to the page */
.hero-stage::before {
  content: '';
  position: absolute;
  inset: -8% -6%;
  background:
    radial-gradient(ellipse 60% 55% at 30% 40%, rgba(124,58,237,0.28) 0%, transparent 70%),
    radial-gradient(ellipse 50% 45% at 75% 70%, rgba(16,185,129,0.14) 0%, transparent 70%);
  filter: blur(28px);
  z-index: 0;
  pointer-events: none;
}
.hero-stage > * { position: relative; z-index: 1; }
.hero-stage > * {
  grid-area: 1 / 1;
}
.hero-pane--hidden {
  /* visibility:hidden keeps the box in the grid cell (no reflow) while hiding it. */
  visibility: hidden;
}
.hero-gui {
  width: 100%;
  max-width: 560px;
  position: relative;
}
.hero-gui__img {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.10);
  box-shadow:
    0 32px 80px rgba(0,0,0,0.55),
    0 12px 28px rgba(124,58,237,0.14),
    0 0 0 1px rgba(124,58,237,0.14);
}

/* Floating proof card over the screenshot */
.hero-toast {
  position: absolute;
  left: -14px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 10px 12px;
  border-radius: 10px;
  background: rgba(22, 22, 42, 0.92);
  border: 1px solid rgba(16,185,129,0.35);
  box-shadow: 0 16px 40px rgba(0,0,0,0.5), 0 0 24px rgba(16,185,129,0.10);
  backdrop-filter: blur(10px);
  animation: toastFloat 6s ease-in-out infinite alternate;
}
@keyframes toastFloat {
  from { transform: translateY(0); }
  to   { transform: translateY(-7px); }
}
@media (prefers-reduced-motion: reduce) {
  .hero-toast { animation: none; }
}
.hero-toast__icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: rgba(16,185,129,0.16);
  color: var(--gw-green);
  flex-shrink: 0;
}
.hero-toast__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.hero-toast__title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--gw-text);
  letter-spacing: 0.01em;
}
.hero-toast__sub {
  font-size: 11px;
  color: var(--gw-text-muted);
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

/* ───────────────────────────────────────────
   RESPONSIVE
─────────────────────────────────────────── */
@media (max-width: 900px) {
  .hero-inner {
    grid-template-columns: 1fr;
    gap: 40px;
  }
  .hero-visual { order: -1; }
  .stats-bar { flex-wrap: wrap; gap: 14px; }
  .stat { flex: 1 1 200px; padding: 20px 24px 18px; }
  .hero-toast { left: 8px; bottom: 10px; padding: 8px 12px 8px 10px; }
  .conflict-demo { flex-direction: column; }
  .conflict-arrow { flex-direction: row; }
  .llm-layout { grid-template-columns: 1fr; gap: 40px; }
  .hl-pillars__grid { grid-template-columns: 1fr; gap: 16px; }
}
@media (max-width: 600px) {
  .hero { padding: 60px 0 40px; }
  .hero-announce { font-size: 11.5px; }
  .hero-point { font-size: 13px; }
  .hero-toast__sub { display: none; }
  .hero-bg__orb { filter: blur(70px); }
  .platforms-grid { flex-direction: column; align-items: center; }
  .hero-term { max-width: 100%; }
  .hero-term__line { white-space: pre-wrap; word-break: break-all; }
  .hl-pillars { padding: 56px 0 48px; }
  .hl-pillar { padding: 22px 20px; }
}

/* ───────────────────────────────────────────
   REDESIGN 2026 — new sections
─────────────────────────────────────────── */

/* Trust bar (below stats) */
.trust-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 14px;
  padding: 22px 24px;
  background: var(--gw-bg-2);
  border-bottom: 1px solid var(--gw-border-soft);
}
.trust-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: 1px solid var(--gw-border);
  border-radius: 999px;
  font-size: 13px;
  color: var(--gw-text-muted);
  background: rgba(255, 255, 255, 0.02);
}
.trust-item--link {
  text-decoration: none;
  color: var(--gw-text);
  transition: border-color 0.15s, color 0.15s;
}
.trust-item--link:hover {
  border-color: var(--gw-purple);
  color: var(--gw-purple-light);
}
.trust-item--link svg { color: var(--gw-purple-light); }
.trust-strong {
  font-weight: 800;
  color: var(--gw-text);
  letter-spacing: -0.01em;
}
.trust-txt { color: var(--gw-text-muted); }

/* Section CTA row */
.section-cta-row {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}

/* Pillars as clickable doors */
.hl-pillar--link {
  text-decoration: none;
  color: inherit;
  cursor: pointer;
}

/* Why GitWand — 4 differentiators */
.why-section {
  padding: 72px 0 64px;
  background: var(--gw-bg-2);
  border-bottom: 1px solid var(--gw-border-soft);
}
.why-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  margin-top: 8px;
}
.why-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 26px 22px;
  background: var(--gw-bg-card);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
  transition: border-color 0.2s, transform 0.15s;
}
.why-card:hover {
  border-color: var(--gw-purple);
  transform: translateY(-2px);
}
.why-card__badge {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 54px;
  height: 40px;
  padding: 0 12px;
  border-radius: 10px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.01em;
}
.why-card__badge--purple {
  color: var(--gw-purple-light);
  background: rgba(124, 58, 237, 0.12);
}
.why-card__badge--green {
  color: var(--gw-green);
  background: rgba(16, 185, 129, 0.12);
}
.why-card__title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--gw-text);
}
.why-card__desc {
  font-size: 14px;
  line-height: 1.6;
  color: var(--gw-text-muted);
  margin: 0;
}

/* Mini comparison */
.mini-compare-section {
  padding: 72px 0 64px;
  background: var(--gw-bg);
  border-bottom: 1px solid var(--gw-border-soft);
}
.mini-compare-wrap {
  margin-top: 8px;
  overflow-x: auto;
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius);
}
.mini-compare {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.mini-compare th,
.mini-compare td {
  padding: 14px 18px;
  text-align: center;
  border-bottom: 1px solid var(--gw-border-soft);
}
.mini-compare thead th {
  font-weight: 700;
  color: var(--gw-text-muted);
  background: var(--gw-bg-2);
}
.mini-compare tbody tr:last-child td { border-bottom: none; }
.mini-compare .mc-feat {
  text-align: left;
  color: var(--gw-text);
  font-weight: 500;
}
.mini-compare th.mc-gw,
.mini-compare td.mc-gw {
  background: rgba(124, 58, 237, 0.08);
  color: var(--gw-purple-light);
  font-weight: 700;
}
.mc-yes { color: var(--gw-green); font-weight: 700; }
.mc-no { color: var(--gw-text-muted); opacity: 0.5; }
.mc-partial { font-size: 12px; color: var(--gw-text-muted); }

/* AI agents teaser */
.agents-teaser {
  padding: 72px 0 64px;
  background: var(--gw-bg-2);
  border-bottom: 1px solid var(--gw-border-soft);
  text-align: center;
}
.agents-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 28px 0 8px;
}

/* Responsive */
@media (max-width: 860px) {
  .why-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 560px) {
  .why-grid { grid-template-columns: 1fr; }
  .trust-bar { gap: 10px; padding: 18px 16px; }
}

</style>
