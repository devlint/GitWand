/**
 * GitWand — Résolveur sémantique pour pnpm-lock.yaml
 *
 * Format pnpm-lock.yaml :
 *   lockfileVersion: '9.0'
 *   settings:
 *     ...
 *   importers:
 *     .:
 *       dependencies:
 *         react:
 *           specifier: ^18.0.0
 *           version: 18.2.0
 *   packages:
 *     /react@18.2.0:
 *       resolution: {integrity: sha512-...}
 *       ...
 *   snapshots:
 *     /react@18.2.0:
 *       dependencies: ...
 *
 * Stratégie :
 *  Le fichier est structuré en sections YAML top-level.
 *  On fusionne chaque section indépendamment au niveau des entrées clé-valeur.
 *  Les sections `packages` et `snapshots` ont des entrées par paquet résolvable.
 *  La section `importers` décrit les dépendances directes.
 *
 *  Le merge 3-way utilise les lignes YAML indentées pour identifier les blocs.
 */

// ─── Types ───────────────────────────────────────────────

export interface PnpmLockMergeResult {
  /** Contenu fusionné ou null si échec */
  merged: string | null;
  /** Raison de la résolution */
  reason: string;
  /** Nombre d'entrées fusionnées */
  resolvedEntries: number;
  /** Nombre de conflits */
  conflicts: number;
}

// ─── Block parser ────────────────────────────────────────

interface YamlBlock {
  key: string;
  body: string[];
  indent: number;
}

/**
 * Parse un fichier YAML en blocs top-level.
 * Chaque bloc est identifié par une clé au niveau d'indentation 0.
 */
function parseTopLevelBlocks(lines: string[]): {
  preamble: string[];
  blocks: Map<string, string[]>;
  blockOrder: string[];
} {
  const preamble: string[] = [];
  const blocks = new Map<string, string[]>();
  const blockOrder: string[] = [];

  let currentKey: string | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    // Top-level key: starts at column 0, ends with ':'
    const topLevelMatch = line.match(/^(\S[^:]*?):\s*(.*)?$/);

    if (topLevelMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      // Save previous block
      if (currentKey !== null) {
        blocks.set(currentKey, currentBody);
        blockOrder.push(currentKey);
      }

      currentKey = topLevelMatch[1];
      const inlineValue = topLevelMatch[2]?.trim();
      // If there's an inline value (e.g., `lockfileVersion: '9.0'`), store as single line
      currentBody = inlineValue ? [line] : [];
    } else if (currentKey === null) {
      // Before any top-level key → preamble (comments, blank lines)
      preamble.push(line);
    } else {
      currentBody.push(line);
    }
  }

  // Save last block
  if (currentKey !== null) {
    blocks.set(currentKey, currentBody);
    blockOrder.push(currentKey);
  }

  return { preamble, blocks, blockOrder };
}

/**
 * Pour une section comme `packages` ou `snapshots`, parse les sous-entrées
 * (chaque clé indentée de 2 espaces avec son body).
 */
function parseSubEntries(bodyLines: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  let currentKey: string | null = null;
  let currentBody: string[] = [];

  for (const line of bodyLines) {
    // Sub-entry key: indented 2 spaces (or 4 in some formats), key ends with ':'
    const subMatch = line.match(/^(\s{2,4})(\S[^:]*?):\s*$/);
    const subInlineMatch = line.match(/^(\s{2,4})(\S[^:]*?):\s+(.+)$/);

    if ((subMatch || subInlineMatch) && !line.startsWith("      ")) {
      // Save previous sub-entry
      if (currentKey !== null) {
        entries.set(currentKey, currentBody.join("\n"));
      }

      if (subMatch) {
        currentKey = subMatch[2].trim();
        currentBody = [];
      } else if (subInlineMatch) {
        currentKey = subInlineMatch[2].trim();
        currentBody = [line];
      }
    } else if (currentKey !== null) {
      currentBody.push(line);
    }
  }

  // Save last entry
  if (currentKey !== null) {
    entries.set(currentKey, currentBody.join("\n"));
  }

  return entries;
}

// ─── 3-way merge ─────────────────────────────────────────

/**
 * Merge 3-way d'une Map de sous-entrées.
 */
