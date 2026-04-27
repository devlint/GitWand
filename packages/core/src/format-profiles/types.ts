/**
 * GitWand — Types du registre de profils par format
 *
 * Un FormatProfile annote des chemins JSON Pointer (RFC 6901) avec une
 * stratégie de merge. C'est l'analogue local des "commutative parents" de
 * Mergiraf, mais piloté par configuration plutôt que par grammaire.
 */

/**
 * Stratégie de merge appliquée à un chemin donné dans un document JSON/YAML.
 *
 * - "set" : merge par identité d'élément. La fonction identity extrait une
 *   clé stable depuis chaque item ; deux items avec la même clé sont
 *   considérés comme "le même", et les modifications se mergent par
 *   récursion. Sans identity, fallback JSON.stringify(item).
 * - "ordered-list" : RFC 6902 add/remove. On diffe base->ours et base->theirs,
 *   on les concatène si les paths sont disjoints, on rejette sinon.
 * - "merge-keys" : objets ; récursion clé-par-clé (comportement actuel de
 *   mergeObjects).
 * - "opaque" : aucune tentative de merge sémantique, retombée fallback textuel.
 */
export type PathStrategy =
  | { kind: "set"; identity?: (item: unknown) => string }
  | { kind: "ordered-list" }
  | { kind: "merge-keys" }
  | { kind: "opaque" };

/**
 * Profil de merge pour un type de fichier (ou pattern).
 *
 * Le registre essaie chaque profil dans l'ordre d'enregistrement ; le premier
 * dont matches(filePath) retourne true est utilisé. Les chemins sont des
 * JSON Pointers (par exemple /dependencies, ou des paths avec wildcard de
 * segment unique pour itérer sur une liste). Les wildcards "*" matchent un
 * segment unique (équivalent shallow-glob).
 */
export interface FormatProfile {
  /** Identifiant lisible (pour les traces) — ex: "package.json". */
  name: string;
  /** Match sur le filePath. Le registre s'arrête au premier profil matching. */
  matches: (filePath: string) => boolean;
  /** Stratégie par chemin JSON Pointer (RFC 6901). */
  paths: Record<string, PathStrategy>;
  /** Stratégie par défaut pour les chemins non listés. */
  default: PathStrategy;
}

/**
 * Une opération RFC 6902 minimale. On ne supporte que add, remove, replace.
 * move et copy peuvent toujours être exprimées par séquences add/remove, et
 * leur omission garde le code en dessous de 2KB ajoutés.
 */
export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown };
