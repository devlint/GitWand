/**
 * GitWand — Résolveur Vue SFC (Single File Component)
 *
 * Résout les conflits dans les fichiers `.vue` en reconnaissant la structure
 * SFC et en traitant chaque bloc indépendamment.
 *
 * Structure d'un fichier Vue SFC :
 *   <template>     - HTML du composant
 *   <script>       - Logique (JS ou TS, avec possibles sous-blocs)
 *   <script setup> - Composition API
 *   <style>        - CSS/SCSS/Less
 *   <style scoped> - CSS scopé
 *   <custom-block> - Blocs personnalisés (i18n, docs, etc.)
 *
 * Stratégie :
 *  1. Découper chaque version en blocs SFC identifiés par leur balise ouvrante
 *  2. Pour chaque bloc : appliquer la logique 3-way standard
 *     - Bloc non modifié → garder base
 *     - Seul un côté a changé → accepter le changement
 *     - Same change → accepter
 *     - Conflit réel → fallback textuel (null)
 *  3. Reconstruire le fichier dans l'ordre des blocs de `ours`
 *     (en insérant les nouveaux blocs de `theirs` à la bonne position)
 */

// ─── Types internes ───────────────────────────────────────

/**
 * Un bloc SFC parsé.
 */
export interface SfcBlock {
  /** Tag d'ouverture complet (ex: `<template>`, `<script setup lang="ts">`) */
  openTag: string;
  /** Nom du bloc (ex: 'template', 'script', 'style') */
  name: string;
  /** Attributs bruts (ex: 'setup lang="ts"') */
  attrs: string;
  /** Lignes de contenu (sans le tag d'ouverture et de fermeture) */
  lines: string[];
  /** Tag de fermeture (ex: `</template>`) */
  closeTag: string;
}

// ─── Parser SFC ───────────────────────────────────────────

const RE_OPEN_TAG  = /^<([\w-]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>$/;
const RE_CLOSE_TAG = /^<\/([\w-]+)>$/;

/** Tags racines reconnus comme blocs SFC (les autres sont ignorés comme texte) */
const SFC_ROOT_TAGS = new Set(["template", "script", "style"]);

/**
 * Découpe un fichier Vue SFC en blocs.
 * Les lignes hors blocs reconnus (commentaires HTML, attributs en tête…)
 * sont regroupées dans un bloc virtuel "preamble".
 */
export function parseSfcBlocks(lines: string[]): SfcBlock[] {
  const blocks: SfcBlock[] = [];
  let i = 0;

  // Lignes de préambule avant le premier bloc racine
  const preamble: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const openMatch = line.trim().match(RE_OPEN_TAG);

    if (openMatch) {
      const name  = openMatch[1].toLowerCase();
      const attrs = openMatch[2].trim();

      // Reconnaître les blocs racines SFC et les custom blocks
      // On accepte tout tag au niveau racine (i18n, docs, etc.)
      if (preamble.length > 0 && blocks.length === 0) {
        // Sauvegarder le préambule comme bloc virtuel
        blocks.push({
          openTag: "",
          name: "__preamble__",
          attrs: "",
          lines: [...preamble],
          closeTag: "",
        });
        preamble.length = 0;
      }

      const closeTagStr = `</${name}>`;
      const contentLines: string[] = [];
      i++;

      while (i < lines.length) {
        const inner = lines[i];
        const closeMatch = inner.trim().match(RE_CLOSE_TAG);
        if (closeMatch && closeMatch[1].toLowerCase() === name) {
          break;
        }
        contentLines.push(inner);
        i++;
      }

      blocks.push({
        openTag: line.trim(),
        name,
        attrs,
        lines: contentLines,
        closeTag: closeTagStr,
      });
      i++; // passer le closeTag
      continue;
    }

    // Ligne hors bloc → préambule ou texte entre blocs
    preamble.push(line);
    i++;
  }

  // Préambule résiduel
  if (preamble.length > 0) {
    if (blocks.length === 0) {
      blocks.push({
        openTag: "",
        name: "__preamble__",
        attrs: "",
        lines: [...preamble],
        closeTag: "",
      });
    } else {
      // Ajouter au dernier bloc (espace avant EOF)
      blocks[blocks.length - 1].lines.push(...preamble);
    }
  }

  return blocks;
}

// ─── Merge engine ─────────────────────────────────────────

/** Résultat du merge Vue SFC */
export interface VueMergeResult {
  /** Lignes fusionnées (null = conflit non résolvable) */
  mergedLines: string[] | null;
  /** Description de la fusion */
  reason: string;
  /** Blocs résolus automatiquement */
  resolvedBlocks: number;
  /** Blocs en conflit */
  conflictedBlocks: string[];
}

/**
 * Clé d'identification d'un bloc : nom + attributs.
 * Deux blocs avec la même clé représentent le même bloc SFC.
 */
function blockKey(block: SfcBlock): string {
  return `${block.name}:${block.attrs}`;
}

/**
 * Compare le contenu de deux blocs pour égalité textuelle.
 */