function mergeEntryMap(
  base: Map<string, string>,
  ours: Map<string, string>,
  theirs: Map<string, string>,
): { merged: Map<string, string>; resolved: number; conflicts: number } {
  const allKeys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, string>();
  let resolved = 0;
  let conflicts = 0;

  for (const key of allKeys) {
    const b = base.get(key);
    const o = ours.get(key);
    const t = theirs.get(key);

    if (b === undefined) {
      // New entry
      if (o !== undefined && t !== undefined) {
        merged.set(key, o === t ? o : t);
      } else if (o !== undefined) {
        merged.set(key, o);
      } else if (t !== undefined) {
        merged.set(key, t);
      }
      resolved++;
      continue;
    }

    if (o === undefined && t === undefined) {
      resolved++;
      continue;
    }
    if (o === undefined) {
      if (t === b) { resolved++; continue; }
      merged.set(key, t!);
      resolved++;
      continue;
    }
    if (t === undefined) {
      if (o === b) { resolved++; continue; }
      merged.set(key, o);
      resolved++;
      continue;
    }

    const oChanged = o !== b;
    const tChanged = t !== b;

    if (!oChanged && !tChanged) {
      merged.set(key, b);
    } else if (!oChanged) {
      merged.set(key, t);
    } else if (!tChanged) {
      merged.set(key, o);
    } else if (o === t) {
      merged.set(key, o);
    } else {
      // Conflit → prefer theirs
      merged.set(key, t);
      conflicts++;
    }
    resolved++;
  }

  return { merged, resolved, conflicts };
}

/**
 * Fusionne trois versions d'un pnpm-lock.yaml par section et sous-entrée.
 */
export function tryResolvePnpmLockConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): PnpmLockMergeResult {
  const baseParsed = parseTopLevelBlocks(baseLines);
  const oursParsed = parseTopLevelBlocks(oursLines);
  const theirsParsed = parseTopLevelBlocks(theirsLines);

  let totalResolved = 0;
  let totalConflicts = 0;

  // Merge section par section
  const allSections = new Set([
    ...baseParsed.blockOrder,
    ...oursParsed.blockOrder,
    ...theirsParsed.blockOrder,
  ]);

  const mergedSections = new Map<string, string[]>();
  // Preserve section order from ours
  const sectionOrder = [...oursParsed.blockOrder];
  for (const s of allSections) {
    if (!sectionOrder.includes(s)) sectionOrder.push(s);
  }

  // Sections with sub-entries that should be merged at entry level
  const entryLevelSections = new Set(["packages", "snapshots", "importers"]);

  for (const section of allSections) {
    const baseBody = baseParsed.blocks.get(section);
    const oursBody = oursParsed.blocks.get(section);
    const theirsBody = theirsParsed.blocks.get(section);

    if (entryLevelSections.has(section) && baseBody && oursBody && theirsBody) {
      // Merge at sub-entry level
      const baseEntries = parseSubEntries(baseBody);
      const oursEntries = parseSubEntries(oursBody);
      const theirsEntries = parseSubEntries(theirsBody);

      const { merged, resolved, conflicts } = mergeEntryMap(baseEntries, oursEntries, theirsEntries);
      totalResolved += resolved;
      totalConflicts += conflicts;

      // Reconstruct section body
      const body: string[] = [];
      const sortedKeys = [...merged.keys()].sort();
      for (const key of sortedKeys) {
        const value = merged.get(key)!;
        if (value.includes("\n") || value === "") {
          body.push(`  ${key}:`);
          if (value) body.push(...value.split("\n"));
        } else {
          // Inline value — reconstruct the line
          body.push(value);
        }
      }
      mergedSections.set(section, body);
    } else {
      // Simple section (scalar/header) — use 3-way text compare
      const baseText = baseBody?.join("\n") ?? "";
      const oursText = oursBody?.join("\n") ?? "";
      const theirsText = theirsBody?.join("\n") ?? "";

      if (oursText === theirsText || oursText === baseText) {
        mergedSections.set(section, theirsBody ?? oursBody ?? []);
      } else if (theirsText === baseText) {
        mergedSections.set(section, oursBody ?? []);
      } else {
        // Both changed differently → prefer theirs
        mergedSections.set(section, theirsBody ?? oursBody ?? []);
        totalConflicts++;
      }
      totalResolved++;
    }
  }

  // Reconstruct file
  const outputLines: string[] = [...oursParsed.preamble];

  for (const section of sectionOrder) {
    const body = mergedSections.get(section);
    if (!body) continue;

    if (body.length === 1 && body[0].startsWith(section + ":")) {
      // Inline section (e.g., `lockfileVersion: '9.0'`)
      outputLines.push(body[0]);
    } else {
      outputLines.push(`${section}:`);
      if (body.length > 0) {
        outputLines.push(...body);
      }
    }
    outputLines.push(""); // blank line between sections
  }

  const reason = totalConflicts > 0
    ? `Fusion sémantique pnpm-lock.yaml : ${totalResolved} entrée(s), ${totalConflicts} conflit(s) résolu(s) (prefer-theirs).`
    : `Fusion sémantique pnpm-lock.yaml réussie : ${totalResolved} entrée(s) fusionnée(s) sans conflit.`;

  return {
    merged: outputLines.join("\n"),
    reason,
    resolvedEntries: totalResolved,
    conflicts: totalConflicts,
  };
}
