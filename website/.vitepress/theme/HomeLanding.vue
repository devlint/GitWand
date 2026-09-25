<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { AUTO_PATTERN_COUNT } from './patterns'

type Locale = 'en' | 'fr' | 'es' | 'pt-BR' | 'zh-CN'

// English is the canonical default for everyone — other languages are opt-in via the picker.
// The picker mirrors the 5 locales supported by the desktop app (apps/desktop/src/locales/).
const locale = ref<Locale>('en')
const faqOpen = ref<number | null>(null)
function toggleFaq(i: number) {
  faqOpen.value = faqOpen.value === i ? null : i
}

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
const LATEST = '3.11.1'
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
})

// ── Captures affichées en plein écran depuis le hero ───────────────────────────────────────────────────
const slides = [
  { src: '/screenshots/GitWand_dashboard.png',        alt: 'GitWand — dashboard' },
  { src: '/screenshots/GitWand_changes.png',          alt: 'GitWand — changes view' },
  { src: '/screenshots/GitWand_GitTree.png',          alt: 'GitWand — git commit tree' },
  { src: '/screenshots/GitWand_Branches_manager.png', alt: 'GitWand — branch manager' },
  { src: '/screenshots/GitWand_Worktree.png',         alt: 'GitWand — worktrees' },
  { src: '/screenshots/GitWand_settingAI.png',        alt: 'GitWand — AI settings' },
]
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
    heroAnnounce: "Nouveau dans la v3.11 — l'IA sait enfin pourquoi chaque côté a modifié le code en conflit",
    heroPoint1: "8 patterns déterministes — zéro pari sur ton code",
    heroPoint2: "100 % local — ton code ne quitte jamais ta machine",
    heroPoint3: "Un seul moteur — Desktop, CLI, VS Code & agents IA",
    heroMeta: "Gratuit · sans compte · sans pistage",
    heroToastTitle: "57 hunks résolus automatiquement",
    heroToastSub: "1 à relire · 0 hallucination",
    contribYouName: "+ toi ?",
    contribYouRole: "Ouvre ta première PR",
    sponsorTitle: "Soutiens GitWand",
    sponsorSub: "GitWand est gratuit et open source. Un sponsoring GitHub finance le temps de développement et l'hébergement.",
    sponsorCta: "Devenir sponsor",
    heroH1a: "Les conflits de merge s'arrêtent ici.",
    heroH1b: "Retrouve ton flow.",
    heroSub: "Ce petit coup au moral quand 12 fichiers passent au rouge ? Terminé. GitWand classe chaque hunk avec 8 patterns déterministes — sans deviner, sans halluciner — résout tout seul ceux qui n'étaient pas des décisions, et ne te rend que ce qui mérite ton cerveau. Natif, gratuit, MIT.",
    download: 'Télécharger',
    github: 'GitHub',
    whatsNew: 'Nouveautés v3.11',
    docs: 'Documentation →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'App desktop',
    heroGuiAlt: 'GitWand — tableau de bord du dépôt',
    heroVisualAria: 'Aperçu : CLI ou interface graphique',
    statPatterns: 'patterns de résolution',
    statResolved: 'merges réels rejoués',
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
    plWinSub: 'Installeur .exe · .msi · winget',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: "Arrête d'arbitrer les conflits de merge.",
    ctaSub: "Gratuit, open source, natif. Télécharge GitWand et laisse le moteur prendre ceux qui n'avaient rien à décider.",
    ctaDownload: 'Télécharger GitWand',
    llmTitle: "Tes agents IA, avec un vrai moteur Git à portée de main",
    llmSub: "Les agents sont excellents pour le code et catastrophiques sur les merges. Le serveur MCP de GitWand résout de façon déterministe les hunks sans décision à prendre et confie à ton agent les hunks difficiles avec tout le contexte — ours, theirs, base et la trace.",
    llmBadge: 'MCP Server · Registre officiel · stdio · Sans clé API',
    // 3 Pillars
    pillarsTitle: 'Trois piliers, une promesse',
    pillarsSub: "Des conflits résolus de façon déterministe, une performance vraiment native, et une IA qui n'intervient que si tu le demandes.",
    pillar1Title: 'Les conflits qui n\'étaient pas des décisions se résolvent seuls',
    pillar1Sub: '8 patterns déterministes. Score de confiance composite. Trace de décision pour chaque hunk.',
    pillar1Stat: '100 %',
    pillar1StatLabel: 'des résolutions avec trace auditable',
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
      { q: 'Qu\'est-ce que le serveur MCP et pourquoi l\'utiliser ?', a: 'Le serveur MCP expose le moteur de GitWand aux agents IA — Claude Code, Cursor, Windsurf, et d\'autres. Il tourne en local via stdio, sans clé API ni accès réseau. GitWand règle les hunks sans décision à prendre, l\'agent IA s\'occupe des cas ambigus avec tout le contexte nécessaire.' },
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
    heroAnnounce: "New in v3.11 — the AI now knows why each side changed the conflicting code",
    heroPoint1: "8 deterministic patterns — zero gambling with your code",
    heroPoint2: "100% local — your code never leaves your machine",
    heroPoint3: "One engine — Desktop, CLI, VS Code & AI agents",
    heroMeta: "Free · no account · no tracking",
    heroToastTitle: "57 hunks auto-resolved",
    heroToastSub: "1 left for review · 0 hallucinations",
    contribYouName: "+ you?",
    contribYouRole: "Open your first PR",
    sponsorTitle: "Support GitWand",
    sponsorSub: "GitWand is free and open source. GitHub Sponsors funds development time and hosting.",
    sponsorCta: "Become a sponsor",
    heroH1a: "Merge conflicts end here.",
    heroH1b: "Get your flow back.",
    heroSub: "That sinking feeling when 12 files turn red? Gone. GitWand classifies every hunk with 8 deterministic patterns — no guessing, no hallucinations — auto-resolves the ones that were never decisions, and hands you only what's worth your brain. Native, free, MIT.",
    download: 'Download',
    github: 'GitHub',
    whatsNew: "What's new in v3.11",
    docs: 'Documentation →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'Desktop app',
    heroGuiAlt: 'GitWand — repository dashboard',
    heroVisualAria: 'Preview: CLI or graphical interface',
    statPatterns: 'resolution patterns',
    statResolved: 'real merges replayed',
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
    plWinSub: 'Installer .exe · .msi · winget',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: "Stop refereeing merge conflicts.",
    ctaSub: "Free, open source, native. Download GitWand and let the engine take the ones with nothing to decide.",
    ctaDownload: 'Download GitWand',
    llmTitle: "Your AI agents, with a real Git engine on tap",
    llmSub: "Agents are great at code and terrible at merges. GitWand's MCP server deterministically resolves the hunks that carry no decision and hands your agent the hard hunks with full context — ours, theirs, base and the trace.",
    llmBadge: 'MCP Server · Official Registry · stdio · No API key',
    // 3 Pillars
    pillarsTitle: 'Three pillars, one promise',
    pillarsSub: "Conflicts resolved deterministically, performance that's actually native, and AI that only steps in when you ask.",
    pillar1Title: 'The conflicts that were never decisions resolve themselves',
    pillar1Sub: '8 deterministic patterns. Composite confidence scoring. Decision traces for every hunk.',
    pillar1Stat: '100%',
    pillar1StatLabel: 'of resolutions carry an auditable trace',
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
      { q: 'What is the MCP server and why use it?', a: 'The MCP server exposes GitWand\'s engine to AI agents — Claude Code, Cursor, Windsurf, and others. It runs locally over stdio, with no API key or network access required. GitWand settles the hunks that carry no decision; the AI agent tackles the ambiguous ones with full context.' },
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
    heroAnnounce: "Nuevo en la v3.11 — la IA ya sabe por qué cada lado cambió el código en conflicto",
    heroPoint1: "8 patrones deterministas — cero apuestas con tu código",
    heroPoint2: "100 % local — tu código nunca sale de tu máquina",
    heroPoint3: "Un solo motor — Desktop, CLI, VS Code y agentes de IA",
    heroMeta: "Gratis · sin cuenta · sin rastreo",
    heroToastTitle: "57 hunks resueltos automáticamente",
    heroToastSub: "1 por revisar · 0 alucinaciones",
    contribYouName: "+ ¿tú?",
    contribYouRole: "Abre tu primera PR",
    sponsorTitle: "Apoya a GitWand",
    sponsorSub: "GitWand es gratis y open source. GitHub Sponsors financia el tiempo de desarrollo y el hosting.",
    sponsorCta: "Ser sponsor",
    heroH1a: "Los conflictos de merge terminan aquí.",
    heroH1b: "Recupera tu flow.",
    heroSub: "¿Esa sensación de vacío cuando 12 archivos se ponen en rojo? Se acabó. GitWand clasifica cada hunk con 8 patrones deterministas — sin adivinar, sin alucinar — resuelve solo los que nunca fueron decisiones y te entrega únicamente lo que merece tu cerebro. Nativo, gratis, MIT.",
    download: 'Descargar',
    github: 'GitHub',
    whatsNew: 'Novedades v3.11',
    docs: 'Documentación →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'App de escritorio',
    heroGuiAlt: 'GitWand — panel del repositorio',
    heroVisualAria: 'Vista previa: CLI o interfaz gráfica',
    statPatterns: 'patrones de resolución',
    statResolved: 'merges reales reproducidos',
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
    plWinSub: 'Instalador .exe · .msi · winget',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Marketplace de extensiones',
    ctaTitle: "Deja de arbitrar los conflictos de merge.",
    ctaSub: "Gratis, open source, nativo. Descarga GitWand y deja que el motor se encargue de los que no tenían nada que decidir.",
    ctaDownload: 'Descargar GitWand',
    llmTitle: "Tus agentes IA, con un motor Git de verdad a mano",
    llmSub: "Los agentes son geniales con el código y pésimos con los merges. El servidor MCP de GitWand resuelve de forma determinista los hunks sin decisión que tomar y le pasa a tu agente los hunks difíciles con todo el contexto — ours, theirs, base y la traza.",
    llmBadge: 'Servidor MCP · Registro oficial · stdio · Sin clave API',
    // 3 Pillars
    pillarsTitle: 'Tres pilares, una promesa',
    pillarsSub: "Conflictos resueltos de forma determinista, rendimiento realmente nativo, e IA que solo interviene cuando se lo pides.",
    pillar1Title: 'Los conflictos que nunca fueron decisiones se resuelven solos',
    pillar1Sub: '8 patrones deterministas. Puntuación de confianza compuesta. Traza de decisión para cada hunk.',
    pillar1Stat: '100 %',
    pillar1StatLabel: 'de las resoluciones con traza auditable',
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
      { q: '¿Qué es el servidor MCP y por qué usarlo?', a: 'El servidor MCP expone el motor de GitWand a los agentes IA — Claude Code, Cursor, Windsurf y otros. Funciona en local vía stdio, sin clave API ni acceso a la red. GitWand resuelve los hunks sin decisión que tomar; el agente IA se ocupa de los casos ambiguos con todo el contexto necesario.' },
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
    heroAnnounce: "Novidade na v3.11 — a IA agora sabe por que cada lado alterou o código em conflito",
    heroPoint1: "8 padrões deterministas — zero aposta com seu código",
    heroPoint2: "100 % local — seu código nunca sai da sua máquina",
    heroPoint3: "Um único motor — Desktop, CLI, VS Code e agentes de IA",
    heroMeta: "Gratuito · sem conta · sem rastreamento",
    heroToastTitle: "57 hunks resolvidos automaticamente",
    heroToastSub: "1 para revisar · 0 alucinações",
    contribYouName: "+ você?",
    contribYouRole: "Abra sua primeira PR",
    sponsorTitle: "Apoie o GitWand",
    sponsorSub: "GitWand é gratuito e open source. O GitHub Sponsors financia o tempo de desenvolvimento e a hospedagem.",
    sponsorCta: "Ser sponsor",
    heroH1a: "Conflitos de merge terminam aqui.",
    heroH1b: "Recupere seu flow.",
    heroSub: "Aquele frio na barriga quando 12 arquivos ficam vermelhos? Acabou. O GitWand classifica cada hunk com 8 padrões deterministas — sem chutar, sem alucinar — resolve sozinho os que nunca foram decisões e devolve só o que merece seu cérebro. Nativo, gratuito, MIT.",
    download: 'Baixar',
    github: 'GitHub',
    whatsNew: 'Novidades v3.11',
    docs: 'Documentação →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: 'CLI',
    heroTabGui: 'App desktop',
    heroGuiAlt: 'GitWand — painel do repositório',
    heroVisualAria: 'Prévia: CLI ou interface gráfica',
    statPatterns: 'padrões de resolução',
    statResolved: 'merges reais reproduzidos',
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
    plWinSub: 'Instalador .exe · .msi · winget',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: 'Extension Marketplace',
    ctaTitle: "Pare de arbitrar conflitos de merge.",
    ctaSub: "Gratuito, open source, nativo. Baixe o GitWand e deixe o motor cuidar dos que não tinham nada a decidir.",
    ctaDownload: 'Baixar o GitWand',
    llmTitle: "Seus agentes de IA, com um motor Git de verdade à mão",
    llmSub: "Agentes são ótimos com código e péssimos com merges. O servidor MCP do GitWand resolve de forma determinista os hunks sem decisão a tomar e entrega ao seu agente os hunks difíceis com todo o contexto — ours, theirs, base e o trace.",
    llmBadge: 'Servidor MCP · Registro oficial · stdio · Sem chave de API',
    // 3 Pillars
    pillarsTitle: 'Três pilares, uma promessa',
    pillarsSub: "Conflitos resolvidos de forma determinista, desempenho realmente nativo e IA que só entra quando você pede.",
    pillar1Title: 'Os conflitos que nunca foram decisões se resolvem sozinhos',
    pillar1Sub: '8 padrões deterministas. Score de confiança composto. Trace de decisão em cada hunk.',
    pillar1Stat: '100%',
    pillar1StatLabel: 'das resoluções com trilha auditável',
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
      { q: 'O que é o servidor MCP e por que usá-lo?', a: 'O servidor MCP expõe o motor do GitWand a agentes de IA — Claude Code, Cursor, Windsurf e outros. Roda localmente via stdio, sem chave de API nem acesso à rede. O GitWand resolve os hunks sem decisão a tomar; o agente de IA lida com os ambíguos com todo o contexto necessário.' },
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
    heroAnnounce: "v3.11 新功能 — AI 现在知道每一方为何修改了冲突代码",
    heroPoint1: "8 种确定性模式 — 绝不拿你的代码赌运气",
    heroPoint2: "100% 本地运行 — 代码永不离开你的机器",
    heroPoint3: "一个引擎 — 桌面端、CLI、VS Code 与 AI 代理",
    heroMeta: "免费 · 无需账号 · 无追踪",
    heroToastTitle: "57 个 hunk 已自动解决",
    heroToastSub: "1 个待复查 · 0 幻觉",
    contribYouName: "+ 你？",
    contribYouRole: "提交你的第一个 PR",
    sponsorTitle: "支持 GitWand",
    sponsorSub: "GitWand 免费且开源。GitHub Sponsors 资助开发时间与托管费用。",
    sponsorCta: "成为赞助者",
    heroH1a: "合并冲突，到此为止。",
    heroH1b: "找回你的心流。",
    heroSub: "12 个文件同时变红的那种心凉？不会再有。GitWand 用 8 种确定性模式分类每个 hunk——不猜测、无幻觉——自动解决那些本就无需决定的冲突，只把真正值得你思考的部分交还给你。原生、免费、MIT。",
    download: '下载',
    github: 'GitHub',
    whatsNew: 'v3.11 新特性',
    docs: '文档 →',
    platforms: 'macOS · Linux · Windows',
    heroTabCli: '命令行',
    heroTabGui: '桌面应用',
    heroGuiAlt: 'GitWand — 仓库仪表盘',
    heroVisualAria: '预览：命令行或图形界面',
    statPatterns: '种解决模式',
    statResolved: '个真实 merge 已重放',
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
    plWinSub: '.exe · .msi · winget 安装程序',
    plCli: 'CLI npm',
    plCliSub: 'npm i -g @gitwand/cli',
    plVscode: 'VS Code',
    plVscodeSub: '扩展市场',
    ctaTitle: "别再当合并冲突的裁判了。",
    ctaSub: "免费、开源、原生。下载 GitWand,把无需决定的那些交给引擎。",
    ctaDownload: '下载 GitWand',
    llmTitle: "让你的 AI 代理,随时用上真正的 Git 引擎",
    llmSub: "代理擅长写代码,却搞不定合并。GitWand 的 MCP 服务器以确定性方式解决那些本就无需决定的 hunk,并把困难的 hunk 连同完整上下文——ours、theirs、base 和追踪——交给你的代理。",
    llmBadge: 'MCP 服务器 · 官方注册表 · stdio · 无需 API 密钥',
    // 3 Pillars
    pillarsTitle: '三大支柱,一个承诺',
    pillarsSub: "以确定性方式解决冲突、真正原生的性能，以及只有你需要时才介入的 AI。",
    pillar1Title: '本就无需决定的冲突，自动解决',
    pillar1Sub: '8 种确定性模式。组合式置信度评分。每个 hunk 都有决策追踪。',
    pillar1Stat: '100%',
    pillar1StatLabel: '的解决都带可审计追踪',
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
      { q: 'MCP 服务器是什么?为什么要用?', a: 'MCP 服务器将 GitWand 的引擎开放给 AI 代理 — Claude Code、Cursor、Windsurf 等。通过 stdio 在本地运行,无需 API 密钥,也不需要网络访问。GitWand 处理那些本就无需决定的 hunk;AI 代理则在完整上下文下应对模糊情况。' },
      { q: 'GitWand 适用于任何 Git 仓库吗?', a: '是的。GitWand 适用于任何本地 Git 仓库,无论托管在哪里(GitHub、GitLab、Bitbucket、Gitea…)。Pull Requests 视图支持 GitHub、GitLab、Bitbucket 和 Azure DevOps。' },
      { q: '与其他 Git 客户端有什么区别?', a: 'GitWand 的亮点在于内置的解决引擎、原生的 Tauri 架构(非 Electron)、3 种一致的界面(桌面端、CLI、VS Code),以及用于 AI 代理集成的 MCP 服务器。' },
      { q: '如何安装 MCP 服务器?', a: '使用 Claude Code 一条命令即可:claude mcp add gitwand -- npx -y @gitwand/mcp。对于 Claude Desktop、Cursor 或 Windsurf,将 mcpServers 块添加到你的客户端配置(见文档)。该服务器也已列入官方 MCP 注册表,浏览注册表的客户端会自动发现它。' },
    ],
  },
}

