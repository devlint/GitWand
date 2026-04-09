/**
 * GitWand — Résolveur sémantique pour package-lock.json (npm)
 *
 * Au lieu de traiter package-lock.json comme un fichier opaque (→ theirs),
 * ce résolveur comprend la structure : chaque entrée dans "packages" ou
 * "dependencies" est un nœud indépendant.
 *
 * Stratégie :
 *  1. Parser les trois versions (base, ours, theirs) en maps de dépendances
 *  2. Merge 3-way par clé (path de package) :
 *     - Ajouté d'un seul côté → prendre l'ajout
 *     - Supprimé d'un seul côté (pas modifié de l'autre) → supprimer
 *     - Modifié d'un seul côté → prendre la modification
 *     - Modifié des deux côtés avec même résultat → ok
 *     - Modifié des deux côtés avec résultat différent → conflit (prefer-theirs par défaut)
 *  3. Reconstruire le JSON avec l'indentation d'origine
 *
 * Limitations :
 *  - Ne valide pas la cohérence sémantique (ranges vs resolved)
 *  - Après merge, un `npm install` reste recommandé
 */

// ─── Types ───────────────────────────────────────────────

export interface LockfileMergeResult {
  /** Contenu JSON fusionné ou null si échec */
  merged: string | null;
  /** Raison de la résolution */
  reason: string;
  /** Nombre de paquets fusionnés */
  resolvedPackages: number;
  /** Nombre de conflits de versions */
  versionConflicts: number;
  /** Paquets en conflit (versions incompatibles) */
  conflictedPackages: string[];
}

// ─── Parser simplifié ────────────────────────────────────

/**
 * Extrait les entrées du lockfile v2/v3 (clé "packages") ou v1 ("dependencies").
 * Retourne une Map<path, jsonStr> pour chaque entrée.
 */
function parseLockfileEntries(json: string): {
  header: Record<string, unknown>;
  packages: Map<string, string>;
  format: "v2" | "v3" | "v1";
  indent: string;
} | null {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // Détecter l'indentation
  const indentMatch = json.match(/\n(\s+)"/);
  const indent = indentMatch ? indentMatch[1] : "  ";

  const packages = new Map<string, string>();
  let format: "v2" | "v3" | "v1" = "v1";

  if (parsed.packages && typeof parsed.packages === "object") {
    format = parsed.lockfileVersion === 3 ? "v3" : "v2";
    for (const [key, value] of Object.entries(parsed.packages)) {
      packages.set(key, JSON.stringify(value));
    }
  } else if (parsed.dependencies && typeof parsed.dependencies === "object") {
    for (const [key, value] of Object.entries(parsed.dependencies)) {
      packages.set(key, JSON.stringify(value));
    }
  }

  // Header = tout sauf packages/dependencies
  const header: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "packages" && key !== "dependencies") {
      header[key] = value;
    }
  }

  return { header, packages, format, indent };
}

// ─── 3-way merge ─────────────────────────────────────────

/**
 * Fusionne trois versions d'un package-lock.json par entrée de paquet.
 */
export function tryResolveLockfileNpmConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): LockfileMergeResult {
  const baseText = baseLines.join("\n");
  const oursText = oursLines.join("\n");
  const theirsText = theirsLines.join("\n");

  const baseParsed = parseLockfileEntries(baseText);
  const oursParsed = parseLockfileEntries(oursText);
  const theirsParsed = parseLockfileEntries(theirsText);

  if (!baseParsed || !oursParsed || !theirsParsed) {
    return {
      merged: null,
      reason: "Impossible de parser une des versions du package-lock.json.",
      resolvedPackages: 0,
      versionConflicts: 0,
      conflictedPackages: [],
    };
  }

  const basePkgs = baseParsed.packages;
  const oursPkgs = oursParsed.packages;
  const theirsPkgs = theirsParsed.packages;

  // Toutes les clés
  const allKeys = new Set([...basePkgs.keys(), ...oursPkgs.keys(), ...theirsPkgs.keys()]);

  const mergedPkgs = new Map<string, string>();
  let resolvedPackages = 0;
  let versionConflicts = 0;
  const conflictedPackages: string[] = [];

  for (const key of allKeys) {
    const base = basePkgs.get(key);
    const ours = oursPkgs.get(key);
    const theirs = theirsPkgs.get(key);

    // Pas dans base → ajout(s)
    if (base === undefined) {
      if (ours !== undefined && theirs !== undefined) {
        if (ours === theirs) {
          // Même ajout
          mergedPkgs.set(key, ours);
          resolvedPackages++;
        } else {
          // Ajout différent des deux côtés → merge de version (prefer theirs)
          mergedPkgs.set(key, theirs);
          resolvedPackages++;
        }
      } else if (ours !== undefined) {
        mergedPkgs.set(key, ours);
        resolvedPackages++;
      } else if (theirs !== undefined) {
        mergedPkgs.set(key, theirs);
        resolvedPackages++;
      }
      continue;
    }

    // Dans base mais supprimé d'un côté
    if (ours === undefined && theirs === undefined) {
      // Supprimé des deux côtés → supprimer
      resolvedPackages++;
      continue;
    }
    if (ours === undefined) {
      // Ours supprimé
      if (theirs === base) {
        // Theirs pas modifié → supprimer (ours gagne)
        resolvedPackages++;
      } else {
        // Theirs modifié, ours supprimé → garder theirs (il a été mis à jour)
        mergedPkgs.set(key, theirs!);
        resolvedPackages++;
      }
      continue;
    }
    if (theirs === undefined) {
      // Theirs supprimé
      if (ours === base) {
        // Ours pas modifié → supprimer (theirs gagne)
        resolvedPackages++;
      } else {
        // Ours modifié, theirs supprimé → garder ours
        mergedPkgs.set(key, ours);
        resolvedPackages++;
      }
      continue;
    }

    // Présent partout — comparer
    const oursChanged = ours !== base;
    const theirsChanged = theirs !== base;

    if (!oursChanged && !theirsChanged) {
      mergedPkgs.set(key, base);
      resolvedPackages++;
    } else if (!oursChanged) {
      mergedPkgs.set(key, theirs);
      resolvedPackages++;
    } else if (!theirsChanged) {
      mergedPkgs.set(key, ours);
      resolvedPackages++;
    } else if (ours === theirs) {
      mergedPkgs.set(key, ours);
      resolvedPackages++;
    } else {
      // Vrai conflit de version → merge au niveau des propriétés
      const merged = mergePackageEntry(base, ours, theirs);
      if (merged !== null) {
        mergedPkgs.set(key, merged);
        resolvedPackages++;
      } else {
        // Fallback : prefer theirs
        mergedPkgs.set(key, theirs);
        versionConflicts++;
        conflictedPackages.push(key);
      }
    }
  }

  // Reconstruire le JSON
  const indent = oursParsed.indent;
  const header = { ...oursParsed.header };
  const pkgKey = oursParsed.format === "v1" ? "dependencies" : "packages";

  // Trier les clés comme npm le fait (alphabétique)
  const sortedEntries: Record<string, unknown> = {};
  const sortedKeys = [...mergedPkgs.keys()].sort();
  for (const key of sortedKeys) {
    try {
      sortedEntries[key] = JSON.parse(mergedPkgs.get(key)!);
    } catch {
      sortedEntries[key] = mergedPkgs.get(key);
    }
  }

  const result = { ...header, [pkgKey]: sortedEntries };
  const merged = JSON.stringify(result, null, indent.length) + "\n";

  const reason = versionConflicts > 0
    ? `Fusion sémantique lockfile : ${resolvedPackages} paquet(s) fusionné(s), ${versionConflicts} conflit(s) de version résolu(s) (prefer-theirs).`
    : `Fusion sémantique lockfile réussie : ${resolvedPackages} paquet(s) fusionné(s) sans conflit.`;

  return {
    merged,
    reason,
    resolvedPackages,
    versionConflicts,
    conflictedPackages,
  };
}

// ─── Merge de propriétés d'un paquet ─────────────────────

/**
 * Fusionne deux versions différentes d'une entrée de paquet au niveau propriété.
 * Permet de résoudre les cas où ours met à jour `version` et theirs met à jour `integrity`.
 */
function mergePackageEntry(baseJson: string, oursJson: string, theirsJson: string): string | null {
  let base: Record<string, unknown>;
  let ours: Record<string, unknown>;
  let theirs: Record<string, unknown>;

  try {
    base = JSON.parse(baseJson);
    ours = JSON.parse(oursJson);
    theirs = JSON.parse(theirsJson);
  } catch {
    return null;
  }

  if (typeof base !== "object" || typeof ours !== "object" || typeof theirs !== "object") {
    return null;
  }

  const allProps = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  const merged: Record<string, unknown> = {};

  for (const prop of allProps) {
    const baseVal = JSON.stringify(base[prop]);
    const oursVal = JSON.stringify(ours[prop]);
    const theirsVal = JSON.stringify(theirs[prop]);

    const oursChanged = oursVal !== baseVal;
    const theirsChanged = theirsVal !== baseVal;

    if (!oursChanged && !theirsChanged) {
      if (base[prop] !== undefined) merged[prop] = base[prop];
    } else if (!oursChanged) {
      if (theirs[prop] !== undefined) merged[prop] = theirs[prop];
    } else if (!theirsChanged) {
      if (ours[prop] !== undefined) merged[prop] = ours[prop];
    } else if (oursVal === theirsVal) {
      if (ours[prop] !== undefined) merged[prop] = ours[prop];
    } else {
      // Vrai conflit sur cette propriété → prefer theirs
      if (theirs[prop] !== undefined) merged[prop] = theirs[prop];
    }
  }

  return JSON.stringify(merged);
}
