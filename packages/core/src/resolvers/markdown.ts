/**
 * GitWand — Résolveur Markdown section-aware
 *
 * Résout les conflits dans les fichiers Markdown en identifiant
 * la structure de sections (headings H1..H6) et en fusionnant
 * section par section lorsque les modifications sont non-overlapping.
 *
 * Stratégie :
 *  1. Détecter les headings dans les trois versions
 *  2. Découper chaque version en sections (heading + contenu jusqu'au prochain heading de niveau ≤)
 *  3. Pour chaque section :
 *      a. Si identique dans ours et theirs → garder
 *      b. Si modifiée d'un seul côté → accepter la modification
 *      c. Si section ajoutée d'un côté → ajouter
 *      d. Si modifiée des deux côtés différemment → conflit partiel (insert les deux versions)
 *  4. Gestion du frontmatter YAML (entre --- au début du fichier) : traité séparément
 *
 * Limites :
 *  - Ne pas résoudre les conflits intra-section (renvoyés au moteur textuel)
 *  - Pas de merge sémantique du contenu riche (listes, tableaux, code)
 */

// ─── Types internes ───────────────────────────────────────

interface MarkdownSection {
  /** Heading complet (ex: "## Mon titre") ou null pour le bloc avant le 1er heading */
  heading: string | null;
  /** Niveau du heading (1..6) ou 0 pour le prologue */
  level: number;
  /** Lignes du contenu (sans le heading) */
  lines: string[];
  /** Index de début dans le tableau de lignes source */
  startIdx: number;
}

// ─── Frontmatter ─────────────────────────────────────────

/**
 * Détecte et extrait le frontmatter YAML si présent (--- au début).
 * Retourne { frontmatter: string[], rest: string[] }.
 */
export function extractFrontmatter(lines: string[]): {
  frontmatter: string[];
  rest: string[];
} {
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { frontmatter: [], rest: lines };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") {
      end = i;
      break;
    }
  }

  if (end === -1) {
    // Pas de frontmatter fermant → traiter comme texte normal
    return { frontmatter: [], rest: lines };
  }

  return {
    frontmatter: lines.slice(0, end + 1),
    rest: lines.slice(end + 1),
  };
}

// ─── Section parsing ──────────────────────────────────────

/**
 * Détecte le niveau d'un heading ATX (`# ... `).
 * Retourne 0 si la ligne n'est pas un heading.
 */
function headingLevel(line: string): number {
  const match = line.match(/^(#{1,6})\s/);
  return match ? match[1].length : 0;
}

/**
 * Découpe un tableau de lignes en sections Markdown.
 * Chaque section commence par un heading ATX.
 * Le contenu avant le premier heading forme une section "prologue" (level 0).
 */
export function parseSections(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let currentSection: MarkdownSection = {
    heading: null,
    level: 0,
    lines: [],
    startIdx: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const level = headingLevel(lines[i]);

    if (level > 0) {
      // Nouveau heading → sauvegarder la section courante, en commencer une nouvelle
      sections.push(currentSection);
      currentSection = {
        heading: lines[i],
        level,
        lines: [],
        startIdx: i,
      };
    } else {
      currentSection.lines.push(lines[i]);
    }
  }

  // Sauvegarder la dernière section
  sections.push(currentSection);

  return sections;
}

// ─── Section key ─────────────────────────────────────────

/**
 * Retourne une clé unique pour identifier une section par son heading.
 * Les sections sans heading utilisent "__prologue__".
 */
function sectionKey(section: MarkdownSection): string {
  return section.heading ?? "__prologue__";
}

/**
 * Compare deux sections (heading + contenu) pour égalité textuelle.
 */
function sectionsEqual(a: MarkdownSection, b: MarkdownSection): boolean {
  if (a.heading !== b.heading) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, i) => line === b.lines[i]);
}

// ─── Merge sections ───────────────────────────────────────

export interface MarkdownMergeResult {
  /** Lignes fusionnées (null si conflit non résolvable) */
  mergedLines: string[] | null;
  /** Sections avec conflit non résolu */
  conflictedSections: string[];
  /** Nombre de sections fusionnées automatiquement */
  resolvedSections: number;
  /** Description de la fusion */
  reason: string;
}

