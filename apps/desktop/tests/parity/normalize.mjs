/**
 * Normalisation des payloads Rust ↔ Node pour comparaison de parité.
 *
 * Deux sources de divergence acceptables à masquer avant diff :
 *
 * 1. **Case des clés**. Le dev-server émet directement du camelCase ; le
 *    backend Rust (`serde::Serialize` sans `rename_all`) émet du snake_case.
 *    Le code frontend absorbe la différence dans `backend.ts`. Ici on remet
 *    tout en camelCase avant comparaison.
 *
 * 2. **Champs volatiles**. Certains champs dépendent de l'environnement et
 *    ne peuvent pas être égaux entre deux exécutions indépendantes, même sur
 *    une fixture déterministe. Exemple : `last_commit_date` inclut le fuseau
 *    horaire local, or notre fixture force UTC mais git peut réécrire en
 *    local. On liste les champs à effacer par commande.
 */

/** Convertit `snake_case` → `camelCase`, récursivement sur les clés d'objets. */
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Remappe récursivement les clés d'un objet/array de snake_case vers
 * camelCase. Traverse les tableaux et les objets imbriqués. Les valeurs
 * primitives sont laissées telles quelles.
 */
export function camelizeKeys(value) {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[snakeToCamel(k)] = camelizeKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Efface (set à `""`) les champs volatils listés dans `paths`, en parcourant
 * récursivement tableaux et objets. Chaque path est une clé terminale
 * (`lastCommitDate`, `lastCommit`). On matche partout où la clé apparaît,
 * quel que soit le niveau d'imbrication — c'est suffisant pour nos schémas
 * actuels (git-status, git-log, git-branches) qui n'ont pas de collisions.
 */
export function blankVolatile(value, keys) {
  const keySet = new Set(keys);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, inner] of Object.entries(v)) {
        out[k] = keySet.has(k) ? "" : walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * Normalise la sortie brute d'un côté (Rust OU Node) pour la commande donnée.
 *
 * @param command — "git-status" | "git-log" | "git-branches"
 * @param value   — JSON décodé tel que retourné par le probe / dev-server
 * @returns       — valeur comparable, avec clés camelCase + volatils gommés
 */
export function normalize(command, value) {
  const camel = camelizeKeys(value);

  switch (command) {
    case "git-status":
      // git-status : tout est déjà déterministe dans une fixture ; pas de
      // champ volatile à gommer. `branch`, listes de fichiers, etc. sont
      // stables.
      return camel;

    case "git-log":
      // `hash`/`hashFull` sont déterministes avec GIT_AUTHOR_DATE fixé, mais
      // TZ locale peut dévier d'un système à l'autre. On garde les hashs (ils
      // valident la parité) mais on n'assume pas que les runs rust/node font
      // des appels à nano-secondes identiques si un jour on bouge les fixtures.
      // Rien de volatil à gommer pour l'instant.
      return camel;

    case "git-branches":
      // `lastCommit` est "<short-hash> <subject>" — déterministe si les hashs
      // le sont. `lastCommitDate` est "iso" côté Rust mais peut différer
      // subtilement (fuseau, padding) côté Node selon git(1). On gomme les
      // deux par prudence : la parité structurelle (name/isCurrent/upstream/
      // ahead/behind/isRemote) est le cœur de ce qu'on valide.
      return blankVolatile(camel, ["lastCommit", "lastCommitDate"]);

    case "git-stash-list":
      // `date` peut varier subtilement en format ISO selon les implémentations.
      return blankVolatile(camel, ["date"]);

    case "scan-secrets":
      // Les deux moteurs (Rust `regex` crate / TS `RegExp`) itèrent fichiers → lignes →
      // patterns dans le même ordre déclaré, donc l'ordre des findings devrait déjà
      // coïncider. On trie quand même explicitement par (file, line, patternId) — c'est le
      // *set* de findings qui fait foi, pas un ordre d'itération accidentel.
      return sortFindings(camel);

    default:
      return camel;
  }
}

/** Tri stable par (file, line, patternId) — voir le cas "scan-secrets" ci-dessus. */
function sortFindings(list) {
  if (!Array.isArray(list)) return list;
  return [...list].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.patternId !== b.patternId) return a.patternId < b.patternId ? -1 : 1;
    return 0;
  });
}
