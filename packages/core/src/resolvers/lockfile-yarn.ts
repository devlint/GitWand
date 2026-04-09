/**
 * GitWand — Résolveur sémantique pour yarn.lock
 *
 * Format yarn.lock (v1) : blocs indépendants de la forme :
 *
 *   "package@^version":
 *     version "1.2.3"
 *     resolved "https://registry..."
 *     integrity sha512-...
 *     dependencies:
 *       dep-a "^1.0"
 *
 * Chaque bloc est identifié par son header (la/les ligne(s) de clé).
 * Le merge se fait par bloc.
 *
 * Stratégie :
 *  1. Parser en blocs (header → body)
 *  2. Merge 3-way par header :
 *     - Ajouté d'un seul côté → prendre
 *     - Supprimé d'un seul côté (pas modifié de l'autre) → supprimer
 *     - Modifié d'un seul côté → prendre la modification
 *     - Modifié des deux côtés, même résultat → ok
 *     - Conflit → prefer theirs
 *  3. Reconstruire le fichier trié
 */

// ─── Types ───────────────────────────────────────────────

export interface YarnLockMergeResult {
  /** Contenu fusionné ou null si échec */
  merged: string | null;
  /** Raison de la résolution */
  reason: string;
  /** Nombre de blocs fusionnés */
  resolvedBlocks: number;
  /** Nombre de conflits de version */
  versionConflicts: number;
}

// ─── Parser ──────────────────────────────────────────────

interface YarnBlock {
  /** Lignes du header (ex: `"react@^18.0.0":`) */
  header: string;
  /** Lignes du body (indentées) */
  body: string;
}

/**
 * Parse un yarn.lock en blocs indépendants.
 * Retourne le commentaire d'en-tête et une Map<header, body>.
 */
function parseYarnLock(content: string): {
  preamble: string;
  blocks: Map<string, string>;
} | null {
  const lines = content.split("\n");
  let preamble = "";
  const blocks = new Map<string, string>();

  let i = 0;

  // Preamble : commentaires en tête
  while (i < lines.length && (lines[i].startsWith("#") || lines[i].trim() === "")) {
    preamble += lines[i] + "\n";
    i++;
  }

  // Parse blocks
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks
    if (line.trim() === "") {
      i++;
      continue;
    }

    // A header line starts at column 0 and is not a comment
    if (!line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#")) {
      const header = line;
      i++;

      // Collect body lines (indented)
      const bodyLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t") || lines[i].trim() === "")) {
        // Stop at blank line that precedes next header
        if (lines[i].trim() === "" && i + 1 < lines.length && !lines[i + 1].startsWith(" ") && !lines[i + 1].startsWith("\t") && lines[i + 1].trim() !== "") {
          break;
        }
        if (lines[i].trim() !== "") {
          bodyLines.push(lines[i]);
        }
        i++;
      }

      blocks.set(header, bodyLines.join("\n"));
    } else {
      i++;
    }
  }

  return { preamble, blocks };
}

// ─── 3-way merge ─────────────────────────────────────────

/**
 * Fusionne trois versions d'un yarn.lock par bloc de paquet.
 */
export function tryResolveYarnLockConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): YarnLockMergeResult {
  const baseParsed = parseYarnLock(baseLines.join("\n"));
  const oursParsed = parseYarnLock(oursLines.join("\n"));
  const theirsParsed = parseYarnLock(theirsLines.join("\n"));

  if (!baseParsed || !oursParsed || !theirsParsed) {
    return {
      merged: null,
      reason: "Impossible de parser une des versions du yarn.lock.",
      resolvedBlocks: 0,
      versionConflicts: 0,
    };
  }

  const baseBlocks = baseParsed.blocks;
  const oursBlocks = oursParsed.blocks;
  const theirsBlocks = theirsParsed.blocks;

  const allHeaders = new Set([...baseBlocks.keys(), ...oursBlocks.keys(), ...theirsBlocks.keys()]);

  const mergedBlocks = new Map<string, string>();
  let resolvedBlocks = 0;
  let versionConflicts = 0;

  for (const header of allHeaders) {
    const base = baseBlocks.get(header);
    const ours = oursBlocks.get(header);
    const theirs = theirsBlocks.get(header);

    // Pas dans base → ajout
    if (base === undefined) {
      if (ours !== undefined && theirs !== undefined) {
        mergedBlocks.set(header, ours === theirs ? ours : theirs);
        resolvedBlocks++;
      } else if (ours !== undefined) {
        mergedBlocks.set(header, ours);
        resolvedBlocks++;
      } else if (theirs !== undefined) {
        mergedBlocks.set(header, theirs);
        resolvedBlocks++;
      }
      continue;
    }

    // Supprimé des deux → ok
    if (ours === undefined && theirs === undefined) {
      resolvedBlocks++;
      continue;
    }

    // Supprimé d'un côté
    if (ours === undefined) {
      if (theirs === base) {
        resolvedBlocks++; // pas modifié, supprimé par ours → ok
      } else {
        mergedBlocks.set(header, theirs!); // modifié par theirs → garder
        resolvedBlocks++;
      }
      continue;
    }
    if (theirs === undefined) {
      if (ours === base) {
        resolvedBlocks++; // pas modifié, supprimé par theirs → ok
      } else {
        mergedBlocks.set(header, ours); // modifié par ours → garder
        resolvedBlocks++;
      }
      continue;
    }

    // Présent partout
    const oursChanged = ours !== base;
    const theirsChanged = theirs !== base;

    if (!oursChanged && !theirsChanged) {
      mergedBlocks.set(header, base);
      resolvedBlocks++;
    } else if (!oursChanged) {
      mergedBlocks.set(header, theirs);
      resolvedBlocks++;
    } else if (!theirsChanged) {
      mergedBlocks.set(header, ours);
      resolvedBlocks++;
    } else if (ours === theirs) {
      mergedBlocks.set(header, ours);
      resolvedBlocks++;
    } else {
      // Vrai conflit → prefer theirs
      mergedBlocks.set(header, theirs);
      versionConflicts++;
      resolvedBlocks++;
    }
  }

  // Reconstruire le fichier : preamble + blocs triés
  const sortedHeaders = [...mergedBlocks.keys()].sort();
  let output = oursParsed.preamble;

  for (const header of sortedHeaders) {
    output += `${header}\n`;
    output += `${mergedBlocks.get(header)!}\n\n`;
  }

  const reason = versionConflicts > 0
    ? `Fusion sémantique yarn.lock : ${resolvedBlocks} bloc(s), ${versionConflicts} conflit(s) résolu(s) (prefer-theirs).`
    : `Fusion sémantique yarn.lock réussie : ${resolvedBlocks} bloc(s) fusionné(s) sans conflit.`;

  return {
    merged: output,
    reason,
    resolvedBlocks,
    versionConflicts,
  };
}