/**
 * Fusionne deux versions Markdown section par section avec une base commune.
 *
 * @param baseLines  - Lignes de la version base
 * @param oursLines  - Lignes de la version ours
 * @param theirsLines - Lignes de la version theirs
 */
export function tryResolveMarkdownConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): MarkdownMergeResult {
  // Extraire frontmatter de chaque version
  const baseFm = extractFrontmatter(baseLines);
  const oursFm = extractFrontmatter(oursLines);
  const theirsFm = extractFrontmatter(theirsLines);

  // Résoudre le frontmatter séparément
  const mergedFrontmatter = resolveFrontmatter(
    baseFm.frontmatter,
    oursFm.frontmatter,
    theirsFm.frontmatter,
  );

  if (mergedFrontmatter === null) {
    return {
      mergedLines: null,
      conflictedSections: ["frontmatter"],
      resolvedSections: 0,
      reason: "Conflit dans le frontmatter YAML — fusion manuelle requise.",
    };
  }

  // Découper en sections
  const baseSections = parseSections(baseFm.rest);
  const oursSections = parseSections(oursFm.rest);
  const theirsSections = parseSections(theirsFm.rest);

  // Indexer par clé
  const baseMap = new Map<string, MarkdownSection>(
    baseSections.map((s) => [sectionKey(s), s]),
  );
  const oursMap = new Map<string, MarkdownSection>(
    oursSections.map((s) => [sectionKey(s), s]),
  );
  const theirsMap = new Map<string, MarkdownSection>(
    theirsSections.map((s) => [sectionKey(s), s]),
  );

  // Ordre des sections : union de toutes les clés dans l'ordre d'apparition
  const orderedKeys = buildSectionOrder(baseSections, oursSections, theirsSections);

  const mergedLines: string[] = [...mergedFrontmatter];
  const conflictedSections: string[] = [];
  let resolvedSections = 0;

  for (const key of orderedKeys) {
    const baseSection = baseMap.get(key);
    const oursSection = oursMap.get(key);
    const theirsSection = theirsMap.get(key);

    const resolution = resolveSectionConflict(baseSection, oursSection, theirsSection, key);

    if (resolution.resolved) {
      const lines = resolution.lines;
      mergedLines.push(...lines);
      resolvedSections++;
    } else {
      // Conflit non résolvable → insérer les deux versions avec marqueurs de section
      conflictedSections.push(key);
      if (oursSection) {
        if (oursSection.heading) mergedLines.push(oursSection.heading);
        mergedLines.push(...oursSection.lines);
      }
      if (theirsSection && !sectionsEqual(oursSection ?? emptySectionFor(key), theirsSection)) {
        // Ajouter la version theirs avec un commentaire d'avertissement
        mergedLines.push(`<!-- ⚠️ GitWand: section "${key}" modifiée des deux côtés -->`);
        if (theirsSection.heading) mergedLines.push(theirsSection.heading);
        mergedLines.push(...theirsSection.lines);
      }
    }
  }

  // Si des conflits partiels → le contenu est produit mais marqué
  if (conflictedSections.length > 0) {
    return {
      mergedLines: null, // Force resolution manuelle si des sections ont conflicté
      conflictedSections,
      resolvedSections,
      reason: `Fusion Markdown partielle : ${resolvedSections} section(s) résolue(s), ${conflictedSections.length} en conflit (${conflictedSections.join(", ")}).`,
    };
  }

  return {
    mergedLines,
    conflictedSections: [],
    resolvedSections,
    reason: `Fusion Markdown réussie : ${resolvedSections} section(s) fusionnée(s) automatiquement.`,
  };
}

// ─── Helpers ──────────────────────────────────────────────

function emptySectionFor(key: string): MarkdownSection {
  return { heading: key === "__prologue__" ? null : key, level: 0, lines: [], startIdx: 0 };
}

/**
 * Résout le frontmatter : simple comparaison textuelle.
 * Si ours = base → prendre theirs. Si theirs = base → prendre ours.
 * Si same → prendre ours. Sinon null (conflit).
 */