const t = computed(() => i18n[locale.value])

// ── Copie de la trame « Nocturne » ───────────────────────────────────────────
// Séparée de `i18n` pour que la refonte n'ait pas à réécrire l'ancien objet :
// `t` sert les sections historiques, `nt` les nouvelles.
const NC: Record<Locale, any> = {
  en: {
    badge: 'v3.11 — the AI now knows why each side changed the conflicting code',
    h1a: 'The merge ends', h1b: 'without you', h1c: '.',
    sub: 'Eight deterministic patterns classify every hunk, settle the ones that carried no decision, and hand you back only what deserves your attention. Native, local, MIT.',
    cta: 'Download GitWand',
    copy: 'Copy', copied: 'Copied',
    s1n: '57', s1l: 'hunks settled in the last merge',
    s2n: '0.9 s', s2l: 'to classify all of them',
    s3n: '1662', s3l: 'real merges replayed in tests',
    winTitle: 'myapp — merge feature/settings',
    winStatus: '56 settled · 1 for you',
    cfEyebrow: 'In under a second',
    cfTitle: 'This conflict was never a decision.',
    cfBody: 'GitWand reads the semantics of the code, not just the lines. It recognises the pattern, applies the resolution and keeps the trace. You can read it back, replay it, challenge it.',
    cfCta: 'How the engine works →',
    cfHunk: 'hunk 1 / 57',
    cfVerdict: '✓ prefer-theirs · confidence 97% · semantic',
    cfTrace: 'see the trace →',
    bTitle: 'Deterministic where the others guess',
    bSub: 'Six reasons to keep it open all day.',
    b1k: 'Deterministic', b1t: 'A score and a trace for every hunk',
    b1d: 'Not one line was guessed. Every resolution is auditable, and replayable exactly.',
    b1tag: '0 hallucinations',
    b2k: 'Native', b2n: '~8 MB', b2d: 'Tauri 2 + Rust. Starts in under a second, not 150 MB of Electron.',
    b3k: 'Keyboard', b3d: 'everything from the keyboard, nothing to hunt for',
    b4k: 'Local', b4n: '100%', b4d: 'Your code stays on your machine. No account, no telemetry.',
    b5k: 'MCP server', b5t: 'The same engine, wired into your agents',
    b6k: 'Free', b6n: 'MIT', b6d: 'No seat licence, no trial wall, no account.',
    band1: 'resolution patterns', band2: 'real merges replayed',
    band3: 'interfaces, one engine', band4: 'hallucinations',
    pTitle: 'The eight patterns', pSub: 'Registry v1.4, per-hunk confidence scoring.',
    p1: 'Two indentation styles go in, one comes out.',
    p2: 'You were both right, identically.',
    p3: 'Only one side touched the area.',
    p4: 'The imports moved, the code did not.',
    p5: 'Two additions at the hunk edges, no overlap.',
    p6t: '+3 in the registry', p6: 'Orchestrated by a versioned pattern registry.',
    iTitle: 'One engine, three ways to use it',
    iSub: 'Same resolutions, same traces, everywhere.',
    i1t: 'Desktop app', i1d: 'Graph, diffs, PRs, worktrees and the day’s inbox in one native window.',
    i2t: 'CLI', i2d: 'Scriptable, CI-friendly, full JSON output.',
    i3t: 'VS Code extension', i3d: 'The engine where you already write, without switching windows.',
    cli1: 'gitwand merge feature/settings', cli2: '✓ 56 hunks resolved',
    cli3: '⚑ 1 hunk for you — api/client.ts', cli4: '→ trace: .gitwand/traces/merge.json',
    aEyebrow: 'MCP · official registry · stdio · no API key',
    aTitle: 'Your agents are good at code. Bad at merges.',
    aBody: 'The MCP server settles the hunks that carry no decision and hands the hard cases to the agent with the full context: ours, theirs, base and the trace.',
    aCta: 'Explore AI agents →', aCmdNote: '# one command is enough',
    cmpTitle: 'Against the other clients', cmpCta: 'Full comparison →',
    cmpAiOnly: 'AI only',
    dlMeta: 'v3.11.0 — MIT',
  },
  fr: {
    badge: "v3.11 — l'IA sait enfin pourquoi chaque côté a modifié le code en conflit",
    h1a: 'Le merge se termine', h1b: 'sans toi', h1c: '.',
    sub: 'Huit patterns déterministes classent chaque hunk, règlent ceux qui ne demandaient aucune décision, et te laissent uniquement ce qui vaut ton attention. Natif, local, MIT.',
    cta: 'Télécharger GitWand',
    copy: 'Copier', copied: 'Copié',
    s1n: '57', s1l: 'hunks réglés au dernier merge',
    s2n: '0,9 s', s2l: 'pour les classer tous',
    s3n: '1662', s3l: 'merges réels rejoués en test',
    winTitle: 'myapp — merge feature/settings',
    winStatus: '56 réglés · 1 pour toi',
    cfEyebrow: 'En moins d’une seconde',
    cfTitle: 'Ce conflit n’était pas une décision.',
    cfBody: 'GitWand lit la sémantique du code, pas seulement les lignes. Il reconnaît le pattern, applique la résolution et garde la trace. Tu peux la relire, la rejouer, la contester.',
    cfCta: 'Comment fonctionne le moteur →',
    cfHunk: 'hunk 1 / 57',
    cfVerdict: '✓ prefer-theirs · confiance 97% · sémantique',
    cfTrace: 'voir la trace →',
    bTitle: 'Déterministe là où les autres devinent',
    bSub: 'Six raisons de le garder ouvert toute la journée.',
    b1k: 'Déterministe', b1t: 'Un score et une trace pour chaque hunk',
    b1d: 'Aucune ligne n’a été devinée. Chaque résolution est auditable, et rejouable à l’identique.',
    b1tag: '0 hallucination',
    b2k: 'Natif', b2n: '~8 Mo', b2d: 'Tauri 2 + Rust. Démarrage sous la seconde, pas 150 Mo d’Electron.',
    b3k: 'Clavier', b3d: 'tout au clavier, rien à chercher',
    b4k: 'Local', b4n: '100 %', b4d: 'Ton code reste sur ta machine. Pas de compte, pas de télémétrie.',
    b5k: 'Serveur MCP', b5t: 'Le même moteur, branché sur tes agents',
    b6k: 'Libre', b6n: 'MIT', b6d: 'Pas de licence par siège, pas de mur d’essai, pas de compte.',
    band1: 'patterns de résolution', band2: 'merges réels rejoués',
    band3: 'interfaces, un seul moteur', band4: 'hallucination',
    pTitle: 'Les huit patterns', pSub: 'Registre v1.4, scoring de confiance par hunk.',
    p1: 'Deux styles d’indentation entrent, un seul ressort.',
    p2: 'Vous aviez tous les deux raison, à l’identique.',
    p3: 'Un seul côté a touché la zone.',
    p4: 'Les imports ont bougé, pas le code.',
    p5: 'Deux ajouts en bord de hunk, aucun recouvrement.',
    p6t: '+3 dans le registre', p6: 'Orchestrés par un pattern registry versionné.',
    iTitle: 'Un moteur, trois façons de l’utiliser',
    iSub: 'Mêmes résolutions, mêmes traces, partout.',
    i1t: 'Application desktop', i1d: 'Graphe, diffs, PR, worktrees et inbox du jour dans une fenêtre native.',
    i2t: 'CLI', i2d: 'Scriptable, utilisable en CI, sortie JSON complète.',
    i3t: 'Extension VS Code', i3d: 'Le moteur là où tu écris déjà, sans changer de fenêtre.',
    cli1: 'gitwand merge feature/settings', cli2: '✓ 56 hunks résolus',
    cli3: '⚑ 1 hunk pour toi — api/client.ts', cli4: '→ trace : .gitwand/traces/merge.json',
    aEyebrow: 'MCP · registre officiel · stdio · sans clé API',
    aTitle: 'Tes agents sont bons en code. Mauvais en merge.',
    aBody: 'Le serveur MCP règle les hunks sans décision et transmet à l’agent les cas durs avec tout le contexte : ours, theirs, base et la trace.',
    aCta: 'Explorer les agents IA →', aCmdNote: '# une commande suffit',
    cmpTitle: 'Face aux autres clients', cmpCta: 'Comparatif complet →',
    cmpAiOnly: 'IA seule',
    dlMeta: 'v3.11.0 — MIT',
  },
  es: {
    badge: 'v3.11 — la IA ya sabe por qué cada lado cambió el código en conflicto',
    h1a: 'El merge termina', h1b: 'sin ti', h1c: '.',
    sub: 'Ocho patrones deterministas clasifican cada hunk, resuelven los que no exigían ninguna decisión y te devuelven solo lo que merece tu atención. Nativo, local, MIT.',
    cta: 'Descargar GitWand',
    copy: 'Copiar', copied: 'Copiado',
    s1n: '57', s1l: 'hunks resueltos en el último merge',
    s2n: '0,9 s', s2l: 'para clasificarlos todos',
    s3n: '1662', s3l: 'merges reales reproducidos en pruebas',
    winTitle: 'myapp — merge feature/settings',
    winStatus: '56 resueltos · 1 para ti',
    cfEyebrow: 'En menos de un segundo',
    cfTitle: 'Este conflicto nunca fue una decisión.',
    cfBody: 'GitWand lee la semántica del código, no solo las líneas. Reconoce el patrón, aplica la resolución y guarda la traza. Puedes releerla, reproducirla, discutirla.',
    cfCta: 'Cómo funciona el motor →',
    cfHunk: 'hunk 1 / 57',
    cfVerdict: '✓ prefer-theirs · confianza 97% · semántico',
    cfTrace: 'ver la traza →',
    bTitle: 'Determinista donde los demás adivinan',
    bSub: 'Seis razones para dejarlo abierto todo el día.',
    b1k: 'Determinista', b1t: 'Una puntuación y una traza para cada hunk',
    b1d: 'Ninguna línea fue adivinada. Cada resolución es auditable y reproducible al detalle.',
    b1tag: '0 alucinaciones',
    b2k: 'Nativo', b2n: '~8 MB', b2d: 'Tauri 2 + Rust. Arranca en menos de un segundo, no 150 MB de Electron.',
    b3k: 'Teclado', b3d: 'todo desde el teclado, nada que buscar',
    b4k: 'Local', b4n: '100 %', b4d: 'Tu código se queda en tu máquina. Sin cuenta, sin telemetría.',
    b5k: 'Servidor MCP', b5t: 'El mismo motor, conectado a tus agentes',
    b6k: 'Libre', b6n: 'MIT', b6d: 'Sin licencia por puesto, sin muro de prueba, sin cuenta.',
    band1: 'patrones de resolución', band2: 'merges reales reproducidos',
    band3: 'interfaces, un solo motor', band4: 'alucinaciones',
    pTitle: 'Los ocho patrones', pSub: 'Registro v1.4, puntuación de confianza por hunk.',
    p1: 'Entran dos estilos de indentación, sale uno.',
    p2: 'Los dos teníais razón, de forma idéntica.',
    p3: 'Solo un lado tocó la zona.',
    p4: 'Los imports se movieron, el código no.',
    p5: 'Dos añadidos en los bordes del hunk, sin solapamiento.',
    p6t: '+3 en el registro', p6: 'Orquestados por un pattern registry versionado.',
    iTitle: 'Un motor, tres formas de usarlo',
    iSub: 'Las mismas resoluciones, las mismas trazas, en todas partes.',
    i1t: 'Aplicación de escritorio', i1d: 'Grafo, diffs, PR, worktrees y la bandeja del día en una ventana nativa.',
    i2t: 'CLI', i2d: 'Scriptable, lista para CI, salida JSON completa.',
    i3t: 'Extensión de VS Code', i3d: 'El motor donde ya escribes, sin cambiar de ventana.',
    cli1: 'gitwand merge feature/settings', cli2: '✓ 56 hunks resueltos',
    cli3: '⚑ 1 hunk para ti — api/client.ts', cli4: '→ traza: .gitwand/traces/merge.json',
    aEyebrow: 'MCP · registro oficial · stdio · sin clave API',
    aTitle: 'Tus agentes son buenos con el código. Malos con los merges.',
    aBody: 'El servidor MCP resuelve los hunks sin decisión y pasa los casos difíciles al agente con todo el contexto: ours, theirs, base y la traza.',
    aCta: 'Explorar agentes de IA →', aCmdNote: '# basta con un comando',
    cmpTitle: 'Frente a los demás clientes', cmpCta: 'Comparativa completa →',
    cmpAiOnly: 'solo IA',
    dlMeta: 'v3.11.0 — MIT',
  },
  'pt-BR': {
    badge: 'v3.11 — a IA agora sabe por que cada lado alterou o código em conflito',
    h1a: 'O merge termina', h1b: 'sem você', h1c: '.',
    sub: 'Oito padrões determinísticos classificam cada hunk, resolvem os que não exigiam decisão nenhuma e devolvem só o que merece a sua atenção. Nativo, local, MIT.',
    cta: 'Baixar o GitWand',
    copy: 'Copiar', copied: 'Copiado',
    s1n: '57', s1l: 'hunks resolvidos no último merge',
    s2n: '0,9 s', s2l: 'para classificar todos',
    s3n: '1662', s3l: 'merges reais reproduzidos em teste',
    winTitle: 'myapp — merge feature/settings',
    winStatus: '56 resolvidos · 1 para você',
    cfEyebrow: 'Em menos de um segundo',
    cfTitle: 'Este conflito nunca foi uma decisão.',
    cfBody: 'O GitWand lê a semântica do código, não apenas as linhas. Ele reconhece o padrão, aplica a resolução e guarda o rastro. Você pode reler, reproduzir e contestar.',
    cfCta: 'Como o motor funciona →',
    cfHunk: 'hunk 1 / 57',
    cfVerdict: '✓ prefer-theirs · confiança 97% · semântico',
    cfTrace: 'ver o rastro →',
    bTitle: 'Determinístico onde os outros chutam',
    bSub: 'Seis motivos para deixar aberto o dia inteiro.',
    b1k: 'Determinístico', b1t: 'Uma pontuação e um rastro para cada hunk',
    b1d: 'Nenhuma linha foi chutada. Toda resolução é auditável e reproduzível de forma idêntica.',
    b1tag: '0 alucinação',
    b2k: 'Nativo', b2n: '~8 MB', b2d: 'Tauri 2 + Rust. Abre em menos de um segundo, não 150 MB de Electron.',
    b3k: 'Teclado', b3d: 'tudo pelo teclado, nada para procurar',
    b4k: 'Local', b4n: '100 %', b4d: 'Seu código fica na sua máquina. Sem conta, sem telemetria.',
    b5k: 'Servidor MCP', b5t: 'O mesmo motor, ligado aos seus agentes',
    b6k: 'Livre', b6n: 'MIT', b6d: 'Sem licença por assento, sem muro de teste, sem conta.',
    band1: 'padrões de resolução', band2: 'merges reais reproduzidos',
    band3: 'interfaces, um só motor', band4: 'alucinação',
    pTitle: 'Os oito padrões', pSub: 'Registro v1.4, pontuação de confiança por hunk.',
    p1: 'Entram dois estilos de indentação, sai um.',
    p2: 'Vocês dois estavam certos, de forma idêntica.',
    p3: 'Só um lado tocou na área.',
    p4: 'Os imports mudaram de lugar, o código não.',
    p5: 'Duas adições nas bordas do hunk, sem sobreposição.',
    p6t: '+3 no registro', p6: 'Orquestrados por um pattern registry versionado.',
    iTitle: 'Um motor, três formas de usar',
    iSub: 'As mesmas resoluções, os mesmos rastros, em todo lugar.',
    i1t: 'Aplicativo desktop', i1d: 'Grafo, diffs, PRs, worktrees e a caixa do dia em uma janela nativa.',
    i2t: 'CLI', i2d: 'Scriptável, pronta para CI, saída JSON completa.',
    i3t: 'Extensão do VS Code', i3d: 'O motor onde você já escreve, sem trocar de janela.',
    cli1: 'gitwand merge feature/settings', cli2: '✓ 56 hunks resolvidos',
    cli3: '⚑ 1 hunk para você — api/client.ts', cli4: '→ rastro: .gitwand/traces/merge.json',
    aEyebrow: 'MCP · registro oficial · stdio · sem chave de API',
    aTitle: 'Seus agentes são bons em código. Ruins em merge.',
    aBody: 'O servidor MCP resolve os hunks sem decisão e entrega os casos difíceis ao agente com todo o contexto: ours, theirs, base e o rastro.',
    aCta: 'Explorar agentes de IA →', aCmdNote: '# um comando basta',
    cmpTitle: 'Diante dos outros clientes', cmpCta: 'Comparativo completo →',
    cmpAiOnly: 'só IA',
    dlMeta: 'v3.11.0 — MIT',
  },
  'zh-CN': {
    badge: 'v3.11 — AI 现在知道每一方为何修改了冲突代码',
    h1a: '合并结束时', h1b: '不必再找你', h1c: '。',
    sub: '八种确定性模式为每个 hunk 分类，自动处理那些本就无需决策的部分，只把值得你关注的留给你。原生、本地、MIT。',
    cta: '下载 GitWand',
    copy: '复制', copied: '已复制',
    s1n: '57', s1l: '上次合并自动处理的 hunk',
    s2n: '0.9 秒', s2l: '完成全部分类',
    s3n: '1662', s3l: '测试中重放的真实合并',
    winTitle: 'myapp — merge feature/settings',
    winStatus: '56 个已处理 · 1 个待你确认',
    cfEyebrow: '不到一秒',
    cfTitle: '这个冲突从来就不是一个决策。',
    cfBody: 'GitWand 读的是代码语义，而不只是行。它识别模式、应用解决方案并保留轨迹。你可以回看、重放，也可以推翻它。',
    cfCta: '了解引擎如何工作 →',
    cfHunk: 'hunk 1 / 57',
    cfVerdict: '✓ prefer-theirs · 置信度 97% · 语义',
    cfTrace: '查看轨迹 →',
    bTitle: '别人靠猜，它靠确定性',
    bSub: '六个理由，让它整天开着。',
    b1k: '确定性', b1t: '每个 hunk 都有分数和轨迹',
    b1d: '没有一行是猜出来的。每次解决都可审计，并且能原样重放。',
    b1tag: '0 次幻觉',
    b2k: '原生', b2n: '约 8 MB', b2d: 'Tauri 2 + Rust。一秒内启动，而不是 150 MB 的 Electron。',
    b3k: '键盘', b3d: '全部用键盘完成，无需四处寻找',
    b4k: '本地', b4n: '100%', b4d: '代码留在你的机器上。无账号，无遥测。',
    b5k: 'MCP 服务器', b5t: '同一个引擎，接入你的智能体',
    b6k: '自由', b6n: 'MIT', b6d: '没有按席位授权，没有试用墙，不用注册。',
    band1: '种解决模式', band2: '次重放的真实合并',
    band3: '个界面，同一个引擎', band4: '次幻觉',
    pTitle: '八种模式', pSub: '注册表 v1.4，按 hunk 计算置信度。',
    p1: '两种缩进风格进去，只出来一种。',
    p2: '你们两边都对，而且一模一样。',
    p3: '只有一侧改动了这个区域。',
    p4: 'import 换了位置，代码没变。',
    p5: 'hunk 两端各有新增，互不重叠。',
    p6t: '注册表中还有 3 种', p6: '由带版本号的 pattern registry 统一调度。',
    iTitle: '一个引擎，三种用法',
    iSub: '同样的解决方案，同样的轨迹，处处一致。',
    i1t: '桌面应用', i1d: '提交图、差异、PR、worktree 和当日收件箱，都在一个原生窗口里。',
    i2t: '命令行', i2d: '可脚本化，可用于 CI，输出完整 JSON。',
    i3t: 'VS Code 扩展', i3d: '引擎就在你写代码的地方，无需切换窗口。',
    cli1: 'gitwand merge feature/settings', cli2: '✓ 已解决 56 个 hunk',
    cli3: '⚑ 1 个 hunk 待你处理 — api/client.ts', cli4: '→ 轨迹：.gitwand/traces/merge.json',
    aEyebrow: 'MCP · 官方注册表 · stdio · 无需 API 密钥',
    aTitle: '你的智能体擅长写代码，却不擅长合并。',
    aBody: 'MCP 服务器处理掉无需决策的 hunk，并把难题连同完整上下文交给智能体：ours、theirs、base 和轨迹。',
    aCta: '了解 AI 智能体 →', aCmdNote: '# 一条命令就够了',
    cmpTitle: '与其他客户端相比', cmpCta: '完整对比 →',
    cmpAiOnly: '仅 AI',
    dlMeta: 'v3.11.0 — MIT',
  },
}
const nt = computed(() => NC[locale.value])

