@../../CLAUDE.md

## packages/core — Moteur de résolution de conflits Git

Ce package est le cœur du produit. Il implémente la logique de détection et résolution automatique de conflits Git. Il est consommé par `apps/desktop`, `packages/cli`, `packages/mcp` et `packages/vscode`.

### Commandes de développement

```bash
pnpm test           # Tests unitaires (Vitest)
pnpm bench          # Benchmarks de performance — lancer avant toute modification d'algo
pnpm build          # Compilation TypeScript
```

---

## Règle fondamentale — Compatibilité browser/Node/Tauri

**Ce package ne doit jamais importer statiquement de modules Node.js natifs.** Il doit rester compatible browser, Node.js ET Tauri (WebView).

```typescript
// ❌ INTERDIT — import statique, casse la compatibilité browser
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

// ✅ Autorisé
// Manipulation de strings, algorithmes purs, web-tree-sitter (WASM)
```

### Exception architecturale — adaptateurs d'environnement (`structural/parsers/adapters/`)

`structural/parsers/adapters/node.ts` contient des imports Node.js (`node:fs/promises`, `node:path`, etc.). Ce fichier **ne constitue pas une violation** car :

1. Il est chargé **uniquement via un import dynamique** gardé par `detectEnvironment()` dans `loader.ts` :
   ```typescript
   if (env === "node") {
     const { loadGrammarBytes } = await import(/* @vite-ignore */ "./adapters/node.js");
   }
   ```
2. Le commentaire `/* @vite-ignore */` empêche Vite de bundler ce fichier dans les builds browser/Tauri.
3. En environnement browser (`detectEnvironment()` retourne `"browser"`), cette branche n'est jamais exécutée.

**Règle :** tout nouvel import Node.js dans ce package doit suivre ce même pattern — import dynamique, guard `detectEnvironment()`, commentaire `@vite-ignore`. Ne jamais ajouter d'import statique Node.js.

Avant tout `npm install` ou ajout d'import, vérifier que la dépendance ne tire pas transitoirement un module Node natif.

---

## Types principaux (`types.ts`)

| Type | Description |
|---|---|
| `ClassifyInput` | Hunk d'entrée `{ baseLines, oursLines, theirsLines: string[] }` |
| `ClassifyResult` | Résultat de classification `{ type: ConflictType, confidence: ConfidenceScore, … }` |
| `ConflictType` | Union string des noms de patterns (`"same_change"` \| `"one_side_change"` \| … \| `"complex"`) |
| `PatternPlugin` | Interface que chaque pattern implémente (voir §Patterns) |
| `FormatResolveResult` | `{ lines: string[] \| null, reason: string, resolverUsed: string }` |

**Note :** `generated_file` est un type spécial absent du registre `PATTERNS` dans `classifier.ts`. Il est injecté directement par l'orchestrateur après détection via `structural/generated-detection.ts`. Ne pas créer de PatternPlugin pour ce type.

---

## Système de patterns (`patterns/`)

Chaque pattern est un objet `PatternPlugin` (default export) enregistré dans `src/classifier.ts`. Le classifier les trie par `priority` (entier — plus bas = plus prioritaire) et retourne le premier dont `detect()` renvoie `true`.

### Hiérarchie des patterns (priorité décroissante)

| Priorité | Pattern | Confiance | Condition |
|---|---|---|---|
| 1 | `same_change` | 1.0 | Les deux branches ont fait exactement la même modification |
| 2 | `one_side_change` | 1.0 | Un seul côté diffère de la base |
| 3 | `delete_no_change` | 1.0 | Un côté supprime, l'autre n'a pas changé |
| 4 | `non_overlapping` | 0.9 | Les changements touchent des zones différentes |
| 5 | `whitespace_only` | 0.85 | La seule différence est de l'espacement |
| 6 | `reorder_only` | 0.85 | Mêmes lignes, ordre différent |
| 7 | `insertion_at_boundary` | 0.85 | Insertions pures sans modifier les lignes existantes |
| 8 | `value_only_change` | 0.7 | Changement de valeur scalaire (ex: numéro de version) |
| 65 | `token_level_merge` | 0.5-0.6 (jamais auto-appliqué) | Décomposition ligne/token réussie — proposition soumise à confirmation utilisateur |
| 9 | `complex` | 0 | Chevauchement complexe — **jamais auto-résolu** |

