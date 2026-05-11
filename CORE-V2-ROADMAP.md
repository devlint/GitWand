# `@gitwand/core` — Roadmap v2 (séquence purement core)

> Plan détaillé de la séquence v2 du package `@gitwand/core`. Suit l'analyse comparative à l'état de l'art (avril 2026) et capitalise sur l'architecture en pattern registry + format dispatcher + score multidimensionnel déjà en place.
>
> **Périmètre** : strictement `packages/core/` (moteur de résolution). Les expositions desktop (UI, settings, modales) sont notées en encart « **Desktop tie-in** » mais ne font pas partie du périmètre des tickets core.

---

## Cadre

### Stratégie de versioning

`@gitwand/core` est actuellement à `2.0.0`. La séquence ci-dessous numérote les releases `2.1.0 → 2.6.0`, chacune un minor bump SemVer. Aucune ne casse l'API publique exportée par `src/index.ts` : tout est additif ou rétro-compatible (avec un mode legacy quand un défaut interne change).

Deux modes de publication possibles selon le contenu :

- **Patch core seul** : aucune feature desktop nouvelle ⇒ `workflow_dispatch` sur `publish.yml`, bump uniquement de `packages/core/package.json`. Permet d'expédier un minor core sans aligner `desktop`/`cli`/`mcp` ni produire un tag `v*.*.*`.
- **Release alignée** : quand une feature core déclenche aussi du travail dans `apps/desktop` ou `@gitwand/cli`/`@gitwand/mcp` (typiquement v2.5 LLM fallback exposé en UI). Tag `v*.*.*` classique, alignement de version strict sur les quatre packages.

### Principes communs aux 6 releases

1. **Le pattern registry est l'unique extension point**. Toute nouvelle classification = nouveau `PatternPlugin` dans `src/patterns/` + entrée dans `src/classifier.ts`. Toute nouvelle stratégie de résolution textuelle = nouveau `case` dans `src/resolver/assemble.ts`. Toute nouvelle stratégie format-aware = nouveau résolveur dans `src/resolvers/` + entrée dans `src/resolvers/dispatcher.ts`.
2. **Tout résolveur retourne `lines | null` + `reason`**. Le contrat est uniforme et la `DecisionTrace` capture le pourquoi en cas d'échec.
3. **`ConfidenceScore` est extensible par dimensions**. On ajoute des champs optionnels dans `dimensions`, on étend la formule dans `src/patterns/utils.ts:makeScore`, et on rétro-compatibilise via valeurs par défaut. Pas de nouveau type pour chaque release.
4. **Validation post-merge obligatoire** sur tout résolveur qui touche du code structuré. Étendre `src/resolver/validation.ts` — pas de nouveau pipeline en parallèle.
5. **Bench gate**. Chaque release doit faire tourner `pnpm --filter @gitwand/core test:bench` avant tag. Régression > 15 % sur le micro-bench `1 conflit` ⇒ bloque le ship.
6. **Corpus de fixtures** : étendre `src/__tests__/corpus.ts` (20 fixtures actuellement) avec les cas spécifiques à chaque release. Au moins 5 nouveaux cas par release.

### Pré-requis transverses (réalisés en 2.1.0 ou 2.2.0)

Avant d'attaquer le tree-sitter dispatcher en 2.3.0, deux dettes à éponger :

- **Couche d'abstraction de chargement WASM** (livré en v2.3, mais préparée en v2.1 par renommage de `src/diff.ts → src/diff/lcs.ts` pour conventionner la sous-arborescence par capacité). On veut que `@gitwand/core` reste utilisable depuis Node 20+, depuis le bundle Tauri webview, depuis VS Code extension et depuis `web-tree-sitter` côté navigateur sans logique de chargement spécifique répliquée.
- **Tableau de bord interne ConGra-like**. Construire un harnais qui compare les performances de `@gitwand/core` sur un échantillon contrôlé (50 conflits gradués A→F par complexité). Sert de garde-fou de régression et de sales pitch (« sur ConGra-mini, GitWand passe de X % à Y % »).

---

## v2.1.0 — Histogram diff & block-move detection ✅

> **Refondation algorithmique du moteur diff. Aucun nouveau pattern, mais qualité de fusion en hausse sur tous les cas non-overlapping et insertion-at-boundary.**

### But

Remplacer l'algorithme LCS pur (DP plein + Hirschberg) par **Histogram diff** comme moteur par défaut. Ajouter une primitive `detectBlockMove()` qui repère les blocs de lignes déplacés entre `ours` et `theirs` via rolling hash. Améliorer `non_overlapping` et `insertion_at_boundary` qui s'appuient tous deux sur le diff structurel.

### Apport vs état actuel

L'étude empirique de Nugroho et al. (Springer EMSE 2019) chiffre 1,7 % à 8,2 % de commits avec un churn différent selon l'algo, et établit la supériorité d'Histogram sur Myers/LCS pour le code source. Concrètement, sur les conflits où ours et theirs ré-ordonnent un bloc avant et après leur zone d'édition, LCS aligne sur les ancres faibles et produit des `non_overlapping` qui retombent en `complex`. Histogram s'ancre sur les lignes uniques d'abord et fournit des splits plus stables.

`detectBlockMove()` ouvre la porte à une nouvelle classification (en v2.6, refactoring-aware) sans la livrer immédiatement — il sert dès cette release à pénaliser le score de confiance de `complex` quand les deux côtés ont massivement déplacé du code (signal « refactor en cours, ne pas auto-résoudre »).

### Spécification

**Algorithme Histogram** : implémenter récursivement.

1. Trouver les lignes communes à `a` et `b` qui ont une fréquence faible des deux côtés (rares anchors). Préférer les uniques (1 occurrence chacun).
2. Si pas d'ancre : retomber sur Myers (linéaire, pas LCS DP).
3. Sinon, splitter récursivement autour de la première ancre.

**Contrats préservés** :

- `lcs(a, b): Array<[number, number]>` → garde sa signature, devient un wrapper qui appelle `histogramDiff()` par défaut. Variable d'environnement `GITWAND_DIFF=lcs` pour forcer le legacy.
- `computeDiff(base, branch)` et `mergeNonOverlapping()` profitent transparently du nouveau backend.

**Block-move detection** :

- Rolling hash (Rabin-Karp) sur des fenêtres de 5 lignes normalisées (whitespace-trimmed).
- Pour chaque hash de fenêtre, indexer les positions dans `ours` et `theirs`.
- Match si la fenêtre apparaît à des positions différentes dans les deux côtés ET que la fenêtre n'est pas dans `base`.
- Output : `Array<{ block: string[]; oursPos: number; theirsPos: number; basePos: number | null }>`.

### API publique exposée