// ── Commande d'installation copiable (hero) ─────────────────────────────────
const INSTALL_CMD = 'npm i -g @gitwand/cli'
const copied = ref(false)
async function copyInstall() {
  try {
    await navigator.clipboard.writeText(INSTALL_CMD)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1800)
  } catch {
    /* presse-papiers indisponible : l'utilisateur peut toujours sélectionner le texte */
  }
}

// Les cinq patterns nommés sur la landing ; les trois autres vivent dans le registre.
const NC_PATTERNS = ['whitespace_only', 'same_change', 'one_side_change', 'reorder_only', 'insertion_at_boundary']

// Comparatif compact du haut de page — le tableau complet reste sur /compare.
const NC_COMPARE: { key: string; gw: string; ghd: string; gk: string }[] = [
  { key: 'mcRow1', gw: '✓', ghd: '✗', gk: 'ai' },
  { key: 'mcRow2', gw: '✓', ghd: '✓', gk: '✗' },
  { key: 'mcRow3', gw: '✓', ghd: '✗', gk: '✗' },
  { key: 'mcRow4', gw: '✓', ghd: '✗', gk: '✓' },
]


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

// ── Apparition au défilement (thème Nocturne) ────────────────────────────────
// Posé ici plutôt que dans le template : aucune section n'a à porter l'attribut,
// et le rendu SSR reste identique.
onMounted(() => {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const targets = Array.from(
    document.querySelectorAll('.gw-landing .nc-wrap > *, .gw-landing .nc-bento > *, .gw-landing .nc-trio > *'),
  )
  targets.forEach((el) => el.setAttribute('data-reveal', ''))
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        e.target.classList.add('is-revealed')
        io.unobserve(e.target)
      })
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
  )
  targets.forEach((el) => io.observe(el))
})
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
    <section class="nc-hero">
      <div class="nc-hero__decor" aria-hidden="true">
        <span class="nc-aurora nc-aurora--accent nc-hero__orb-a"></span>
        <span class="nc-aurora nc-aurora--section nc-hero__orb-b"></span>
        <span class="nc-grid"></span>
      </div>

      <div class="nc-wrap nc-hero__body">
        <a class="nc-pill" href="/changelog">
          <span class="nc-pill__dot"></span>
          {{ nt.badge }}
          <span class="nc-pill__arrow">→</span>
        </a>

        <h1 class="nc-h1">
          {{ nt.h1a }} <span class="nc-shine">{{ nt.h1b }}</span>{{ nt.h1c }}
        </h1>
        <p class="nc-lede">{{ nt.sub }}</p>

        <div class="nc-hero__ctas">
          <a class="nc-btn nc-btn--primary" :href="downloadUrl">{{ nt.cta }}</a>
          <button class="nc-cmd" type="button" @click="copyInstall" :aria-label="nt.copy">
            <span class="nc-cmd__prompt">$</span>
            <code>npm i -g @gitwand/cli</code>
            <span class="nc-cmd__hint">{{ copied ? nt.copied : nt.copy }}</span>
          </button>
        </div>

        <div class="nc-hero__figures">
          <div class="nc-figure"><div class="nc-figure__n">{{ nt.s1n }}</div><div class="nc-figure__l">{{ nt.s1l }}</div></div>
          <div class="nc-figure"><div class="nc-figure__n">{{ nt.s2n }}</div><div class="nc-figure__l">{{ nt.s2l }}</div></div>
          <div class="nc-figure"><div class="nc-figure__n">{{ nt.s3n }}</div><div class="nc-figure__l">{{ nt.s3l }}</div></div>
        </div>
      </div>

      <!-- Capture inclinée : la fenêtre « sort » du fond, puis se fond dedans -->
      <div class="nc-wrap nc-shot">
        <div class="nc-shot__frame">
          <div class="nc-shot__bar">
            <span class="nc-shot__dot"></span><span class="nc-shot__dot"></span><span class="nc-shot__dot"></span>
            <span class="nc-shot__path">{{ nt.winTitle }}</span>
            <span class="nc-shot__status">{{ nt.winStatus }}<span class="nc-caret">_</span></span>
          </div>
          <img
            src="/screenshots/GitWand_dashboard.png"
            :alt="t.heroGuiAlt"
            width="1842" height="931" loading="eager" fetchpriority="high"
            class="nc-shot__img"
            @click="openLightbox(0)"
          />
        </div>
        <div class="nc-shot__fade" aria-hidden="true"></div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         2 · BANDEAU D'INSTALLATION
    ══════════════════════════════════════ -->
    <div class="nc-marquee" aria-hidden="true">
      <div class="nc-marquee__rail">
        <div class="nc-marquee__track" v-for="pass in 2" :key="pass">
          <template v-for="c in ['brew install --cask gitwand','npm i -g @gitwand/cli','winget install gitwand','code --install-extension gitwand','claude mcp add gitwand']" :key="pass + c">
            <span>{{ c }}</span><span class="nc-marquee__sep">◆</span>
          </template>
        </div>
      </div>
    </div>

    <!-- ══════════════════════════════════════
         3 · DÉMO DE CONFLIT — le moment « ah oui »
    ══════════════════════════════════════ -->
    <section id="engine" class="nc-section">
      <div class="nc-wrap nc-split">
        <div class="nc-split__text">
          <span class="nc-eyebrow">{{ nt.cfEyebrow }}</span>
          <h2 class="nc-h2">{{ nt.cfTitle }}</h2>
          <p class="nc-body">{{ nt.cfBody }}</p>
          <a class="nc-btn nc-btn--ghost" href="/conflict-engine">{{ nt.cfCta }}</a>
        </div>

        <div class="nc-panel">
          <div class="nc-panel__head">
            <span>src/theme.ts</span><span class="nc-panel__hunk">{{ nt.cfHunk }}</span>
          </div>
          <div class="nc-panel__code">
            <span class="nc-panel__sweep" aria-hidden="true"></span>
            <div class="nc-code-marker">&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD</div>
            <div class="nc-code-drop">const theme = 'dark'</div>
            <div class="nc-code-marker">=======</div>
            <div class="nc-code-keep">const theme = localStorage.getItem('theme') ?? 'dark'</div>
            <div class="nc-code-marker">&gt;&gt;&gt;&gt;&gt;&gt;&gt; feature/settings</div>
          </div>
          <div class="nc-panel__foot">
            <span class="nc-panel__verdict">{{ nt.cfVerdict }}</span>
            <a href="/conflict-engine">{{ nt.cfTrace }}</a>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         4 · BENTO — six raisons
    ══════════════════════════════════════ -->
    <section class="nc-section">
      <div class="nc-wrap">
        <div class="nc-head">
          <h2 class="nc-h2">{{ nt.bTitle }}</h2>
          <span class="nc-head__sub">{{ nt.bSub }}</span>
        </div>
        <div class="nc-bento">
          <div class="nc-card">
            <span class="nc-eyebrow nc-eyebrow--sm">{{ nt.b1k }}</span>
            <div class="nc-card__title">{{ nt.b1t }}</div>
            <p class="nc-card__desc">{{ nt.b1d }}</p>
            <div class="nc-tags"><span class="nc-tag">{{ nt.b1tag }}</span></div>
          </div>
          <div class="nc-card nc-card--stat">
            <span class="nc-eyebrow nc-eyebrow--sm">{{ nt.b2k }}</span>
            <div><div class="nc-card__n">{{ nt.b2n }}</div><div class="nc-card__desc">{{ nt.b2d }}</div></div>
          </div>
          <div class="nc-card nc-card--stat">
            <span class="nc-eyebrow nc-eyebrow--sm">{{ nt.b3k }}</span>
            <div class="nc-keys">
              <kbd class="nc-key">⌘</kbd><kbd class="nc-key">K</kbd>
              <span class="nc-card__desc">{{ nt.b3d }}</span>
            </div>
          </div>
          <div class="nc-card nc-card--stat">
            <span class="nc-eyebrow nc-eyebrow--sm">{{ nt.b4k }}</span>
            <div><div class="nc-card__n">{{ nt.b4n }}</div><div class="nc-card__desc">{{ nt.b4d }}</div></div>
          </div>
          <div class="nc-card">
            <span class="nc-eyebrow nc-eyebrow--sm">{{ nt.b5k }}</span>
            <div class="nc-card__title">{{ nt.b5t }}</div>
            <div class="nc-tags">
              <span class="nc-tag nc-tag--outline">Claude Code</span>
              <span class="nc-tag nc-tag--outline">Cursor</span>
              <span class="nc-tag nc-tag--outline">Windsurf</span>
              <span class="nc-tag nc-tag--outline">Continue</span>
            </div>
          </div>
          <div class="nc-card nc-card--stat">
            <span class="nc-eyebrow nc-eyebrow--sm">{{ nt.b6k }}</span>
            <div><div class="nc-card__n">{{ nt.b6n }}</div><div class="nc-card__desc">{{ nt.b6d }}</div></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         5 · BANDE DE CHIFFRES
    ══════════════════════════════════════ -->
    <section class="nc-band">
      <div class="nc-wrap nc-band__grid">
        <div><div class="nc-band__n">{{ AUTO_PATTERN_COUNT }}</div><div class="nc-band__l">{{ nt.band1 }}</div></div>
        <div><div class="nc-band__n">1662</div><div class="nc-band__l">{{ nt.band2 }}</div></div>
        <div><div class="nc-band__n">3</div><div class="nc-band__l">{{ nt.band3 }}</div></div>
        <div><div class="nc-band__n">0</div><div class="nc-band__l">{{ nt.band4 }}</div></div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         6 · LES HUIT PATTERNS
    ══════════════════════════════════════ -->
    <section id="patterns" class="nc-section">
      <div class="nc-wrap">
        <div class="nc-head">
          <h2 class="nc-h2">{{ nt.pTitle }}</h2>
          <span class="nc-head__sub">{{ nt.pSub }}</span>
        </div>
        <div class="nc-tiles">
          <div class="nc-tile" v-for="(p, i) in NC_PATTERNS" :key="p">
            <span class="nc-tile__n">{{ String(i + 1).padStart(2, '0') }}</span>
            <div class="nc-tile__name">{{ p }}</div>
            <div class="nc-tile__desc">{{ nt['p' + (i + 1)] }}</div>
          </div>
          <div class="nc-tile">
            <span class="nc-tile__n">06 · 07 · 08</span>
            <div class="nc-tile__name nc-tile__name--muted">{{ nt.p6t }}</div>
            <div class="nc-tile__desc">{{ nt.p6 }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         7 · TROIS INTERFACES, UN MOTEUR
    ══════════════════════════════════════ -->
    <section id="interfaces" class="nc-section">
      <div class="nc-wrap">
        <div class="nc-head">
          <h2 class="nc-h2">{{ nt.iTitle }}</h2>
          <span class="nc-head__sub">{{ nt.iSub }}</span>
        </div>
        <div class="nc-trio">
          <a class="nc-face" href="/guide/desktop">
            <img src="/screenshots/GitWand_changes.png" :alt="nt.i1t" loading="lazy" width="1842" height="931" />
            <div class="nc-face__body">
              <div class="nc-face__title">{{ nt.i1t }}</div>
              <div class="nc-face__desc">{{ nt.i1d }}</div>
            </div>
          </a>
          <a class="nc-face" href="/guide/cli">
            <div class="nc-face__term">
              <div><span class="nc-face__prompt">$</span> {{ nt.cli1 }}</div>
              <div class="nc-face__ok">{{ nt.cli2 }}</div>
              <div class="nc-face__warn">{{ nt.cli3 }}</div>
              <div class="nc-face__dim">{{ nt.cli4 }}</div>
            </div>
            <div class="nc-face__body">
              <div class="nc-face__title">{{ nt.i2t }}</div>
              <div class="nc-face__desc">{{ nt.i2d }}</div>
            </div>
          </a>
          <a class="nc-face" href="/guide/vscode">
            <img src="/screenshots/GitWand_GitTree.png" :alt="nt.i3t" loading="lazy" width="1842" height="931" />
            <div class="nc-face__body">
              <div class="nc-face__title">{{ nt.i3t }}</div>
              <div class="nc-face__desc">{{ nt.i3d }}</div>
            </div>
          </a>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         8 · AGENTS IA — serveur MCP
    ══════════════════════════════════════ -->
    <section id="agents" class="nc-section">
      <div class="nc-wrap">
        <div class="nc-spot">
          <div class="nc-spot__text">
            <span class="nc-eyebrow nc-eyebrow--on-spot">{{ nt.aEyebrow }}</span>
            <h2 class="nc-h2 nc-h2--spot">{{ nt.aTitle }}</h2>
            <p class="nc-body nc-body--spot">{{ nt.aBody }}</p>
            <a class="nc-btn nc-btn--primary" href="/ai-agents">{{ nt.aCta }}</a>
          </div>
          <div class="nc-spot__code">
            <div class="nc-spot__comment">{{ nt.aCmdNote }}</div>
            <div>claude mcp add gitwand \</div>
            <div class="nc-spot__cont">-- npx -y @gitwand/mcp</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         9 · COMPARATIF COMPACT
    ══════════════════════════════════════ -->
    <section id="compare" class="nc-section">
      <div class="nc-wrap">
        <div class="nc-head">
          <h2 class="nc-h2">{{ nt.cmpTitle }}</h2>
          <a class="nc-head__link" href="/compare/">{{ nt.cmpCta }}</a>
        </div>
        <div class="nc-matrix">
          <div class="nc-matrix__row nc-matrix__row--head">
            <span></span>
            <span class="nc-matrix__self">GitWand</span>
            <span>GitHub Desktop</span>
            <span>GitKraken</span>
          </div>
          <div class="nc-matrix__row" v-for="row in NC_COMPARE" :key="row.key">
            <span>{{ t[row.key] }}</span>
            <span class="nc-matrix__yes">{{ row.gw }}</span>
            <span :class="row.ghd === '✓' ? 'nc-matrix__other' : 'nc-matrix__no'">{{ row.ghd }}</span>
            <span v-if="row.gk === 'ai'" class="nc-matrix__note">{{ nt.cmpAiOnly }}</span>
            <span v-else :class="row.gk === '✓' ? 'nc-matrix__other' : 'nc-matrix__no'">{{ row.gk }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ══════════════════════════════════════
         10 · TÉLÉCHARGEMENTS
    ══════════════════════════════════════ -->
    <section id="download" class="nc-section">
      <div class="nc-wrap">
        <div class="nc-head">
          <h2 class="nc-h2">{{ t.platformsTitle }}</h2>
          <span class="nc-head__sub">{{ nt.dlMeta }}</span>
        </div>
        <div class="nc-dl">
          <a class="nc-dl__card" :href="dlMac"><span class="nc-dl__name">macOS</span><span class="nc-dl__sub">{{ t.plMacSub }}</span></a>
          <a class="nc-dl__card" :href="dlLinux"><span class="nc-dl__name">Linux</span><span class="nc-dl__sub">{{ t.plLinuxSub }}</span></a>
          <a class="nc-dl__card" :href="dlWin"><span class="nc-dl__name">Windows</span><span class="nc-dl__sub">{{ t.plWinSub }}</span></a>
          <a class="nc-dl__card" href="https://www.npmjs.com/package/@gitwand/cli"><span class="nc-dl__name">{{ t.plCli }}</span><span class="nc-dl__sub">{{ t.plCliSub }}</span></a>
          <a class="nc-dl__card" href="/guide/vscode"><span class="nc-dl__name">{{ t.plVscode }}</span><span class="nc-dl__sub">{{ t.plVscodeSub }}</span></a>
        </div>
      </div>
    </section>

    <!-- Visionneuse plein écran des captures (déclenchée depuis le hero) -->
    <Teleport to="body">
      <div v-if="lightboxOpen" class="lightbox-overlay" @click.self="closeLightbox">
        <button class="lightbox-close" @click="closeLightbox" aria-label="Close">✕</button>
        <button class="lightbox-arrow lightbox-arrow--prev" @click="lightboxPrev" aria-label="Previous">‹</button>
        <img :src="slides[lightboxIndex].src" :alt="slides[lightboxIndex].alt" class="lightbox-img" />
        <button class="lightbox-arrow lightbox-arrow--next" @click="lightboxNext" aria-label="Next">›</button>
        <div class="lightbox-dots">
          <button
            v-for="(s, i) in slides" :key="s.src"
            :class="['lightbox-dot', { 'lightbox-dot--active': i === lightboxIndex }]"
            @click="lightboxIndex = i" :aria-label="s.alt"
          ></button>
        </div>
      </div>
    </Teleport>

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
         12 · BLOG TEASER
    ══════════════════════════════════════ -->
    <section class="blog-teaser-section">
      <div class="section-inner">
        <div class="blog-teaser-header">
          <span class="blog-teaser-label">From the blog</span>
        </div>
        <a href="/blog/v3-11-three-outcomes-not-two" class="blog-teaser-card">
          <div class="blog-teaser-meta">September 21, 2026 · 9 min read</div>
          <h3 class="blog-teaser-title">Three outcomes, not two: what went into GitWand v3.11</h3>
          <p class="blog-teaser-excerpt">The Conflict Predictor stopped predicting and started running the merge, stopping on what needs a person. And a two-line bug report about an "Abort merge" button that lied led to the real fix: an operation ends three ways, not two. It completes, it halts on a further conflict, or it fails.</p>
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
  background: rgba(145, 132, 217, 0.12);
  border: 1px solid rgba(145, 132, 217, 0.35);
  border-radius: 10px;
  backdrop-filter: blur(8px);
}
.lang-pill {
  background: transparent;
  border: none;
  color: var(--nc-accent-300);
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
  background: rgba(145, 132, 217, 0.2);
  color: #e9e5ff;
}
.lang-pill--active {
  background: rgba(145, 132, 217, 0.45);
  color: #ffffff;
}
.lang-pill--active:hover {
  background: rgba(145, 132, 217, 0.55);
  color: #ffffff;
}

/* ───────────────────────────────────────────
   Base
─────────────────────────────────────────── */
.gw-landing {
  /* Alias vers les tokens Nocturne — cf. custom.css */
  --gw-purple:       var(--nc-accent-500);
  --gw-purple-light: var(--nc-accent-300);
  --gw-purple-dark:  var(--nc-accent-700);
  --gw-green:        var(--nc-settled);
  --gw-green-dark:   #5cbb95;
  --gw-bg:           var(--nc-canvas);
  --gw-bg-2:         var(--nc-bg);
  --gw-bg-card:      var(--nc-surface);
  --gw-bg-card-2:    #2b2d3c;
  --gw-border:       var(--nc-neutral-800);
  --gw-border-soft:  var(--nc-rule-soft);
  --gw-text:         var(--nc-text);
  --gw-text-muted:   var(--nc-neutral-400);
  --gw-radius:       var(--nc-radius-lg);
  --gw-surface:      var(--nc-surface);

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
@keyframes orbFloat {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to   { transform: translate3d(-30px, 24px, 0) scale(1.08); }
}
@keyframes announcePulse {
  0%   { box-shadow: 0 0 0 0 rgba(127, 214, 176,0.45); }
  70%  { box-shadow: 0 0 0 7px rgba(127, 214, 176,0); }
  100% { box-shadow: 0 0 0 0 rgba(127, 214, 176,0); }
}

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
.lightbox-arrow:hover { background: rgba(145, 132, 217,0.6); color: #fff; }
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
  background: var(--nc-accent-400);
  transform: scale(1.4);
}
@media (max-width: 600px) {
  .lightbox-arrow { display: none; }
  .lightbox-overlay { gap: 0; padding: 56px 8px 72px; }

}

.platforms-section .section-title {
  margin-bottom: 48px;
}

/* ───────────────────────────────────────────
   CTA FINAL
─────────────────────────────────────────── */
.cta-section {
  padding: 100px 0;
  background: radial-gradient(ellipse 70% 80% at 50% 100%, rgba(145, 132, 217,0.15) 0%, transparent 65%),
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
  border-color: rgba(145, 132, 217,0.4);
  background: rgba(145, 132, 217,0.04);
}
.contributor-card--you:hover {
  border-style: solid;
  background: rgba(145, 132, 217,0.10);
}
.contributor-card--you .contributor-name { color: var(--gw-purple-light); }
.contributor-avatar--you {
  display: grid;
  place-items: center;
  font-size: 22px;
  font-weight: 700;
  color: var(--gw-purple-light);
  background: rgba(145, 132, 217,0.10);
  border-style: dashed;
  border-color: rgba(145, 132, 217,0.4);
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
.compare-section .section-title { margin-bottom: 12px; }
@keyframes toastFloat {
  from { transform: translateY(0); }
  to   { transform: translateY(-7px); }
}
@keyframes termFadeIn {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes termBlink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
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

/* Responsive */
@media (max-width: 860px) {
  .why-grid { grid-template-columns: repeat(2, 1fr); }
}

/* ══════════════════════════════════════════════════════════════
   NOCTURNE — trame de la landing
   Tokens dans custom.css. Rien ici ne redéfinit une couleur.
   ══════════════════════════════════════════════════════════════ */

.gw-landing {
  font-family: var(--nc-font-sans);
  background: var(--nc-canvas);
  color: var(--nc-text);
  overflow-x: clip;
}

.nc-wrap {
  position: relative;
  max-width: var(--nc-measure);
  margin: 0 auto;
  padding: 0 24px;
}
.nc-section { padding-top: var(--nc-section-gap); }

/* ── Typographie ── */
.nc-h1 {
  margin: 0;
  max-width: 11em;
  font-size: clamp(42px, 6.4vw, 78px);
  line-height: 0.98;
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.04em;
  color: var(--nc-accent-100);
}
.nc-h2 {
  margin: 0;
  font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.06;
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.03em;
  color: var(--nc-accent-100);
}
.nc-lede {
  margin: 0;
  font-size: clamp(16px, 1.7vw, 19px);
  line-height: 1.5;
  color: var(--nc-neutral-300);
  max-width: 48ch;
}
.nc-body {
  margin: 0;
  font-size: 16.5px;
  line-height: 1.6;
  color: var(--nc-neutral-300);
  max-width: 44ch;
}
.nc-eyebrow--sm { font-size: 10.5px; letter-spacing: 0.12em; }

.nc-head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.nc-head__sub { font-size: 14.5px; color: var(--nc-neutral-400); }
.nc-head__link { font-size: 14.5px; color: var(--nc-accent-300); text-decoration: none; }
.nc-head__link:hover { color: var(--nc-accent-100); }

/* ── Boutons ── */
.nc-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: var(--nc-radius-md);
  font-weight: 500;
  text-decoration: none;
  transition: transform 0.18s var(--nc-ease), border-color 0.18s var(--nc-ease),
    background 0.18s var(--nc-ease), box-shadow 0.18s var(--nc-ease);
}
.nc-btn--primary {
  padding: 14px 24px;
  font-size: 16px;
  color: var(--nc-accent-100);
  border: 1px solid var(--nc-accent-300);
  background: color-mix(in srgb, var(--nc-accent-800) 72%, transparent);
  box-shadow: var(--nc-glow);
}
.nc-btn--primary:hover {
  background: color-mix(in srgb, var(--nc-accent-700) 88%, transparent);
  transform: translateY(-1px);
}
.nc-btn--ghost {
  align-self: flex-start;
  padding: 9px 14px;
  font-size: 14.5px;
  color: var(--nc-neutral-300);
  border: 1px solid var(--nc-neutral-700);
  background: transparent;
}
.nc-btn--ghost:hover { border-color: var(--nc-accent-500); color: var(--nc-accent-200); }

/* ── Hero ── */
.nc-hero { position: relative; overflow: hidden; }
.nc-hero__decor { position: absolute; inset: 0; pointer-events: none; }
.nc-hero__orb-a { top: -320px; left: 50%; width: 1100px; height: 760px; margin-left: -550px; }
.nc-hero__orb-b { top: -220px; right: -180px; width: 760px; height: 620px; }
.nc-hero__body {
  padding-top: 64px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.nc-pill {
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--nc-accent-100);
  border: 1px solid var(--nc-accent-600);
  border-radius: 999px;
  background: color-mix(in srgb, var(--nc-accent-800) 60%, transparent);
  box-shadow: 0 0 26px color-mix(in srgb, var(--nc-accent) 18%, transparent);
  text-decoration: none;
  transition: border-color 0.18s var(--nc-ease), box-shadow 0.18s var(--nc-ease);
}
.nc-pill:hover {
  border-color: var(--nc-accent-400);
  box-shadow: 0 0 34px color-mix(in srgb, var(--nc-accent) 30%, transparent);
}
.nc-pill__dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--nc-accent-200);
  animation: nc-pulse 1.6s ease-in-out infinite;
}
.nc-pill__arrow { color: var(--nc-accent-300); }

.nc-hero__ctas {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding-top: 4px;
}
.nc-cmd {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  font-family: var(--nc-font-mono);
  font-size: 13px;
  color: var(--nc-neutral-300);
  background: var(--nc-surface);
  border: 1px solid var(--nc-neutral-700);
  border-radius: 9px;
  cursor: pointer;
  transition: border-color 0.18s var(--nc-ease);
}
.nc-cmd:hover { border-color: var(--nc-accent-500); }
.nc-cmd code { font: inherit; background: none; color: inherit; padding: 0; }
.nc-cmd__prompt { color: var(--nc-accent-300); }
.nc-cmd__hint {
  color: var(--nc-neutral-400);
  border-left: 1px solid var(--nc-neutral-800);
  padding-left: 10px;
  min-width: 4.5em;
  text-align: left;
}

.nc-hero__figures { display: flex; gap: 26px; flex-wrap: wrap; padding-top: 10px; }
.nc-figure__n {
  font-size: 30px;
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.02em;
  color: var(--nc-accent-100);
}
.nc-figure__l { font-size: 12.5px; color: var(--nc-neutral-400); }

/* Capture inclinée */
.nc-shot { margin-top: 56px; perspective: 1800px; }
.nc-shot__frame {
  transform: rotateX(6deg);
  transform-origin: 50% 100%;
  border: 1px solid var(--nc-accent-800);
  border-radius: 16px 16px 0 0;
  overflow: hidden;
  background: var(--nc-surface);
  box-shadow: 0 -10px 90px color-mix(in srgb, var(--nc-accent) 22%, transparent), var(--nc-shadow-lg);
}
.nc-shot__bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 15px;
  border-bottom: 1px solid var(--nc-neutral-800);
  font-family: var(--nc-font-mono);
  font-size: 11.5px;
}
.nc-shot__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--nc-neutral-700); }
.nc-shot__path { margin-left: 10px; color: var(--nc-neutral-400); }
.nc-shot__status { margin-left: auto; color: var(--nc-accent-200); }
.nc-caret { animation: nc-blink 1.1s step-end infinite; }
.nc-shot__img { display: block; width: 100%; cursor: zoom-in; }
.nc-shot__fade {
  /* z-index explicite : la fenêtre voisine est en rotateX, donc peinte en
     avant-plan dans le contexte 3D — sans ça le fondu passe dessous. */
  position: absolute;
  z-index: 2;
  inset: auto 0 0 0;
  height: 150px;
  background: linear-gradient(180deg, transparent, var(--nc-canvas));
  pointer-events: none;
}