Le pattern `complex` (priority 999) est le filet de sécurité : `detect()` retourne toujours `true`, `confidence` score 0 — force une revue manuelle.

**Exception à la règle confidence → auto-application** : `token_level_merge` (v2.7, priority 65)
est le seul pattern textuel dont la confiance ne pilote jamais l'auto-application, quel que soit
le score obtenu. Il décompose le hunk ligne par ligne, puis — pour les lignes où les deux côtés
diffèrent encore de la base — fusionne les tokens disjoints (`patterns/token-level-merge.ts`).
`resolver/assemble.ts` retourne systématiquement `lines: null` pour ce type ; la proposition
calculée (`hunk.trace.tokenMergeTrace`) est affichée à l'utilisateur via `TokenMergePanel.vue`
(apps/desktop) qui applique le résultat par `resolveHunkCustom` uniquement après confirmation
explicite. Ne pas copier ce comportement dans un futur pattern sans raison équivalente — c'est
une dérogation délibérée, pas un nouveau standard.

### Interface PatternPlugin

```typescript
interface PatternPlugin {
  type: ConflictType;       // identifiant string du pattern (snake_case)
  priority: number;         // entier — plus bas = évalué en premier
  requires: "diff3" | "diff2" | "both"; // diff3 = base requise, diff2 = sans base
  detect(h: ClassifyInput): boolean;     // retourne true si le pattern s'applique
  confidence(h: ClassifyInput): ConfidenceScore;
  explanation(h: ClassifyInput): string; // texte lisible pour l'UI
  passReason(h: ClassifyInput): string;  // trace debug — pourquoi ça a matché
  failReason(h: ClassifyInput): string;  // trace debug — pourquoi ça n'a pas matché
}
```

### Ajouter un nouveau pattern

1. Créer `patterns/mon-pattern.ts` avec un default export `PatternPlugin` :
   ```typescript
   import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
   import { makeScore, scopeImpact } from "./utils.js";

   const monPattern: PatternPlugin = {
     type: "mon_pattern",  // ajouter aussi à l'union ConflictType dans types.ts
     priority: 65,         // choisir un entier entre les voisins souhaités
     requires: "both",

     detect(h) {
       // retourner true si le pattern s'applique
       return false;
     },
     confidence(h): ConfidenceScore {
       return makeScore(/* score 0–100 */, 0, scopeImpact(h.oursLines.length), ["raison"], []);
     },
     explanation(_h) { return "Description lisible pour l'UI."; },
     passReason(_h) { return "Raison technique du match."; },
     failReason(_h) { return "Raison technique du non-match."; },
   };
   export default monPattern;
   ```
2. Ajouter `"mon_pattern"` à l'union `ConflictType` dans `src/types.ts`.
3. Importer et enregistrer dans `src/classifier.ts` dans le tableau `PATTERNS`
   (avec un commentaire `// priority XX`).
4. Ajouter les tests dans `__tests__/patterns/mon-pattern.test.ts`
   (minimum 10 cas : 5 "should detect" + 5 "should not detect").
5. Justifier la valeur de `priority` et le score de confiance dans un commentaire.

---

## Système de resolvers (`resolvers/`)

Les resolvers enrichissent ou remplacent la résolution générique par des transformations spécifiques à un format de fichier. `resolvers/dispatcher.ts` route vers le bon resolver par extension ou nom de fichier.

### Resolvers disponibles