function blocksContentEqual(a: SfcBlock, b: SfcBlock): boolean {
  return (
    a.openTag === b.openTag &&
    a.lines.length === b.lines.length &&
    a.lines.every((l, i) => l === b.lines[i])
  );
}

/**
 * Sérialise un bloc SFC en lignes.
 */
function blockToLines(block: SfcBlock): string[] {
  if (block.name === "__preamble__") return [...block.lines];
  return [block.openTag, ...block.lines, block.closeTag];
}

/**
 * Tente de résoudre un conflit Vue SFC en fusionnant bloc par bloc.
 *
 * @param baseLines   - Lignes de la version base
 * @param oursLines   - Lignes de la version ours
 * @param theirsLines - Lignes de la version theirs
 */
export function tryResolveVueConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): VueMergeResult {
  const baseBlocks   = parseSfcBlocks(baseLines);
  const oursBlocks   = parseSfcBlocks(oursLines);
  const theirsBlocks = parseSfcBlocks(theirsLines);

  // Indexer par clé
  const baseMap   = new Map(baseBlocks.map((b) => [blockKey(b), b]));
  const oursMap   = new Map(oursBlocks.map((b) => [blockKey(b), b]));
  const theirsMap = new Map(theirsBlocks.map((b) => [blockKey(b), b]));

  // Ordre : ours first, puis nouveaux blocs de theirs
  const oursOrder   = oursBlocks.map(blockKey);
  const theirsOrder = theirsBlocks.map(blockKey);
  const allKeys: string[] = [...oursOrder];
  for (const k of theirsOrder) {
    if (!allKeys.includes(k)) allKeys.push(k);
  }

  const resultLines: string[] = [];
  let resolvedBlocks = 0;
  const conflictedBlocks: string[] = [];

  for (const key of allKeys) {
    const base  = baseMap.get(key);
    const ours  = oursMap.get(key);
    const theirs = theirsMap.get(key);

    // Bloc absent de base → ajout d'un côté ou des deux
    if (!base) {
      if (ours && theirs) {
        if (blocksContentEqual(ours, theirs)) {
          resultLines.push(...blockToLines(ours));
          resolvedBlocks++;
        } else {
          // Deux versions différentes d'un nouveau bloc → conflit
          conflictedBlocks.push(key);
          return {
            mergedLines: null,
            conflictedBlocks,
            resolvedBlocks,
            reason: `Conflit sur le bloc <${ours.name}> — ajouté différemment des deux côtés.`,
          };
        }
      } else if (ours) {
        resultLines.push(...blockToLines(ours));
        resolvedBlocks++;
      } else if (theirs) {
        resultLines.push(...blockToLines(theirs));
        resolvedBlocks++;
      }
      continue;
    }

    const oursChanged   = ours   ? !blocksContentEqual(base, ours)   : true;
    const theirsChanged = theirs ? !blocksContentEqual(base, theirs) : true;

    // Suppression des deux côtés
    if (!ours && !theirs) {
      resolvedBlocks++;
      continue;
    }

    // Ours supprimé
    if (!ours) {
      if (!theirsChanged) {
        resolvedBlocks++; // theirs = base, ours supprimé → supprimer
      } else {
        conflictedBlocks.push(key);
        return {
          mergedLines: null,
          conflictedBlocks,
          resolvedBlocks,
          reason: `Conflit sur le bloc <${base.name}> — ours l'a supprimé, theirs l'a modifié.`,
        };
      }
      continue;
    }

    // Theirs supprimé
    if (!theirs) {
      if (!oursChanged) {
        resolvedBlocks++; // ours = base, theirs supprimé → supprimer
      } else {
        conflictedBlocks.push(key);
        return {
          mergedLines: null,
          conflictedBlocks,
          resolvedBlocks,
          reason: `Conflit sur le bloc <${base.name}> — theirs l'a supprimé, ours l'a modifié.`,
        };
      }
      continue;
    }

    // Les deux présents
    if (!oursChanged && !theirsChanged) {
      resultLines.push(...blockToLines(base));
      resolvedBlocks++;
    } else if (blocksContentEqual(ours, theirs)) {
      resultLines.push(...blockToLines(ours));
      resolvedBlocks++;
    } else if (!oursChanged) {
      resultLines.push(...blockToLines(theirs));
      resolvedBlocks++;
    } else if (!theirsChanged) {
      resultLines.push(...blockToLines(ours));
      resolvedBlocks++;
    } else {
      // Les deux ont modifié le même bloc différemment → conflit
      conflictedBlocks.push(key);
      return {
        mergedLines: null,
        conflictedBlocks,
        resolvedBlocks,
        reason: `Conflit sur le bloc <${ours.name}> — modifié des deux côtés de façon incompatible.`,
      };
    }
  }

  return {
    mergedLines: resultLines,
    conflictedBlocks: [],
    resolvedBlocks,
    reason: `Fusion Vue SFC réussie : ${resolvedBlocks} bloc(s) fusionné(s).`,
  };
}