/* ── Bandeau défilant ── */
.nc-marquee {
  border-top: 1px solid var(--nc-neutral-800);
  border-bottom: 1px solid var(--nc-neutral-800);
  background: var(--nc-bg);
  overflow: hidden;
}
.nc-marquee__rail { display: flex; width: max-content; animation: nc-marquee 26s linear infinite; }
.nc-marquee__track {
  display: flex;
  align-items: center;
  gap: 44px;
  padding: 14px 22px;
  font-family: var(--nc-font-mono);
  font-size: 12.5px;
  color: var(--nc-neutral-400);
  white-space: nowrap;
}
.nc-marquee__sep { color: var(--nc-accent-500); }
@media (prefers-reduced-motion: reduce) { .nc-marquee__rail { animation: none; } 
}

/* ── Démo de conflit ── */
.nc-split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 48px;
  align-items: center;
}
.nc-split__text { display: flex; flex-direction: column; gap: 16px; }

.nc-panel {
  border: 1px solid var(--nc-accent-800);
  border-radius: var(--nc-radius-lg);
  background: var(--nc-surface);
  box-shadow: 0 0 60px color-mix(in srgb, var(--nc-accent) 14%, transparent);
  overflow: hidden;
}
.nc-panel__head,
.nc-panel__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  font-family: var(--nc-font-mono);
  font-size: 11.5px;
  color: var(--nc-neutral-400);
}
.nc-panel__head { border-bottom: 1px solid var(--nc-neutral-800); }
.nc-panel__foot { border-top: 1px solid var(--nc-neutral-800); font-size: 12px; }
.nc-panel__foot a { color: var(--nc-neutral-300); text-decoration: none; }
.nc-panel__foot a:hover { color: var(--nc-accent-200); }
.nc-panel__hunk, .nc-panel__verdict { color: var(--nc-accent-200); }
.nc-panel__code {
  position: relative;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-family: var(--nc-font-mono);
  font-size: 13px;
  line-height: 1.7;
  overflow: hidden;
}
.nc-panel__sweep {
  position: absolute;
  inset: 0;
  width: 28%;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--nc-accent) 20%, transparent), transparent);
  animation: nc-sweep 3.2s linear infinite;
  pointer-events: none;
}
.nc-code-marker { color: var(--nc-neutral-500); }
.nc-code-drop { color: var(--nc-neutral-400); text-decoration: line-through; }
.nc-code-keep {
  color: var(--nc-accent-100);
  background: color-mix(in srgb, var(--nc-accent) 26%, transparent);
  border-left: 2px solid var(--nc-accent-200);
  border-radius: 5px;
  padding: 4px 8px;
  margin: 0 -8px;
}