`json`, `yaml`, `cargo`, `css`, `dockerfile`, `dotenv`, `markdown`, `imports`, `vue`, `lockfile-npm`, `lockfile-pnpm`, `lockfile-yarn`

Les lockfiles ont systématiquement `confidence: 0.95` — leurs conflits sont presque toujours triviaux (régénérables).

### Ajouter un nouveau resolver

1. Créer `resolvers/monformat.ts` :
   ```typescript
   export function resolve(conflict: ConflictFile): ResolverResult {
     // ...
   }
   ```
2. Enregistrer dans `resolvers/dispatcher.ts` (4 points : fonction de détection, import, route dans `tryFormatAwareResolve()`, extension de l'union `resolverUsed`).
3. Ajouter les tests dans `__tests__/resolvers/` (minimum 5 cas de test).

---

## Algorithmes diff (`diff/`)

| Fichier | Algorithme | Usage |
|---|---|---|
| `lcs.ts` | LCS classique O(mn) | Petits fichiers, précision maximale |
| `histogram.ts` | Histogram diff (identique à git interne) | **Algo principal** — plus rapide sur grands fichiers |
| `block-move.ts` | Détection de blocs déplacés | Distingue déplacement de suppression+ajout |
| `shared.ts` | Utilitaires communs | Normalisation, helpers |
| `index.ts` | Interface principale | Point d'entrée public |

**Règle :** utiliser `histogram` par défaut. N'utiliser `lcs` que si la précision est explicitement requise et que le fichier est de taille raisonnable. Lancer `pnpm bench` avant et après toute modification d'un algo diff.

---

## Gotcha CRITIQUE — Parsing diff (context lines)

Ce bug a déjà causé des régressions. Pour détecter une ligne de contexte dans un diff git :

```typescript
// ✅ Correct — une ligne de contexte commence par un espace
const isContextLine = (line: string) => line.startsWith(' ')

// ❌ Bug subtil — NE PAS UTILISER
const isContextLine = (line: string) => !line.startsWith('\\')
// Les strings vides ('') ne commencent pas par '\' → considérées comme
// contexte → génèrent des phantom context lines dans le diff.
```

Voir aussi la note globale dans `AGENTS.md` / mémoire projet sur ce sujet.

---

## Tests (`__tests__/`)

| Fichier / dossier | Rôle |
|---|---|
| `corpus.ts` | Conflits réels extraits de vrais repos (source de vérité) |
| `patterns/` | Tests unitaires par pattern |
| `resolver.test.ts` | Tests d'intégration de l'orchestrateur |
| `diff.test.ts` | Tests des algorithmes diff |
| `lockfile-resolvers.test.ts` | Tests des resolvers lockfiles |
| `bench.bench.ts` | Benchmarks Vitest |

### Règles de test

- **Nouveau pattern** : minimum 10 cas (5 "should resolve" + 5 "should not resolve").
- **Nouveau resolver** : minimum 5 cas.
- **Bug fixé** : test de régression obligatoire ajouté dans le même commit.
- Ne jamais mocker les algorithmes diff — tester avec de vrais inputs tirés du corpus ou construits manuellement.
- `pnpm bench` avant toute modification de code sur le chemin critique (`diff/`, `patterns/`, `classifier.ts`).

---

## Fichiers clés

| Fichier | Rôle |
|---|---|
| `src/classifier.ts` | Registre `PATTERNS` + boucle d'évaluation ordonnée par `priority` |
| `src/resolver.ts` | Orchestrateur principal (appelle classifier + dispatcher + diff) |
| `src/types.ts` | Tous les types TypeScript (`PatternPlugin`, `ClassifyInput`, `ConflictType`, …) |
| `src/parser.ts` | Intégration web-tree-sitter (WASM, zéro Node.js) |
| `resolvers/dispatcher.ts` | Routing format → resolver (`tryFormatAwareResolve`) |
| `patterns/utils.ts` | Helpers partagés (`makeScore`, `scopeImpact`, normalisation) |
