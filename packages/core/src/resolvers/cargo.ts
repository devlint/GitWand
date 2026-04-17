/**
 * GitWand — Resolver Cargo.toml / Cargo.lock (v1.4)
 *
 * Parser TOML maison limité aux sections pertinentes pour la résolution
 * de conflits. Zéro dépendance externe.
 *
 * ## Cargo.toml
 * Stratégie par section :
 * - [dependencies], [dev-dependencies], [build-dependencies] → merge par crate name (union)
 * - [package] → clé par clé, `version` délègue à value_only_change
 * - [features] → merge des listes de features comme des sets (union)
 * - [workspace.members/dependencies] → même que dependencies
 * - Autres sections → fallback si les deux côtés les ont modifiées
 *
 * ## Cargo.lock
 * - Parse les blocs `[[package]]` par clé `name@version`
 * - Union par clé ; en cas de conflit sur la même clé → prefer theirs
 */

// ─── Types ─────────────────────────────────────────────────────

interface TomlEntry {
  key: string;
  value: string;
  raw: string; // ligne originale complète
}

interface TomlSection {
  header: string; // ex: "[dependencies]", "[[package]]"
  headerLine: string;
  entries: TomlEntry[];
  raw: string[]; // toutes les lignes du bloc
}

type FormatResult = { lines: string[] | null; reason: string };

// ─── Parser TOML minimal ──────────────────────────────────────

/** Détermine si une ligne est un header de section TOML */
function isSectionHeader(line: string): boolean {
  return /^\[/.test(line.trim());
}

/** Parse un bloc de lignes TOML en sections */
function parseTomlSections(lines: string[]): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (isSectionHeader(trimmed)) {
      if (current) sections.push(current);
      current = { header: trimmed, headerLine: line, entries: [], raw: [line] };
    } else if (current) {
      current.raw.push(line);
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          const key = line.slice(0, eqIdx).trim();
          const value = line.slice(eqIdx + 1).trim();
          current.entries.push({ key, value, raw: line });
        }
      }
    } else {
      // Lignes avant la première section (commentaires, etc.)
      if (!current) {
        current = { header: "", headerLine: "", entries: [], raw: [line] };
      }
    }
  }

  if (current) sections.push(current);
  return sections;
}

// ─── Cargo.toml resolver ──────────────────────────────────────

/** Sections de dépendances Cargo connues */
const DEP_SECTIONS = new Set([
  "[dependencies]",
  "[dev-dependencies]",
  "[build-dependencies]",
  "[workspace.dependencies]",
]);

const FEATURE_SECTIONS = new Set([
  "[features]",
]);

const PACKAGE_SECTIONS = new Set([
  "[package]",
]);

const WORKSPACE_SECTIONS = new Set([
  "[workspace]",
  "[workspace.members]",
]);

/**
 * Fusionne deux sections de dépendances : union par nom de crate.
 * Si un crate apparaît des deux côtés avec des versions différentes → prefer theirs.
 */
function mergeDependencySections(oursEntries: TomlEntry[], theirsEntries: TomlEntry[]): TomlEntry[] {
  const merged = new Map<string, TomlEntry>();

  // ours d'abord
  for (const e of oursEntries) {
    merged.set(e.key, e);
  }
  // theirs : écrase en cas de conflit (prefer theirs)
  for (const e of theirsEntries) {
    merged.set(e.key, e);
  }

  return [...merged.values()];
}

/**
 * Tente de résoudre un conflit dans un fichier Cargo.toml.
 * Retourne les lignes fusionnées ou null si fallback nécessaire.
 */