/* ── Bento ── */
.nc-bento {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 14px;
}
.nc-card {
  min-width: 0;
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-lg);
  padding: 24px;
  background: var(--nc-surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: transform 0.2s var(--nc-ease), border-color 0.2s var(--nc-ease), box-shadow 0.2s var(--nc-ease);
}
.nc-card--stat { justify-content: space-between; gap: 18px; }
.nc-card:hover {
  transform: translateY(-4px);
  border-color: var(--nc-accent-500);
  box-shadow: var(--nc-glow-soft);
}
.nc-card__title { font-size: 20px; font-weight: var(--nc-weight-title); color: var(--nc-accent-100); }
.nc-card__desc { margin: 0; font-size: 14px; line-height: 1.6; color: var(--nc-neutral-400); }
.nc-card__n + .nc-card__desc { margin-top: 12px; }
.nc-card__n {
  font-size: 38px;
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.025em;
  color: var(--nc-accent-100);
  margin-bottom: 6px;
}
.nc-keys { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.nc-key {
  font-family: var(--nc-font-mono);
  font-size: 14px;
  color: var(--nc-accent-100);
  border: 1px solid var(--nc-neutral-700);
  border-bottom-width: 2px;
  border-radius: 7px;
  padding: 7px 11px;
  background: var(--nc-bg);
}
.nc-tags { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 6px; }
.nc-tag {
  font-family: var(--nc-font-mono);
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--nc-accent-700);
  background: color-mix(in srgb, var(--nc-accent-900) 70%, transparent);
  color: var(--nc-accent-200);
}
.nc-tag--outline { background: transparent; border-color: var(--nc-neutral-700); color: var(--nc-neutral-300); }