```ts
// Nouvelles exports depuis src/index.ts
export { histogramDiff, type HistogramOptions } from "./diff/histogram.js";
export { detectBlockMove, type MovedBlock } from "./diff/block-move.js";

// Existants — comportement par défaut change, signature stable
export { lcs, computeDiff, mergeNonOverlapping } from "./diff/index.js";
```

### Fichiers touchés

- **Nouveau** : `src/diff/histogram.ts` (~250 lignes attendues)
- **Nouveau** : `src/diff/block-move.ts` (~150 lignes)
- **Nouveau** : `src/diff/index.ts` (re-exports + dispatcher legacy/new)
- **Renommé** : `src/diff.ts → src/diff/lcs.ts` (préserver l'historique git via `git mv`)
- **Modifié** : `src/index.ts` (nouveaux exports), `src/patterns/non-overlapping.ts` (peut adopter histogramDiff direct), `src/patterns/insertion-at-boundary.ts` (idem, remplace son LCS local), `src/patterns/utils.ts:makeScore` (nouvelle dimension optionnelle `algorithmStability`)
- **Tests** : `src/__tests__/diff.test.ts` (étendu), `src/__tests__/diff/histogram.test.ts` (nouveau), `src/__tests__/diff/block-move.test.ts` (nouveau), `src/__tests__/corpus.ts` (+5 fixtures de refactor-and-edit)

### Tests + corpus

- **Test de parité** : sur 200 paires aléatoires (a, b) générées, vérifier que `lcs()` legacy et `histogramDiff()` produisent des LCS *de même longueur* (pas forcément identiques, le tie-break diffère par construction).
- **Test de régression** : tous les tests existants doivent passer sans modification (sauf ceux qui asserts sur les paires LCS exactes — à recalibrer).
- **Bench** : ajouter un cas `histogramDiff vs lcsDenseDP` dans `bench.bench.ts`.
- **Corpus ajouté** :
  - `refactor-then-edit-ts.fixture` (refactor d'imports + ajout d'une fonction)
  - `move-block-and-modify-css.fixture` (déplacement d'un sélecteur + modif)
  - `reorder-deps-then-add-package-json.fixture`
  - `kubernetes-yaml-block-shuffle.fixture`
  - `markdown-section-swap-and-edit.fixture`

### Risques + atténuation

- **Risque** : tie-break Histogram vs LCS produit des LCS différentes ⇒ certains snapshots de tests cassent. **Atténuation** : audit ligne-à-ligne des tests qui asserts sur les paires retournées par `lcs()`. Si nécessaire, basculer ces tests en assert sur la *longueur*, pas les indices.
- **Risque** : le block-move detection produit des faux positifs sur du code répétitif (boucles `for (let i = 0; ...)` à plusieurs endroits). **Atténuation** : exiger une fenêtre minimale de 5 lignes, normaliser le whitespace mais pas le code, limiter le rolling hash aux fenêtres dont la diversité de tokens dépasse un seuil.
- **Risque** : régression de perf. **Atténuation** : Histogram est généralement plus rapide que LCS DP sur les inputs réels, mais on garde le bench gate.

### Estimation effort

- 4-5 jours de dev incluant le portage des fixtures.
- 1 jour de revue / bench / publication.

### Critère de "done"

- `pnpm --filter @gitwand/core test` vert (332 tests + nouveaux).
- Sur le ConGra-mini interne (à construire en pré-requis), pas de régression et idéalement +5 % d'auto-résolution sur les cases B-D.
- README de `@gitwand/core` mentionne le changement de défaut + flag `GITWAND_DIFF=lcs` pour rollback.

---

## v2.2.0 — Format profile registry + JSON Patch arrays ✅

> **Élimine deux trous fonctionnels documentés du résolveur JSON et étend le YAML resolver. Pose les fondations d'une bibliothèque de profils par chemin.**

### But

(1) Faire passer les **tableaux JSON** de `null → fallback textuel` à un merge sémantique par identité d'élément ou par RFC 6902. (2) Introduire un **registre de profils par fichier/chemin** qui annote les chemins JSON/YAML connus comme *set-like* (mergeable comme un set), *ordered-list* (mergeable par RFC 6902 add/remove), ou *opaque* (fallback). C'est l'analogue local du concept de *commutative parents* de Mergiraf, mais piloté par configuration, pas par grammaire.

### Apport vs état actuel

Le résolveur JSON actuel (`src/resolvers/json.ts`) renvoie `null` dès que `Array.isArray(oursJson) && Array.isArray(theirsJson)` — ce qui couvre `dependencies` ordonnées alphabétiquement, `scripts`, `extends`, `include` côté tsconfig, `compilerOptions.lib`, etc. Or ces paths représentent une fraction substantielle des conflits réels sur les configs JS/TS.

Le résolveur YAML (`src/resolvers/yaml.ts`) a la même limitation sur les séquences. Avec un profil documenté pour `helm/values.yaml` ou `kubernetes Deployment`, on peut résoudre proprement les listes de containers/env vars/volumes.

### Spécification

**Profil de format** :

```ts
// src/format-profiles/types.ts
export type PathStrategy =
  | { kind: "set"; identity?: (item: unknown) => string }   // merge par identité
  | { kind: "ordered-list" }                                 // RFC 6902
  | { kind: "merge-keys" }                                   // objets : récursion clé-par-clé
  | { kind: "opaque" };                                      // pas de merge, fallback

export interface FormatProfile {
  /** Identifiant lisible (pour les traces) */
  name: string;
  /** Match sur le filePath */
  matches: (filePath: string) => boolean;
  /** Stratégie par chemin JSON Pointer (RFC 6901) */
  paths: Record<string, PathStrategy>;
  /** Stratégie par défaut pour les chemins non listés */
  default: PathStrategy;
}
```

**Profils built-in fournis** :

- `package.json` : `/dependencies`, `/devDependencies`, `/peerDependencies` → `set` par nom de dépendance ; `/scripts` → `merge-keys` ; `/keywords` → `set`.
- `tsconfig.json` : `/compilerOptions/lib` → `set` ; `/include` et `/exclude` → `set` ; `/references` → `set` par `path`.
- `composer.json` : analogues à package.json.
- `helm/values.yaml` : `/spec/template/spec/containers/*/env` → `set` par `name` ; `/spec/template/spec/volumes` → `set` par `name`.
- Kubernetes `Deployment` : conventions standard de `name`-keyed lists.

**JSON Patch (RFC 6902)** : implémentation maison minimale (pas de dep externe pour rester < 2KB ajoutés).

- Opérations supportées : `add`, `remove`, `replace`. `move` et `copy` non implémentées (gérées par séquences add/remove).
- Diff par chemin : `oursPatch = diffJson(base, ours)`, `theirsPatch = diffJson(base, theirs)`.
- Si les deux patches n'ont aucune opération en conflit (paths disjoints) → applique séquentiellement les deux. Si conflit → null + reason.

**Registre** :

```ts
// src/format-profiles/index.ts
const PROFILES: FormatProfile[] = [
  packageJsonProfile,
  tsconfigProfile,
  composerJsonProfile,
  helmValuesProfile,
  kubernetesProfile,
  cargoTomlProfile,  // étendu depuis cargo.ts
];

export function profileForFile(filePath: string): FormatProfile | null {
  return PROFILES.find((p) => p.matches(filePath)) ?? null;
}
```

**Hook dans `tryResolveJsonConflict`** :

Avant l'actuel `mergeObjects`, lookup le profil. Si trouvé, appliquer la stratégie par path. La stratégie `set` sur `/dependencies` se traduit par : merger les deux objets clé-par-clé (déjà fait) ; pour les vrais arrays, le profil annote `{ kind: "set", identity: (x) => x.name }` et `mergeObjects` route vers un `mergeArrayAsSet()`.

**Hook dans `tryResolveYamlConflict`** : symétrique. Le profil opère sur la représentation parsée par `yaml`.

### API publique exposée

```ts
export {
  registerFormatProfile,
  profileForFile,
  type FormatProfile,
  type PathStrategy,
} from "./format-profiles/index.js";

export {
  diffJson,
  applyJsonPatch,
  mergeJsonPatches,
  type JsonPatchOp,
} from "./format-profiles/json-patch.js";
```

`registerFormatProfile()` permet aux consommateurs (ex: extension VS Code spécifique à un monorepo) de pousser leurs propres profils dans le registre runtime.

### Fichiers touchés

- **Nouveau** : `src/format-profiles/index.ts`, `src/format-profiles/types.ts`, `src/format-profiles/json-patch.ts`, `src/format-profiles/profiles/package-json.ts`, `src/format-profiles/profiles/tsconfig.ts`, `src/format-profiles/profiles/composer.ts`, `src/format-profiles/profiles/helm-values.ts`, `src/format-profiles/profiles/kubernetes.ts`
- **Modifié** : `src/resolvers/json.ts` (lookup profil avant merge), `src/resolvers/yaml.ts` (idem), `src/resolvers/cargo.ts` (refactor pour utiliser un profil), `src/index.ts` (nouveaux exports)
- **Tests** : `src/__tests__/format-profiles/*.test.ts` (un par profil), `src/__tests__/format-profiles/json-patch.test.ts`, `src/__tests__/resolvers/json.test.ts` (étendu pour les arrays), corpus +5 fixtures

### Tests + corpus

- **Fixtures** : ajout de 8-10 fixtures réelles tirées de PRs publiques (`package.json` avec deps en conflit dans `/dependencies` et `/devDependencies`, `tsconfig.json` avec `include` divergent, `helm-chart/values.yaml` avec listes de containers).
- **Test de propriété** : `applyJsonPatch(base, diffJson(base, x))` ≡ `x` sur 100 entrées générées.

### Risques + atténuation

- **Risque** : un profil mal calibré supprime silencieusement une dépendance. **Atténuation** : pour les `set` sur `dependencies`, exiger une identité stricte (clé d'objet exact match). Tracer dans `DecisionTrace` le profil utilisé et les paths matchés.
- **Risque** : RFC 6902 fait main introduit des bugs sur les escapes JSON Pointer (`~0`, `~1`). **Atténuation** : suite de tests dédiée ; envisager de pull `rfc6902` (~3KB minified) en dependency si l'effort dépasse.
- **Risque** : les profils sont opinionated et peuvent surprendre. **Atténuation** : option `disableFormatProfiles` dans `GitWandOptions` pour rollback global.

### Estimation effort

- 5-6 jours dev, dont 2-3 jours pour les profils built-in.

### Critère de "done"

- Un benchmark interne montre le passage des tableaux JSON de 0 % auto-résolu à >50 % sur les fixtures monorepo collectées.
- `applyJsonPatch` testé contre la suite de référence RFC 6902 (sur GitHub, des suites en JSON existent : on en pull une comme dev fixture).

---

## v2.3.0 — Tree-sitter structural dispatcher (TS/JS/Python/Go/Rust) ✅

> **Le saut qualitatif. Bascule de "moteur textuel + résolveurs format-aware" à "moteur structurel par défaut sur 5 langages, fallback textuel". Aligné Mergiraf/Weave sur le périmètre.**

### But

Introduire un nouveau résolveur générique « tree-sitter structural merge » qui parse `base/ours/theirs` avec **web-tree-sitter** (WASM), apparie les **entités top-level** (fonctions, classes, méthodes, top-level statements) par signature canonique, et fusionne **entité-par-entité** avec la logique 3-way standard. Gère 5 langages dès le premier ship : TypeScript, TSX, JavaScript, JSX, Python, Go, Rust.

### Apport vs état actuel

Aujourd'hui les conflits TS/JS sont traités via :
- Résolveur d'imports si le bloc est purement des imports.
- Sinon, fallback textuel et patterns ligne-à-ligne (`reorder_only`, `insertion_at_boundary`, `complex`).

Ce qui retombe en `complex` : fonctions ré-ordonnées, méthode ajoutée dans une classe par chaque branche, signature modifiée d'un côté et corps modifié de l'autre — exactement les cas que Weave annonce résoudre 31/31 vs 15/31 pour Git. C'est numériquement la principale source de conflits non-résolus dans les repos TS/JS de taille moyenne.

### Spécification

**Architecture** :

```
src/structural/
├── index.ts              # public entry: tryStructuralMergeResolve()
├── parsers/
│   ├── loader.ts         # WASM grammar loader (lazy, cached)
│   ├── adapters/         # runtime-specific WASM loading
│   │   ├── node.ts       # via fs.readFile / require.resolve
│   │   ├── browser.ts    # via fetch from public path
│   │   └── tauri.ts      # via tauri::asset::resolveResource
│   └── grammars/         # grammar metadata (file → wasm path)
│       ├── ts.ts
│       ├── tsx.ts
│       ├── js.ts
│       ├── jsx.ts
│       ├── python.ts
│       ├── go.ts
│       └── rust.ts
├── entities.ts           # extraction entités top-level
├── matching.ts           # GumTree-classic 3-way matching
├── merge.ts              # fusion entité-par-entité
└── reconstruct.ts        # sérialisation finale
```

**Entité top-level** (par langage) : noeud AST dont la signature canonique est calculable et stable.

- **TS/JS** : `function_declaration`, `class_declaration`, `method_definition`, `interface_declaration`, `type_alias_declaration`, `variable_statement` top-level, `export_statement`. Signature = `{ kind, name, parent }` (parent = path scope).
- **Python** : `function_definition`, `class_definition`, top-level `assignment`. Signature = `{ kind, name, parent }`.
- **Go** : `function_declaration`, `method_declaration`, `type_declaration`, `var_declaration`. Signature = `{ kind, name, receiver?, parent }`.
- **Rust** : `function_item`, `struct_item`, `enum_item`, `impl_item`, `trait_item`. Signature = `{ kind, name, parent }`.

**Algorithme de merge** (inspiré Mergiraf + Weave) :

1. Parse `base/ours/theirs` avec la grammaire détectée par extension.
2. Si une parse erreur côté `ours` ou `theirs` : abort, `null + reason: "parse error"`.
3. Extraire les entités top-level + leur range source.
4. Matching 3-way par signature (extension : tolérance au rename via similarité de corps si la signature ne match pas mais le hash du body est proche).
5. Pour chaque entité matchée dans les 3 versions : appliquer la classification ligne-à-ligne classique sur son range source, via le pipeline existant. Une entité = un mini-conflit.
6. Pour chaque entité ajoutée d'un seul côté : insérer.
7. Pour chaque entité supprimée d'un seul côté + non modifiée par l'autre : supprimer.
8. Pour chaque entité supprimée d'un côté + modifiée par l'autre : conflit, fallback.
9. Reconstruire le fichier en respectant l'ordre de `theirs` (héritage Weave) avec insertion des entités nouvelles d'`ours`.

**Pattern registry** :

Nouveau pattern `structural_merge` priorité 35 (entre `oneSideChange` priorité 30 et `nonOverlapping` priorité 40). Mais il a une particularité : il n'opère pas au niveau d'un hunk de marqueur de conflit Git, il opère au niveau du **fichier entier**. Ça implique un changement architectural : on doit autoriser le résolveur à *ré-écrire le fichier* plutôt que de remplacer un hunk.

**Solution** : nouveau type de retour pour le format dispatcher.

```ts
// src/resolvers/dispatcher.ts (étendu)
export interface FormatResolveResult {
  // Existant
  lines: string[] | null;
  reason: string;
  resolverUsed: ...;
  // Nouveau
  scope?: "hunk" | "file";  // file = remplace tout le contenu, pas juste le hunk
  fileContent?: string;     // si scope === "file"
}
```

Dans `src/resolver/index.ts:resolve()`, le pipeline change : si un résolveur retourne `scope: "file"`, on **bypass le découpage hunk** et on retourne le contenu fusionné directement. Le résolveur structural est la première (et seule à ce stade) instance de ce mode.

**Bundle strategy** :

- `web-tree-sitter` (~150KB minified gzipped) : `peerDependency` recommandée. Documentée comme requise pour activer le résolveur.
- Grammars `.wasm` (~400-1200KB chacune) : `optionalDependencies` ou packages séparés `@gitwand/grammar-typescript`, etc. Si absent au runtime, le résolveur structural skip ce langage avec un warning explicite (pas une erreur).
- Les consommateurs Node (CLI, MCP) bundlent via `require.resolve`. Le desktop Tauri embed les WASM dans `src-tauri/resources/`.

### API publique exposée

```ts
export {
  tryStructuralMergeResolve,
  type StructuralMergeResult,
  type SupportedLanguage,
  isStructuralLanguage,
} from "./structural/index.js";

export {
  registerGrammarLoader,
  type GrammarLoader,
} from "./structural/parsers/loader.js";
```

### Fichiers touchés

- **Nouveaux (~25 fichiers)** : tout `src/structural/` ci-dessus
- **Nouveau pattern** : `src/patterns/structural-merge.ts`
- **Modifié** : `src/classifier.ts` (ajout dans `PATTERNS`), `src/resolver/index.ts` (gérer `scope: "file"`), `src/resolvers/dispatcher.ts` (router en amont des autres resolveurs JS/TS), `src/resolvers/imports.ts` (devient un fallback du structural pour les blocs purs imports), `src/types.ts` (nouveaux types)
- **Tests** : `src/__tests__/structural/` (un test par langage, +30 fixtures de cas réels), `src/__tests__/structural/loader.test.ts` (mocks pour les 3 adapters)

### Tests + corpus

- **Corpus minimal par langage** : 5 fixtures par langage couvrant function-add-both-sides, method-reorder, class-method-modify-vs-add, signature-change-and-body-change, import-pure-block.
- **Test cross-runtime** : harnais qui exécute `tryStructuralMergeResolve` une fois en mode Node (vraie WASM via fs), une fois avec un mock browser adapter, une fois avec un mock Tauri adapter — vérifie que les trois produisent le même résultat.

### Risques + atténuation

- **Risque majeur** : explosion de la taille du package npm. **Atténuation** : grammars en `optionalDependencies`. Le package `@gitwand/core` reste léger ; les grammars sont pulled à la demande. Documenter que les consommateurs doivent installer les grammars dont ils ont besoin.
- **Risque** : différences de comportement WASM entre runtimes. **Atténuation** : adapter pattern, suite de tests cross-runtime.
- **Risque** : régression sur les fichiers TS où `imports.ts` faisait déjà le boulot. **Atténuation** : `imports.ts` reste actif comme spécialiste, le structural ne déclenche que si le bloc dépasse les imports.
- **Risque** : entity matching fragile sur les arrow functions assignées (`const foo = () => ...`). **Atténuation** : signature étendue avec le LHS du `variable_statement`.
- **Risque** : performance sur gros fichiers (+1MB). **Atténuation** : tree-sitter est incrémental et rapide ; bench dédié sur des fichiers de 5000-10000 lignes.

### Desktop tie-in

- Settings → AI/Engine → toggle « Structural merge engine » (default ON pour TS/JS/Python/Go/Rust, OFF pour les autres).
- Decision trace UI : afficher « Structural merge applied » avec le détail des entités matchées/ajoutées/supprimées.
- Pas d'urgence : le résolveur fonctionne sans UI dédiée, les gains sont visibles dans les stats.

### Estimation effort

- 3-4 semaines (gros chantier). Découpage interne possible :
  - Semaine 1 : architecture + adapter WASM + grammar loader + premier langage (TS).
  - Semaine 2 : extension JS/TSX/JSX, robustesse parser.
  - Semaine 3 : ajout Python/Go/Rust, optimisations matching.
  - Semaine 4 : tests cross-runtime, bench, doc, packaging optionalDeps.

### Critère de "done"

- Sur le ConGra-mini interne : +20-30 % d'auto-résolution sur les cases C/D pour les langages couverts.
- Pas de régression sur les fixtures existantes.
- Bundle `@gitwand/core` < 200KB minified gzipped (le poids majeur reste hors-package).
- Doc : `docs/structural-merge.md` explique le concept, les langages couverts, comment ajouter une grammaire.

---

## v2.4.0 — Validation sémantique post-merge

> **Ferme la boucle qualité : aucun merge auto ne quitte le moteur sans avoir été validé contre le parser réel du langage. Nouveau garde-fou dimensionnel `postMergeRisk`.**

### But

Étendre `src/resolver/validation.ts` (aujourd'hui : marqueurs résiduels + `JSON.parse`/`yaml.parse`/`smol-toml`) à une validation par parser tree-sitter pour tous les fichiers de code dont la grammaire est disponible. Optionnellement (config), invoquer `tsc --noEmit` ou ESLint sur les fichiers TS modifiés. Introduire une nouvelle dimension `postMergeRisk` dans `ConfidenceScore`, qui pénalise rétroactivement les hunks dont la résolution a généré un fichier non-parseable.

### Apport vs état actuel

Da Silva et al. (ScienceDirect 2024) chiffrent à **60 %** la part des conflits réels en Java qui sont des conflits sémantiques d'interaction, et **26×** plus susceptibles d'introduire un bug. Aujourd'hui, GitWand peut résoudre `same_change`/`one_side_change`/`non_overlapping` sans regarder si le résultat compile. Sur du structural merge, un mauvais matching d'entités peut produire un fichier dont les imports ne référencent plus rien.

### Spécification

**Étape 1 — parse-tree validity (toujours actif)** :

Si le fichier a une grammaire tree-sitter chargée (TS/JS/Python/Go/Rust depuis v2.3), parser le contenu fusionné. Si le parser produit des nœuds `ERROR` ou `MISSING`, la validation échoue : retourner le hunk en `complex` au lieu d'écrire le merge.

```ts
// src/resolver/validation.ts (étendu)
export interface ValidationResult {
  hasResidualMarkers: boolean;
  residualMarkerLines: number[];
  syntaxError: string | null;
  /** Nouveau : nombre de nœuds ERROR/MISSING dans le parse tree-sitter */
  parseTreeErrors: number;
  /** Nouveau : ranges des erreurs (pour reporting) */
  parseTreeErrorRanges: Array<{ start: number; end: number }>;
  /** Nouveau : résultat de la validation externe optionnelle (tsc, eslint) */
  externalValidation: ExternalValidationResult | null;
  isValid: boolean;
}
```

**Étape 2 — external validation (opt-in via config)** :

Nouvelle option `validation` dans `GitWandrcConfig` :

```jsonc
{
  "validation": {
    "level": "strict" | "balanced" | "off",  // défaut: balanced
    "external": {
      "tsc": true,        // exécute `tsc --noEmit` sur les .ts modifiés
      "eslint": false,    // exécute eslint --no-eslintrc sur les modifiés
      "timeout": 30000    // ms
    }
  }
}
```

- `level: "off"` : conserve l'existant (marqueurs + JSON/YAML/TOML).
- `level: "balanced"` (défaut) : ajoute parse-tree validity, garde external désactivé.
- `level: "strict"` : active aussi external, fait échouer le merge si l'un des outils externes signale une erreur nouvelle (delta vs avant le merge).

**Étape 3 — feedback dans `ConfidenceScore`** :

Nouvelle dimension :

```ts
dimensions: {
  ...existant,
  /** v2.4 — Pénalité si la validation post-merge échoue (0 = OK, 100 = parse cassé) */
  postMergeRisk: number;
}
```

Formule étendue :

```
score = typeClassification
      − dataRisk × 0.40
      − scopeImpact × 0.15
      − fileFrequency × 0.10
      + baseAvailability × 0.05
      − postMergeRisk × 0.20    // nouvelle pénalité, poids substantiel
```

Workflow : la résolution est tentée optimistically, le score initial calculé. Le validateur tourne. Si erreur → `postMergeRisk = 100`, score recalculé, label dérivé. Si le label retombe sous le seuil minimum → la résolution est *retirée* et le hunk repasse en non-résolu.

### API publique exposée

```ts
export {
  validateMergedContent,
  type ValidationResult,
  type ExternalValidationResult,
  type ValidationLevel,
} from "./resolver/validation.js";

export type { ValidationConfig } from "./config.js";  // étendu
```

### Fichiers touchés

- **Modifié** : `src/resolver/validation.ts` (étendu massivement), `src/types.ts` (nouvelle dimension `postMergeRisk`, nouveaux types validation), `src/config.ts` (parsing du champ `validation` dans .gitwandrc), `src/resolver/index.ts` (boucle de re-évaluation post-validation), `src/patterns/utils.ts:makeScore` (intègre `postMergeRisk`)
- **Nouveau** : `src/resolver/external-validators/tsc.ts`, `src/resolver/external-validators/eslint.ts`, `src/resolver/external-validators/types.ts`
- **Tests** : `src/__tests__/validation.test.ts` (étendu), `src/__tests__/resolver/external-validators.test.ts`, corpus +5 fixtures (merges qui parse mais ne compile pas)

### Risques + atténuation

- **Risque** : `tsc --noEmit` est lent (10-30s sur un projet moyen). **Atténuation** : timeout 30s par défaut, scope au fichier modifié uniquement (`tsc --noEmit src/foo.ts`). Sur monorepo, encourager l'utilisateur à le désactiver et compter sur parse-tree validity.
- **Risque** : eslint config dépend du projet. **Atténuation** : `--no-eslintrc` pour ne pas hériter de configs hostiles, fallback à un config minimum si rien trouvé.
- **Risque** : la dimension `postMergeRisk` change la formule de score → re-calibrage des seuils. **Atténuation** : test de non-régression sur le corpus existant ; si une fixture qui passait passe en non-résolu uniquement à cause de cette dimension, c'est qu'on a trouvé un bug latent.

### Estimation effort

- 1 semaine pour parse-tree validity + intégration dans la formule de score.
- 1 semaine pour external validators (tsc, eslint).

### Critère de "done"

- 0 résolution auto-validée qui produit un fichier non-parseable sur le corpus interne.
- Configuration `level: "strict"` documentée avec un exemple.

---

## v2.5.0 — LLM fallback opt-in via MCP ✅

> **Pattern de dernier recours, désactivé par défaut. Sérialise le hunk + la `DecisionTrace` + le contexte, appelle un agent LLM via MCP, valide agressivement le résultat avant acceptation.**
>
> **Livré le 2026-05-12** — core + tie-ins desktop, CLI, MCP, docs, bench. Critère « done » atteint : bench ConGra-mini interne (15 fixtures TS/Python/Go/Rust/JSON/Markdown) → **15/15 = 100 % résolus** avec mock endpoint déterministe, validation score 100 partout. 901/901 tests core + 76/76 tests desktop verts. Détail tie-in : [PLAN-v2.5-tie-in.md](./PLAN-v2.5-tie-in.md).

### But

Introduire un nouveau `PatternPlugin` `llm_proposed`, priorité 998 (juste avant `complex`), qui :

1. Sérialise le hunk (base/ours/theirs/contexte ±50 lignes) + la `DecisionTrace` partielle accumulée.
2. Appelle un endpoint configuré (MCP server externe ou direct API) avec un prompt structuré.
3. Reçoit une proposition de résolution.
4. Valide via le pipeline v2.4 (parse-tree validity + external si activé).
5. Accepte si valide ET si le score post-merge dépasse le seuil ; rejette sinon.

### Apport vs état actuel

ConGra (Zhao et al., arXiv:2409.14121) montre que les LLMs généralistes (Llama3-8B, DeepSeek-V2) résolvent 50-60 % des conflits de complexité moyenne. Project Harmony (Source.dev) atteint 88 % sur Android avec un SLM fine-tuné. GitWand peut capter une partie de ces gains sans entraîner de modèle, en faisant du LLM le dernier-recours bien-encadré.

L'angle UX est crucial : on ne remplace pas la résolution déterministe, on l'étend par un fallback dont chaque résolution est traçable, validée, et rejetable.

### Spécification

**Pattern plugin** :

```ts
// src/patterns/llm-proposed.ts
const llmProposed: PatternPlugin = {
  type: "llm_proposed",
  priority: 998,
  requires: "both",
  detect(h) {
    // toujours vrai si activé via options.llmFallback.enabled
    // sinon false (skip)
    return false; // par défaut OFF
  },
  ...
};
```

Le toggle se fait via un flag interne — `complex` reste à 999. Quand `options.llmFallback.enabled === true`, `detect()` retourne true et le pattern matche avant `complex`. La `confidence(...)` initiale est `dataRisk: 60, typeClassification: 50` (volontairement médiocre), pour que la décision finale dépende lourdement de la validation post-merge.

**Configuration** :

```jsonc
// .gitwandrc
{
  "llmFallback": {
    "enabled": false,               // OFF par défaut
    "endpoint": "mcp",              // "mcp" | "api" | "custom"
    "mcpToolName": "resolve_hunk",  // si endpoint=mcp
    "apiUrl": "...",                // si endpoint=api
    "model": "claude-sonnet-4-6",
    "maxTokens": 4000,
    "temperature": 0.0,             // déterministe pour reproductibilité
    "contextLines": 50,
    "minPostMergeScore": 80,        // refus si validation < 80
    "minMode": "strict"             // toujours strict pour le fallback LLM
  }
}
```

**Résolveur** :

```ts
// src/resolvers/llm-fallback.ts
export interface LlmResolveResult {
  lines: string[] | null;
  reason: string;
  rawResponse: string;
  validationScore: number;
}

export async function tryLlmFallbackResolve(
  hunk: ConflictHunk,
  filePath: string,
  fileContext: string,           // ±N lignes autour du hunk
  options: LlmFallbackConfig,
): Promise<LlmResolveResult>;
```

**Pipeline** :

1. `resolveHunk` voit `llm_proposed` matcher.
2. Sérialisation → call `tryLlmFallbackResolve`.
3. Récupération du contenu proposé.
4. Construction d'un fichier candidat (insertion du contenu proposé à la place du hunk).
5. `validateMergedContent(candidat, filePath)` (réutilise v2.4).
6. Si `validation.isValid && score ≥ minPostMergeScore` : accepter, écrire dans la `DecisionTrace` la trace de l'appel LLM (modèle, latence, raw response tronquée, validation result).
7. Sinon : refuser, fallback sur `complex`.

**API asynchrone** :

Bascule importante : `resolve()` devient asynchrone si `llmFallback.enabled`. Pour préserver la rétro-compat, on garde `resolve()` synchrone et on ajoute :

```ts
export function resolve(content, filePath, options): MergeResult;
export async function resolveAsync(content, filePath, options): Promise<MergeResult>;
```

`resolveAsync` est requis pour bénéficier du LLM fallback. `resolve()` synchrone skip le LLM même si activé (avec warning si `verbose`).

**Sécurité** :

- L'appel LLM **ne sort jamais du process** sauf via le MCP transport configuré par le consommateur. `@gitwand/core` ne fait pas de fetch HTTP direct — il appelle une fonction `endpoint.call(prompt)` injectée par le consommateur. C'est `@gitwand/cli` ou le desktop qui décident comment.
- Audit trail : chaque résolution LLM produit une entrée dans la `DecisionTrace` avec l'horodatage, le modèle invoqué, un hash SHA256 du prompt, le score de validation post-merge.

### API publique exposée

```ts
export {
  resolveAsync,
  type LlmFallbackConfig,
  type LlmEndpoint,
} from "./resolver/index.js";

export {
  tryLlmFallbackResolve,
  type LlmResolveResult,
} from "./resolvers/llm-fallback.js";
```

### Fichiers touchés

- **Nouveau** : `src/patterns/llm-proposed.ts`, `src/resolvers/llm-fallback.ts`, `src/resolver/llm-pipeline.ts`
- **Modifié** : `src/classifier.ts` (ajout pattern), `src/resolver/index.ts` (résolution async), `src/resolver/policy.ts` (LLM fallback skipé en `prefer-safety` / `strict`), `src/config.ts` (parsing `llmFallback`), `src/types.ts` (nouveau type `llm_proposed`), `src/index.ts` (exports)
- **Tests** : `src/__tests__/patterns/llm-proposed.test.ts` avec un mock endpoint déterministe, corpus +10 fixtures de cas où le LLM fallback aide vs nuit

### Desktop tie-in

- Settings → AI → toggle « Enable LLM fallback for unresolved conflicts ».
- Quand activé : laisser l'utilisateur choisir le provider (Claude API, OpenAI, Ollama local, MCP self-hosted).
- Decision trace UI : afficher le raisonnement du LLM, le score de validation, un bouton « Reject LLM resolution → fall back to manual ».
- Nécessite 3-layer rule (Rust + dev-server + TS) pour le hook de configuration.

### Risques + atténuation

- **Risque** : un LLM hallucine une résolution qui parse mais qui est sémantiquement fausse. **Atténuation** : `minPostMergeScore: 80` agressif, `level: "strict"` recommandé (active tsc/eslint), recommandation explicite « LLM fallback should be reviewed by human before commit » dans la doc.
- **Risque** : latence (3-15 s par hunk avec une API distante). **Atténuation** : timeout configurable, parallélisation par hunk, mode batch.
- **Risque** : coût (tokens). **Atténuation** : ne déclencher que sur `complex` strict, pas sur les hunks déjà résolus par les patterns déterministes ; laisser l'utilisateur tracker l'usage via les hooks.
- **Risque** : non-déterminisme. **Atténuation** : `temperature: 0.0` par défaut, log du seed/hash pour reproductibilité.

### Estimation effort

- 1.5-2 semaines pour l'infrastructure async + résolveur + tests.
- 1 semaine pour le tie-in MCP (modulo les tools déjà exposés par `@gitwand/mcp`).

### Critère de "done"

- En mode `llmFallback.enabled: true` avec un endpoint mocké déterministe, le moteur résout au moins 80 % des hunks `complex` du ConGra-mini sans régression sur le reste.
- Documentation publique sur la sécurité, la confidentialité (le code est envoyé à l'endpoint configuré), la reproductibilité.

---

## v2.6.0 — Refactoring-aware merge (expérimental)

> **Couverture des cas RefMerge/IntelliMerge : détecter les renames/moves avant le merge, inverser, fusionner, rejouer. Marqué expérimental — opt-in.**

### But

Détecter les **refactorings** (renames de symboles, moves de méthodes/fonctions, extraction de variable/method) entre `base → ours` et `base → theirs`, puis appliquer la stratégie RefMerge (Ellis et al., TSE 2023) : inverser les refactorings sur les deux branches, faire un merge classique sur le code « pré-refactor », rejouer ensuite les refactorings dans le résultat.

### Apport vs état actuel

RefMerge a montré sur 2001 merge scenarios qu'il introduit 11 % de conflits parasites contre 30 % pour IntelliMerge. C'est l'unique voie qui résout proprement la classe de conflits « rename d'un symbole + ajout d'un appel à l'ancien nom », fréquente sur les équipes en pleine refonte. Reste expérimental parce que l'inversion de refactorings non-triviaux (extract method, rename across files) demande une analyse de portée plus poussée.

### Spécification

**Détection de refactorings** :

Reposant sur tree-sitter (déjà chargé en v2.3) + heuristiques.

Refactorings cibles (par ordre d'effort) :

1. **Rename local** : variable/paramètre renommée dans une fonction. Détection : entité matchée par signature (en v2.3) avec un body qui ne diffère que par un substituent uniforme `oldName → newName` dans tous les usages locaux. Inversion triviale.
2. **Rename de symbole top-level** : fonction/classe renommée + ses usages mis à jour. Détection : entité disparue d'un côté + entité apparue avec body identique au précédent. Inversion : restaurer l'ancien nom partout.
3. **Move de méthode** : méthode déplacée d'une classe à une autre. Détection : entité disparue dans une classe + entité apparue avec body identique dans une autre classe.
4. **Extract method** (différé en 2.6.x ultérieur) : un bloc de code remplacé par un appel à une nouvelle fonction. Détection bien plus complexe.

**Pipeline RefMerge** :

```
Step 1: detectRefactorings(base, ours) → refactoringsOurs[]
Step 2: detectRefactorings(base, theirs) → refactoringsTheirs[]
Step 3: invertRefactorings(ours, refactoringsOurs) → oursRolledBack
Step 4: invertRefactorings(theirs, refactoringsTheirs) → theirsRolledBack
Step 5: classicMerge(base, oursRolledBack, theirsRolledBack) → mergedRolledBack
Step 6: replayRefactorings(mergedRolledBack, refactoringsOurs ⊕ refactoringsTheirs) → final
```

L'union des refactorings doit être **commutative ou ordonnée** pour rejouer proprement. C'est précisément le point délicat : RefMerge a une logique d'ordonnancement par dépendances qu'on doit reproduire.

**Pattern plugin** :

Nouveau pattern `refactoring_aware_merge` priorité 25 (juste après `oneSideChange`, avant `nonOverlapping`). Requires `diff3` (impossible sans base).

S'active si :

- (a) v2.3 structural merge a échoué (matching d'entités incomplet),
- (b) la détection de refactoring trouve au moins un refactoring d'un côté qui touche les entités impliquées dans le hunk,
- (c) `options.refactoringAware?.enabled === true` (opt-in).

### API publique exposée

```ts
export {
  detectRefactorings,
  invertRefactorings,
  replayRefactorings,
  type Refactoring,
  type RefactoringKind,  // "rename-local" | "rename-top-level" | "move-method" | ...
} from "./refactoring/index.js";
```

### Fichiers touchés

- **Nouveau** : `src/refactoring/index.ts`, `src/refactoring/detect.ts`, `src/refactoring/invert.ts`, `src/refactoring/replay.ts`, `src/refactoring/orchestration.ts`
- **Nouveau pattern** : `src/patterns/refactoring-aware-merge.ts`
- **Modifié** : `src/classifier.ts`, `src/config.ts`, `src/types.ts`, `src/index.ts`
- **Tests** : `src/__tests__/refactoring/`, corpus +15 fixtures (rename local, rename global, move method, conflit après rename d'un côté + ajout d'usage de l'autre)

### Risques + atténuation

- **Risque** : la détection de refactoring est imprécise, avec faux positifs (ex: deux variables sans rapport renommées indépendamment) qui produisent des inversions hostiles. **Atténuation** : seuils de similarité élevés (body hash > 90 % similar), pattern marqué expérimental, logs verbeux dans la `DecisionTrace`.
- **Risque** : complexité combinatoire si plusieurs refactorings se chevauchent. **Atténuation** : limiter le nombre de refactorings détectés à 5 par côté ; au-delà, abort + fallback.
- **Risque** : pour Java/C#, RefMerge classique utilise RefactoringMiner — qu'on n'a pas en TS. On reproduit une version simplifiée (les 3 refactorings ci-dessus seulement, pas les 50+ types de RefactoringMiner).

### Estimation effort

- 2-3 semaines pour les 3 refactorings cibles (rename local, rename top-level, move method).
- Phase 2 future (v2.6.x) : extract method, inline method, change signature.

### Critère de "done"

- Sur des fixtures isolées de chaque refactoring : 100 % de résolution correcte.
- Sur un corpus mixte : pas de régression sur les patterns déterministes existants ; gain mesurable sur la classe spécifique « rename + usage ailleurs ».
- Doc explicite que c'est expérimental, désactivé par défaut.

---

## Tableau de synthèse

| Release | Effort | Bundle Δ | Async required | Opt-in | Dependencies |
|---------|--------|----------|----------------|--------|--------------|
| **v2.1.0** Histogram + block-move | 5 j | +3 KB | Non | Non | Aucune |
| **v2.2.0** Format profiles + JSON Patch | 6 j | +5 KB | Non | Non | Aucune |
| **v2.3.0** Tree-sitter (5 langages) | 3-4 sem | +200 KB lib + grammars optionnelles | Non | Non | `web-tree-sitter`, grammars `optionalDeps` |
| **v2.4.0** Validation sémantique | 2 sem | +5 KB | Non (sync) / Oui (external) | External en opt-in | v2.3 (parse-tree) |
| **v2.5.0** LLM fallback | 2.5 sem | +10 KB | Oui (`resolveAsync`) | Oui (default OFF) | v2.4 |
| **v2.6.0** Refactoring-aware | 2-3 sem | +15 KB | Non | Oui (default OFF, expérimental) | v2.3 |

**Effort total** : ~15-20 semaines pour la séquence complète. Livrable continu, chaque release est shippable indépendamment.

---

## Stratégie de release

### Mode 1 — Patch core seul (préféré pour v2.1, v2.2, v2.6)

```bash
# Bumper packages/core/package.json uniquement
# Push sur main
# Trigger workflow_dispatch sur publish.yml
gh workflow run publish.yml -f package=core
```

Ne déclenche pas de tag `v*.*.*`, ne touche pas le desktop, ne touche pas cli/mcp.

### Mode 2 — Release alignée (pour v2.3, v2.4, v2.5)

Ces releases impliquent des changements desktop (Settings, UI de DecisionTrace, configuration LLM fallback). Bump aligné des 4 packages, tag `v2.X.0` classique.

### Étapes obligatoires de chaque release

1. `pnpm --filter @gitwand/core test` vert.
2. `pnpm --filter @gitwand/core test:bench` sans régression > 15 %.
3. ConGra-mini interne sans régression.
4. Mise à jour `packages/core/CHANGELOG.md` (à créer en début de v2.1).
5. Mise à jour `ROADMAP.md` (entrée dans la section "Shipped").
6. Si Mode 2 : mise à jour `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` pour les nouvelles strings UI.

---

## Métriques de succès

À mesurer release par release sur un corpus interne contrôlé (ConGra-mini, 50 conflits gradués A-F) :

- **Taux d'auto-résolution** : `autoResolved / totalConflicts` global.
- **Précision** : parmi les auto-résolus, fraction validée par le test de référence (le merge attendu).
- **Distribution par grade** : % résolu par niveau de complexité.
- **Latence p95** : temps par hunk en mode synchrone.
- **Faux positifs** : auto-résolutions qui passent la validation interne mais cassent le build sur un fork test.

| Release | Taux ciblé (vs v2.0) |
|---------|----------------------|
| v2.1.0 | +2-5 % global, +5-10 % sur les cases avec refactoring partiel |
| v2.2.0 | +10-15 % sur les fichiers JSON/YAML monorepo |
| v2.3.0 | +20-30 % sur les conflits TS/JS/Python/Go/Rust (le grand saut) |
| v2.4.0 | -50 % de faux positifs (parse-tree-cassé) |
| v2.5.0 | +10-20 % global avec LLM activé, 0 % sans (rétro-compat) |
| v2.6.0 | +5 % sur les cas spécifiques de rename, sinon stable |

---

## Companion content — articles de blog

Chaque release de la séquence est accompagnée d'un article publié sur `website/blog/` (et republié sur Hashnode pour le SEO, comme les articles existants). L'objectif : transformer l'effort R&D en signal de positionnement, et donner aux contributeurs/utilisateurs une porte d'entrée pédagogique vers chaque nouveauté du moteur.

**Conventions de format** (aligné sur les articles existants : `automatic-merge-conflict-resolution.md`, `split-commit-by-hunks.md`, `auto-merge-failure-modes.md`) :

- Markdown avec frontmatter (title, description, date, canonical Hashnode link).
- Anglais, première personne (Laurent), 7-12 min de lecture.
- Structure : problème observé → état de l'art que j'ai survolé → ce que GitWand fait/fera → trade-offs honnêtes → ouverture.
- Au moins un extrait de code TypeScript du `@gitwand/core` réel (pas de pseudo-code).

### Plan éditorial

| Article | À publier avec | Angle |
|---------|----------------|-------|
| **The state of automatic merge conflict resolution in 2026** (article de fond) | v2.1.0 | Tour d'horizon : textuel → Histogram → structural → sémantique → ML. Présente la roadmap v2 comme une feuille de route construite sur la littérature, pas sur l'intuition. |
| **Why I'm replacing LCS with Histogram diff in GitWand** | v2.1.0 | Article technique : pourquoi LCS pur produit des diffs sub-optimaux, comment Histogram s'ancre sur les lignes uniques, mesures avant/après. Bench reproductible. |
| **JSON arrays were always going to be the hard part** | v2.2.0 | Pourquoi la fusion sémantique des tableaux JSON est non-triviale, et comment un registre de profils (RFC 6902 + identité d'élément) résout les cas réels du monorepo. |
| **Tree-sitter inside a Tauri merge engine** | v2.3.0 | Le grand article du palier : adoption de tree-sitter, lazy loading WASM, entité-par-entité. Comparaison honnête avec Mergiraf et Weave. Partage les benchmarks ConGra-mini. |
| **Catching the merges that compile but break the tests** | v2.4.0 | Vulgarisation des conflits sémantiques (Da Silva 2024 : 60 % / 26×). Comment GitWand passe d'un `JSON.parse` de validation à un parse-tree-validity multi-langage. |
| **Letting an LLM resolve your hardest merge conflicts — safely** | v2.5.0 | Article-position : pourquoi le LLM fallback est *opt-in*, comment il est encadré (validation post-merge stricte, audit trail), pourquoi un SLM local bat un GPT-class distant (insights ConGra/Harmony). |
| **Inverting refactorings to merge them — RefMerge in TypeScript** | v2.6.0 | Vulgarisation de RefMerge (Ellis et al. TSE 2023), comment GitWand détecte les renames/moves sur tree-sitter et les rejoue dans le merge final. Statut expérimental assumé. |

### Production des articles

- Brouillon initial dans `website/blog/<slug>.md` pendant le développement de la release (pas après — les articles ancrés dans le code sont meilleurs).
- Mise à jour de `website/blog/index.md` (carte ajoutée en haut de la liste) à la publication.
- Republication Hashnode : compte `devlint.hashnode.dev`, lien canonique dans le frontmatter.
- Cross-post optionnel : Hacker News (sur les paliers majeurs : v2.3, v2.5), Lobsters, /r/git, /r/programming.

---

## Annexes

### Sources de référence

- [ConGra: Benchmarking Automatic Conflict Resolution (arXiv:2409.14121)](https://arxiv.org/abs/2409.14121)
- [Mergiraf — architecture documentation](https://mergiraf.org/architecture.html)
- [Weave — Entity-Level Semantic Merge for Git](https://github.com/Ataraxy-Labs/weave)
- [RefMerge — Operation-based Refactoring-aware Merging (arXiv:2112.10370)](https://arxiv.org/abs/2112.10370)
- [Detecting Semantic Conflicts with Unit Tests (arXiv:2310.02395)](https://arxiv.org/html/2310.02395)
- [How different are different diff algorithms in Git? (Springer EMSE 2019)](https://link.springer.com/article/10.1007/s10664-019-09772-z)
- [web-tree-sitter (npm)](https://www.npmjs.com/package/web-tree-sitter)
- [Project Harmony — 88% merge conflict auto-resolution (Source.dev)](https://www.source.dev/journal/harmony-preview)