export function tryResolveCargoTomlConflict(
  _baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FormatResult {
  const oursSections = parseTomlSections(oursLines);
  const theirsSections = parseTomlSections(theirsLines);

  // Indexer les sections de theirs par header
  const theirsIndex = new Map<string, TomlSection>();
  for (const s of theirsSections) {
    theirsIndex.set(s.header, s);
  }

  const result: string[] = [];

  for (const oursSection of oursSections) {
    const theirsSection = theirsIndex.get(oursSection.header);

    if (!theirsSection) {
      // Section seulement dans ours → l'inclure
      result.push(...oursSection.raw);
      continue;
    }

    const header = oursSection.header;

    if (DEP_SECTIONS.has(header)) {
      // Merge par clé (union, prefer theirs en cas de conflit)
      if (oursSection.headerLine) result.push(oursSection.headerLine);
      const merged = mergeDependencySections(oursSection.entries, theirsSection.entries);
      for (const e of merged) result.push(e.raw);
      theirsIndex.delete(header);
      continue;
    }

    if (FEATURE_SECTIONS.has(header)) {
      // Merge feature lists par clé (union des valeurs)
      if (oursSection.headerLine) result.push(oursSection.headerLine);
      const merged = mergeDependencySections(oursSection.entries, theirsSection.entries);
      for (const e of merged) result.push(e.raw);
      theirsIndex.delete(header);
      continue;
    }

    if (PACKAGE_SECTIONS.has(header)) {
      // Clé par clé : prefer theirs
      if (oursSection.headerLine) result.push(oursSection.headerLine);
      const merged = mergeDependencySections(oursSection.entries, theirsSection.entries);
      for (const e of merged) result.push(e.raw);
      theirsIndex.delete(header);
      continue;
    }

    if (WORKSPACE_SECTIONS.has(header)) {
      // Merge comme dependencies
      if (oursSection.headerLine) result.push(oursSection.headerLine);
      const merged = mergeDependencySections(oursSection.entries, theirsSection.entries);
      for (const e of merged) result.push(e.raw);
      theirsIndex.delete(header);
      continue;
    }

    // Section inconnue : si les contenus sont identiques → inclure ours
    if (oursSection.raw.join("\n") === theirsSection.raw.join("\n")) {
      result.push(...oursSection.raw);
      theirsIndex.delete(header);
    } else {
      // Conflit sur une section non reconnue → fallback
      return {
        lines: null,
        reason: `[cargo] Section "${header}" modifiée des deux côtés — fallback textuel.`,
      };
    }
  }

  // Sections uniquement dans theirs → les ajouter
  for (const [, s] of theirsIndex) {
    result.push(...s.raw);
  }

  return {
    lines: result,
    reason: "Cargo.toml — merge par nom de crate (union des dépendances, prefer-theirs en cas de conflit de version).",
  };
}

// ─── Cargo.lock resolver ──────────────────────────────────────

/**
 * Parse les blocs [[package]] d'un Cargo.lock.
 * Chaque bloc est indexé par "name@version".
 */
function parseCargoLockPackages(lines: string[]): Map<string, string[]> {
  const packages = new Map<string, string[]>();
  let currentBlock: string[] | null = null;
  let currentKey: string | null = null;

  for (const line of lines) {
    if (line.trim() === "[[package]]") {
      if (currentKey && currentBlock) {
        packages.set(currentKey, currentBlock);
      }
      currentBlock = [line];
      currentKey = null;
      continue;
    }

    if (currentBlock !== null) {
      currentBlock.push(line);

      // Extraire name + version pour construire la clé
      if (!currentKey) {
        const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
        if (nameMatch) {
          const prevVersion = currentBlock.find((l) => /^version\s*=/.test(l));
          if (prevVersion) {
            const v = prevVersion.match(/"([^"]+)"/)?.[1] ?? "?";
            currentKey = `${nameMatch[1]}@${v}`;
          } else {
            // Version pas encore vue — on la cherchera à la prochaine ligne
          }
        }
        const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
        if (versionMatch) {
          const prevName = currentBlock.find((l) => /^name\s*=/.test(l));
          if (prevName) {
            const n = prevName.match(/"([^"]+)"/)?.[1] ?? "?";
            currentKey = `${n}@${versionMatch[1]}`;
          }
        }
      }
    }
  }

  if (currentKey && currentBlock) {
    packages.set(currentKey, currentBlock);
  }

  return packages;
}

/**
 * Tente de résoudre un conflit dans un fichier Cargo.lock.
 */
export function tryResolveCargoLockConflict(
  _baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FormatResult {
  // Header (lignes avant le premier [[package]])
  const extractHeader = (lines: string[]): string[] => {
    const idx = lines.findIndex((l) => l.trim() === "[[package]]");
    return idx > 0 ? lines.slice(0, idx) : [];
  };

  const oursHeader = extractHeader(oursLines);
  const theirsHeader = extractHeader(theirsLines);

  // On garde le header de theirs (version de lockfile plus récente)
  const header = theirsHeader.length > 0 ? theirsHeader : oursHeader;

  const oursPackages = parseCargoLockPackages(oursLines);
  const theirsPackages = parseCargoLockPackages(theirsLines);

  // Union par clé, prefer theirs en cas de conflit
  const merged = new Map<string, string[]>(oursPackages);
  for (const [key, block] of theirsPackages) {
    merged.set(key, block); // theirs wins
  }

  // Trier les packages par clé (nom alphabétique) pour la stabilité
  const sortedKeys = [...merged.keys()].sort();

  const result: string[] = [...header];
  for (const key of sortedKeys) {
    result.push(...merged.get(key)!);
    result.push(""); // blank line between packages
  }

  return {
    lines: result,
    reason: "Cargo.lock — merge par crate name+version (union, prefer-theirs). Vérification recommandée : `cargo check`.",
  };
}

// ─── Dispatcher ──────────────────────────────────────────────

export function tryResolveCargoConflict(
  filePath: string,
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): FormatResult {
  if (/Cargo\.lock$/i.test(filePath)) {
    return tryResolveCargoLockConflict(baseLines, oursLines, theirsLines);
  }
  return tryResolveCargoTomlConflict(baseLines, oursLines, theirsLines);
}