/* ── Bande de chiffres ── */
.nc-band {
  margin-top: var(--nc-section-gap);
  background: linear-gradient(120deg, var(--nc-section) 0%, var(--nc-section-glow) 100%);
  border-top: 1px solid var(--nc-section-ghost);
  border-bottom: 1px solid var(--nc-section-ghost);
}
.nc-band__grid {
  padding-top: 48px;
  padding-bottom: 48px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 28px;
}
.nc-band__n {
  font-size: clamp(34px, 4.4vw, 52px);
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.03em;
  color: var(--nc-accent-100);
}
.nc-band__l { font-size: 13.5px; color: var(--nc-accent-200); margin-top: 12px; }

/* ── Grille des patterns ── */
.nc-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1px;
  background: var(--nc-neutral-800);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-lg);
  overflow: hidden;
}
.nc-tile {
  background: var(--nc-bg);
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  transition: background 0.2s var(--nc-ease);
}
.nc-tile:hover { background: var(--nc-accent-900); }
.nc-tile__n { font-family: var(--nc-font-mono); font-size: 10.5px; color: var(--nc-accent-300); }
.nc-tile__name { font-family: var(--nc-font-mono); font-size: 14.5px; color: var(--nc-accent-100); }
.nc-tile__name--muted { color: var(--nc-accent-200); }
.nc-tile__desc { font-size: 13.5px; line-height: 1.55; color: var(--nc-neutral-400); }