function resolveFrontmatter(
  base: string[],
  ours: string[],
  theirs: string[],
): string[] | null {
  if (base.length === 0 && ours.length === 0 && theirs.length === 0) return [];

  const arrEq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((l, i) => l === b[i]);

  if (arrEq(ours, theirs)) return ours;
  if (arrEq(ours, base)) return theirs; // ours n'a pas changé → prendre theirs
  if (arrEq(theirs, base)) return ours; // theirs n'a pas changé → prendre ours
  return null; // conflit
}

/**
 * Détermine l'ordre de fusion des sections en combinant les ordres de ours et theirs.
 * Utilise une heuristique simple : préserver l'ordre de ours, insérer les nouvelles
 * sections de theirs après leur section précédente dans theirs.
 */
function buildSectionOrder(
  base: MarkdownSection[],
  ours: MarkdownSection[],
  theirs: MarkdownSection[],
): string[] {
  const oursKeys = ours.map(sectionKey);
  const theirsKeys = theirs.map(sectionKey);
  const baseKeys = new Set(base.map(sectionKey));

  // Sections présentes dans ours en premier
  const result: string[] = [...oursKeys];
  const resultSet = new Set(result);

  // Ajouter les sections de theirs absentes de ours (sections ajoutées par theirs)
  for (let i = 0; i < theirsKeys.length; i++) {
    const key = theirsKeys[i];
    if (!resultSet.has(key)) {
      // Trouver la bonne position : après la section précédente dans theirs
      const prevKey = i > 0 ? theirsKeys[i - 1] : null;
      const insertIdx = prevKey ? result.indexOf(prevKey) + 1 : 0;
      result.splice(insertIdx, 0, key);
      resultSet.add(key);
    }
  }

  // Retirer les sections supprimées des deux côtés
  return result.filter((key) => {
    const inOurs = oursKeys.includes(key);
    const inTheirs = theirsKeys.includes(key);
    const inBase = baseKeys.has(key);
    // Garder si présent dans au moins une branche active
    return inOurs || inTheirs || !inBase;
  });
}

interface SectionResolution {
  resolved: boolean;
  lines: string[];
}

/**
 * Résout un conflit pour une section donnée.
 */
function resolveSectionConflict(
  base: MarkdownSection | undefined,
  ours: MarkdownSection | undefined,
  theirs: MarkdownSection | undefined,
  key: string,
): SectionResolution {
  const empty = emptySectionFor(key);

  const b = base ?? empty;
  const o = ours ?? empty;
  const t = theirs ?? empty;

  const toLines = (s: MarkdownSection): string[] => {
    const lines: string[] = [];
    if (s.heading) lines.push(s.heading);
    lines.push(...s.lines);
    return lines;
  };

  // Section absente de ours et de base, présente dans theirs → ajout theirs
  if (!ours && !base && theirs) {
    return { resolved: true, lines: toLines(t) };
  }

  // Section absente de theirs et de base, présente dans ours → ajout ours
  if (!theirs && !base && ours) {
    return { resolved: true, lines: toLines(o) };
  }

  // Section supprimée des deux côtés (présente dans base)
  if (base && !ours && !theirs) {
    return { resolved: true, lines: [] };
  }

  // Ours a supprimé, theirs n'a pas changé
  if (base && !ours && theirs && sectionsEqual(b, t)) {
    return { resolved: true, lines: [] };
  }

  // Theirs a supprimé, ours n'a pas changé
  if (base && ours && !theirs && sectionsEqual(b, o)) {
    return { resolved: true, lines: [] };
  }

  // Les deux ont fait la même modification
  if (sectionsEqual(o, t)) {
    return { resolved: true, lines: toLines(o) };
  }

  // Seul ours a changé (theirs = base ou theirs absent)
  if (base && theirs && sectionsEqual(b, t)) {
    return { resolved: true, lines: toLines(o) };
  }

  // Seul theirs a changé (ours = base ou ours absent)
  if (base && ours && sectionsEqual(b, o)) {
    return { resolved: true, lines: toLines(t) };
  }

  // Les deux ont changé différemment → conflit
  return { resolved: false, lines: [] };
}