/* ── Trois interfaces ── */
.nc-trio { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; }
.nc-face {
  display: block;
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-lg);
  overflow: hidden;
  background: var(--nc-surface);
  text-decoration: none;
  transition: transform 0.2s var(--nc-ease), border-color 0.2s var(--nc-ease);
}
.nc-face:hover { transform: translateY(-4px); border-color: var(--nc-accent-600); }
.nc-face img { display: block; width: 100%; border-bottom: 1px solid var(--nc-neutral-800); }
.nc-face__term {
  padding: 20px;
  min-height: 176px;
  font-family: var(--nc-font-mono);
  font-size: 12.5px;
  line-height: 1.95;
  color: var(--nc-neutral-400);
  border-bottom: 1px solid var(--nc-neutral-800);
}
.nc-face__prompt { color: var(--nc-accent-300); }
.nc-face__ok { color: var(--nc-accent-200); }
.nc-face__warn { color: var(--nc-text); }
.nc-face__dim { color: var(--nc-neutral-500); }
.nc-face__body { padding: 20px; display: flex; flex-direction: column; gap: 6px; }
.nc-face__title { font-size: 17px; font-weight: var(--nc-weight-title); color: var(--nc-accent-100); }
.nc-face__desc { font-size: 13.5px; line-height: 1.55; color: var(--nc-neutral-400); }

/* ── Encart agents ── */
.nc-spot {
  position: relative;
  border: 1px solid var(--nc-section-ghost);
  border-radius: var(--nc-radius-xl);
  overflow: hidden;
  background: linear-gradient(135deg, var(--nc-section) 0%, var(--nc-section-glow) 78%);
  box-shadow: 0 0 70px color-mix(in srgb, var(--nc-section-glow) 45%, transparent);
  padding: 44px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  gap: 36px;
  align-items: center;
}
.nc-spot__text { display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
.nc-eyebrow--on-spot { color: var(--nc-accent-200); }
.nc-h2--spot { font-size: clamp(26px, 3.2vw, 38px); }
.nc-body--spot { color: var(--nc-accent-200); max-width: 46ch; }
.nc-spot__code {
  border: 1px solid var(--nc-accent-600);
  border-radius: 12px;
  background: color-mix(in srgb, var(--nc-canvas) 74%, transparent);
  padding: 20px;
  font-family: var(--nc-font-mono);
  font-size: 13px;
  line-height: 1.95;
  color: var(--nc-accent-100);
  overflow-x: auto;
}
.nc-spot__comment { color: var(--nc-accent-300); }
.nc-spot__cont { padding-left: 18px; }

/* ── Comparatif compact ── */
.nc-matrix {
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-lg);
  overflow: hidden;
  background: var(--nc-surface);
}
.nc-matrix__row {
  display: grid;
  grid-template-columns: minmax(160px, 1.8fr) repeat(3, minmax(88px, 1fr));
  align-items: center;
  padding: 17px 22px;
  border-bottom: 1px solid var(--nc-neutral-800);
  font-size: 14.5px;
}
.nc-matrix__row:last-child { border-bottom: 0; }
.nc-matrix__row--head {
  padding: 15px 22px;
  background: var(--nc-accent-900);
  font-family: var(--nc-font-mono);
  font-size: 12.5px;
  color: var(--nc-neutral-400);
}
.nc-matrix__row--head > span:not(:first-child) { text-align: center; }
.nc-matrix__self { color: var(--nc-accent-100); }
.nc-matrix__yes { text-align: center; color: var(--nc-accent-200); font-size: 18px; }
.nc-matrix__other { text-align: center; color: var(--nc-neutral-300); font-size: 18px; }
.nc-matrix__no { text-align: center; color: var(--nc-neutral-600); }
.nc-matrix__note { text-align: center; color: var(--nc-neutral-400); font-size: 12.5px; }

/* ── Tuiles de téléchargement ── */
.nc-dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.nc-dl__card {
  border: 1px solid var(--nc-neutral-800);
  border-radius: 12px;
  padding: 20px;
  background: var(--nc-surface);
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-decoration: none;
  transition: transform 0.2s var(--nc-ease), border-color 0.2s var(--nc-ease);
}
.nc-dl__card:hover { transform: translateY(-3px); border-color: var(--nc-accent-500); }
.nc-dl__name { font-size: 16px; font-weight: 500; color: var(--nc-text); }
.nc-dl__sub { font-size: 13px; color: var(--nc-neutral-400); }

/* ── Ajustements mobiles ── */
@media (max-width: 720px) {
  .nc-section { padding-top: 64px; }
  .nc-band { margin-top: 64px; }
  .nc-spot { padding: 28px; }
  .nc-shot__frame { transform: none; }
  .nc-matrix__row { grid-template-columns: minmax(120px, 1.6fr) repeat(3, minmax(56px, 1fr)); font-size: 13px; padding: 14px; }
  .nc-matrix__row--head { padding: 12px 14px; font-size: 11px; }
}

/* ══════════════════════════════════════════════════════════════
   Sections conservées du site précédent (FAQ, blog, contributeurs,
   sponsoring, CTA final) réaccordées sur la trame Nocturne.
   ══════════════════════════════════════════════════════════════ */

.section-inner { max-width: var(--nc-measure); padding: 0 24px; }

.faq-section,
.blog-teaser-section,
.contributors-section,
.sponsor-section {
  padding-top: var(--nc-section-gap);
  padding-bottom: 0;
  background: var(--nc-canvas);
  border: 0;
}

.section-title {
  text-align: left;
  font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.06;
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.03em;
  color: var(--nc-accent-100);
  margin: 0 0 10px;
}

/* FAQ */
.faq-list { max-width: none; }
.faq-item {
  background: var(--nc-surface);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-lg);
  margin-bottom: 10px;
  transition: border-color 0.2s var(--nc-ease);
}
.faq-item--open { border-color: var(--nc-accent-600); }
.faq-q { color: var(--nc-accent-100); font-weight: var(--nc-weight-title); letter-spacing: -0.012em; padding-left: 20px; padding-right: 20px; }
.faq-a { color: var(--nc-neutral-400); padding-left: 20px; padding-right: 20px; }
.faq-chevron { color: var(--nc-accent-300); }

/* Blog */
.blog-teaser-label,
.contributors-label {
  font-family: var(--nc-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nc-accent-300);
}
.blog-teaser-card,
.contributor-card,
.sponsor-card {
  background: var(--nc-surface);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-lg);
  transition: transform 0.2s var(--nc-ease), border-color 0.2s var(--nc-ease), box-shadow 0.2s var(--nc-ease);
}
.blog-teaser-card:hover,
.contributor-card:hover {
  transform: translateY(-4px);
  border-color: var(--nc-accent-500);
  box-shadow: var(--nc-glow-soft);
}
.blog-teaser-title,
.sponsor-title,
.contributor-name { color: var(--nc-accent-100); font-weight: var(--nc-weight-title); }
.blog-teaser-excerpt,
.sponsor-sub,
.contributor-role,
.blog-teaser-meta { color: var(--nc-neutral-400); }
.blog-teaser-meta { font-family: var(--nc-font-mono); font-size: 11.5px; }
.blog-teaser-cta, .llm-docs-link { color: var(--nc-accent-300); }
.sponsor-btn {
  background: color-mix(in srgb, var(--nc-accent-800) 72%, transparent);
  border: 1px solid var(--nc-accent-300);
  color: var(--nc-accent-100);
  box-shadow: var(--nc-glow);
}

/* CTA final — même traitement que le hero, aurore comprise */
.cta-section {
  position: relative;
  overflow: hidden;
  margin-top: 110px;
  padding: 0;
  border-top: 1px solid var(--nc-neutral-800);
  background: var(--nc-canvas);
}
.cta-section::before {
  content: '';
  position: absolute;
  bottom: -340px;
  left: 50%;
  width: 1000px;
  height: 700px;
  margin-left: -500px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--nc-accent-600) 0%, transparent 62%);
  filter: blur(90px);
  opacity: 0.55;
  animation: nc-aurora-a 18s ease-in-out infinite;
  pointer-events: none;
}
.cta-inner {
  position: relative;
  z-index: 1;
  max-width: var(--nc-measure);
  margin: 0 auto;
  padding: 92px 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 18px;
  text-align: left;
}
.cta-logo { display: none; }
.cta-title {
  margin: 0;
  max-width: 13em;
  font-size: clamp(34px, 5vw, 58px);
  line-height: 1;
  font-weight: var(--nc-weight-title);
  letter-spacing: -0.035em;
  color: var(--nc-accent-100);
  text-align: left;
}
.cta-sub {
  margin: 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--nc-neutral-300);
  max-width: 46ch;
  text-align: left;
}
.cta-btns { justify-content: flex-start; padding-top: 6px; }

/* Boutons hérités */
.btn-primary {
  background: color-mix(in srgb, var(--nc-accent-800) 72%, transparent);
  border: 1px solid var(--nc-accent-300);
  color: var(--nc-accent-100);
  font-weight: 500;
  border-radius: var(--nc-radius-md);
  box-shadow: var(--nc-glow);
}
.btn-primary:hover {
  background: color-mix(in srgb, var(--nc-accent-700) 88%, transparent);
  border-color: var(--nc-accent-200);
  color: var(--nc-accent-100);
}
.btn-ghost {
  border-color: var(--nc-neutral-700);
  color: var(--nc-neutral-300);
  border-radius: var(--nc-radius-md);
  font-weight: 400;
}
.btn-ghost:hover { border-color: var(--nc-accent-500); color: var(--nc-accent-200); }
.btn-split__main { border-right-color: color-mix(in srgb, var(--nc-accent-300) 45%, transparent); }

/* Sélecteur de langue */
.lang-pill {
  font-family: var(--nc-font-mono);
  font-size: 12px;
  color: var(--nc-neutral-400);
  border-color: var(--nc-neutral-800);
  background: color-mix(in srgb, var(--nc-surface) 85%, transparent);
}
.lang-pill--active {
  background: color-mix(in srgb, var(--nc-accent-800) 85%, transparent);
  color: var(--nc-accent-100);
  border-color: var(--nc-accent-600);
}
.lang-pill--active:hover {
  background: color-mix(in srgb, var(--nc-accent-700) 90%, transparent);
  color: var(--nc-accent-100);
}

/* Grilles : deux rangées de trois plutôt qu'une rangée de quatre + un trou */
@media (min-width: 1024px) {
  .nc-bento, .nc-tiles { grid-template-columns: repeat(3, 1fr); }
}
</style>
