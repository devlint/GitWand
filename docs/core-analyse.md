# Analyze Technique Augmenté - Core de Résolution

## Objectif
Cette note analyse le moteur de résolution du core GitWand comme un système déterministe de classification + fusion, avec un focus sur :
- sa robustesse
- sa prédictibilité
- ses limites de conception
- les augmentations techniques utiles pour réduire les faux positifs et les comportements “magiques”

## Périmètre
Fichiers étudiés :
- [`packages/core/src/parser.ts`](/Users/laurent/Documents/GitHub/GitWand/packages/core/src/parser.ts)
- [`packages/core/src/diff.ts`](/Users/laurent/Documents/GitHub/GitWand/packages/core/src/diff.ts)
- [`packages/core/src/resolver.ts`](/Users/laurent/Documents/GitHub/GitWand/packages/core/src/resolver.ts)
- [`packages/core/src/types.ts`](/Users/laurent/Documents/GitHub/GitWand/packages/core/src/types.ts)

## Architecture logique

Le moteur suit un pipeline simple :

```mermaid
flowchart LR
  A[Conflicted text] --> B[parseConflictMarkers]
  B --> C[classifyConflict]
  C --> D[resolveHunk]
  D --> E[MergeResult]
```

### Rôles
- `parser.ts` : extraction des segments textuels et des conflits bruts
- `diff.ts` : comparaison des versions base / ours / theirs
- `resolver.ts` : politique de résolution selon le type et la confiance
- `types.ts` : contrat de données entre les couches

---

## Lecture technique du moteur

### 1. Parsing des marqueurs
[`parseConflictMarkers`](https://dummy.local) dans `parser.ts` découpe un fichier selon les marqueurs Git :
- `<<<<<<< ours`
- `||||||| base`
- `=======`
- `>>>>>>> theirs`

Le moteur supporte à la fois :
- format diff2
- format diff3

#### Point fort
Le parsing est indépendant du format métier du fichier. C’est simple, rapide, et testable.

#### Limite
Le parsing reste textuel. Il ne valide pas :
- la cohérence syntaxique du bloc
- la structure du fichier
- les cas de conflits mal formés

Si les marqueurs sont incomplets ou altérés, le moteur peut perdre du contexte ou classifier trop tôt.

#### Risque technique
Le parseur traite la ligne d’ouverture `<<<<<<<` comme un vrai début de conflit, mais il ne conserve pas de métadonnées structurées sur la forme d’origine du conflit au-delà des tableaux `ours/base/theirs`.
Conséquence : certaines reconstructions ultérieures peuvent perdre le format exact d’origine.

---

### 2. Classification des conflits
[`classifyConflict`](https://dummy.local) applique une suite de règles ordonnées :
- `same_change`
- `delete_no_change`
- `one_side_change`
- `non_overlapping`
- `whitespace_only`
- `value_only_change`
- `complex`

#### Ce qui est bien
L’ordre des règles est compréhensible et reflète une logique métier :
- cas évidents d’abord
- heuristiques plus souples ensuite
- fallback `complex` à la fin

#### Ce que cela implique
L’algorithme est **prioritaire par ordre d’évaluation**, pas par score global.
Cela veut dire qu’un cas peut changer de catégorie non pas parce qu’il est intrinsèquement différent, mais parce qu’une règle amont “gagne” avant les autres.

C’est acceptable pour un moteur heuristique simple, mais cela limite la prédictibilité.

---

### 3. Résolution des hunks
[`resolve`](https://dummy.local) et `resolveHunk` transforment chaque hunk en :
- contenu résolu
- ou conflit conservé

Les types résolus automatiquement incluent :
- `same_change`
- `one_side_change`
- `delete_no_change`
- `whitespace_only`
- `non_overlapping`
- `value_only_change`
- `generated_file`

#### Point fort
Le moteur sépare clairement :
- la décision de résolution
- l’application de la résolution
- la reconstruction du fichier final

#### Limite
La politique de résolution est encore assez “hard-coded”.
Exemple :
- `value_only_change` prend systématiquement `theirs`
- `generated_file` prend aussi `theirs`
- `whitespace_only` préfère `ours`

Ces choix sont rationnels, mais ils sont des conventions implicites.
Ils devraient idéalement être documentés comme des stratégies, pas comme des automatismes cachés.

---

## Forces techniques

### 1. Déterminisme
Le moteur est reproductible.
Même entrée = même sortie.
C’est fondamental pour :
- CI
- audit
- debug
- confiance utilisateur

### 2. Typage fort
Le système de types donne une interface stable :
- `ConflictType`
- `Confidence`
- `ConflictHunk`
- `MergeResult`
- `HunkResolution`

Cela facilite :
- les tests
- l’intégration CLI/desktop/VS Code
- la maintenance

### 3. Explicabilité
Chaque classification renvoie une `explanation`.
C’est un vrai atout par rapport à un merge “opaque”.

### 4. Garde-fou
Le type `complex` évite de sur-résoudre.
Le moteur privilégie la sécurité à l’automatisme.

### 5. Extensibilité raisonnable
L’architecture actuelle permet d’ajouter :
- de nouveaux types de conflits
- des heuristiques supplémentaires
- des stratégies plus fines

---

## Faiblesses techniques

### 1. Trop textuel, pas assez syntax-aware
Le moteur compare des lignes et des tokens, mais pas des structures.

Cela le rend fragile sur :
- JSON
- YAML
- Vue SFC
- TS/JS avec blocs imbriqués
- CSS avec réécriture partielle
- fichiers générés structurés

#### Conséquence
Deux edits syntaxiquement indépendants peuvent être vus comme :
- non-overlapping
- ou ambiguës
selon la forme exacte du texte.

---

### 2. `whitespace_only` trop naïf
Actuellement, la comparaison passe par une normalisation légère basée sur `trim()` ligne par ligne.

#### Problèmes
- ne gère pas l’indentation de manière fine
- ne gère pas le whitespace interne
- ne tient pas compte du langage
- ne distingue pas bien structure vs présentation

#### Risque
Un fichier peut être classé `whitespace_only` alors que la différence est plus sémantique qu’elle n’en a l’air, ou l’inverse.

---

### 3. `value_only_change` heuristique mais peu contractuelle
La logique de détection des valeurs volatiles repose sur :
- tokenisation simplifiée
- regex de patterns volatils
- ratio de différence

#### Avantage
Très utile pour des cas de version, hash, timestamp, URL, artefacts de build.

#### Faiblesse
Le résultat dépend fortement :
- de la forme de la ligne
- du découpage des tokens
- du seuil heuristique
- de la densité du bloc

Cela peut créer des décisions “presque magiques” pour l’utilisateur.

---

### 4. `non_overlapping` repose sur un diff ligne par ligne
Le moteur calcule les edits via LCS.
C’est correct, mais :
- coûteux en `O(n*m)`
- purement textuel
- sensible au déplacement de blocs

#### Implication
Sur des fichiers longs ou structurés, la notion de “non-overlapping” peut manquer de stabilité.

---

### 5. Confiance encore trop discrète
Le type `Confidence` est utile, mais il reste un label :
- `certain`
- `high`
- `medium`
- `low`

#### Limite
Ce n’est pas un score de preuve.
Le moteur ne fournit pas :
- la profondeur du raisonnement
- le nombre de règles inspectées
- le degré de similarité observé
- la marge entre la meilleure et la deuxième meilleure hypothèse

---

### 6. Manque de validation post-résolution
Le moteur reconstruit le fichier, mais ne valide pas systématiquement :
- qu’aucun marqueur de conflit ne reste
- que le fichier est syntaxiquement plausible
- que la fusion n’a pas cassé la structure du document

---

## Où le moteur devient “magique”

Le terme “magique” apparaît quand le système :
- prend une décision juste sans l’expliquer suffisamment
- ou prend une décision correcte mais difficile à anticiper

Les zones les plus sensibles sont :
- `value_only_change`
- `non_overlapping`
- les choix implicites `ours/theirs`
- la priorité de certaines règles sur d’autres

En pratique, l’utilisateur peut se dire :
> “Pourquoi ce conflit a-t-il été auto-résolu alors que celui d’à côté est resté manuel ?”

Le problème n’est pas la résolution automatique en soi, mais le manque de contrat explicite autour de la décision.

---

## Ce qui rend le core robuste aujourd’hui

### 1. Le fallback manuel est conservé
Le moteur évite les abus.

### 2. Les types de conflit sont explicitement nommés
On peut auditer les décisions.

### 3. La logique de résolution est localisée
Il n’y a pas d’effet de bord dispersé.

### 4. Les tests peuvent être très ciblés
Le moteur est facile à couvrir par fixture de conflit.

---

## Améliorations techniques recommandées

### 1. Introduire un `DecisionTrace`
Pour chaque hunk, produire une trace structurée de décision :

```ts
interface DecisionTrace {
  candidates: ConflictType[];
  selected: ConflictType;
  score: number;
  reason: string;
  rejectedBy: Array<{
    candidate: ConflictType;
    reason: string;
  }>;
}
```

#### Bénéfice
- meilleure lisibilité
- meilleure debugabilité
- meilleure confiance utilisateur

---

### 2. Ajouter des résolveurs par format
Créer des stratégies spécialisées pour :
- JSON / JSONC
- YAML
- Markdown
- Vue SFC
- TS/JS/TSX
- CSS
- lockfiles

#### Objectif
Remplacer une partie des heuristiques textuelles par des règles syntaxiques.

#### Approche
- garder le moteur textuel comme fallback
- brancher un résolveur spécialisé si le type de fichier est reconnu

---

### 3. Ajouter une validation post-merge
Après fusion :
- reparsing du fichier
- vérification absence de marqueurs
- validation format si possible
- rejet si le fichier final est manifestement incohérent

#### Exemples
- JSON : parse strict
- YAML : parse permissif
- TS/JS : parse syntaxique si le coût est acceptable

---

### 4. Remplacer la confiance discrète par un score composite
Par exemple :

```ts
interface ConfidenceScore {
  overall: number; // 0..1
  structure: number;
  lexical: number;
  volatility: number;
  overlapRisk: number;
}
```

#### Bénéfice
- meilleure calibration
- meilleure comparabilité entre types de conflits
- seuils plus explicites

---

### 5. Rendre les politiques explicites et configurables
Ajouter des stratégies de merge :

- `prefer-ours`
- `prefer-theirs`
- `prefer-safety`
- `prefer-merge`
- `strict`

#### Bénéfice
Le moteur cesse d’imposer silencieusement certaines conventions.

---

### 6. Renforcer la normalisation
Faire une normalisation plus intelligente selon le format :
- indentation
- espaces internes
- lignes vides
- ordering des attributs
- ordering des clés pour certains formats

---

### 7. Ajouter un “explain only mode”
Mode qui :
- ne modifie rien
- affiche les règles évaluées
- montre pourquoi le hunk est résolu ou non

C’est l’un des meilleurs moyens de réduire la sensation de “magie”.

---

### 8. Introduire une couverture par corpus réel
Constituer un set de conflits réels anonymisés pour mesurer :
- faux positifs
- faux négatifs
- stabilité de classification
- impact des seuils

---

## Roadmap technique proposée

### Phase 1 - Rendre visible
Objectif : expliquer mieux sans changer l’algorithme.

- ajouter `DecisionTrace`
- exposer les raisons de non-résolution
- enrichir les tests avec traces attendues

### Phase 2 - Rendre plus fiable
Objectif : réduire les faux positifs.

- validation post-merge
- meilleure normalisation whitespace
- réglage plus fin des seuils de confiance

### Phase 3 - Rendre plus intelligent
Objectif : passer de textuel à format-aware.

- résolveurs spécialisés
- parseurs structurés
- stratégie par type de fichier

### Phase 4 - Rendre mesurable
Objectif : industrialiser la qualité.

- corpus de conflits
- métriques de résolution
- détection de régression

### Phase 5 - Ouvrir au LLM : package MCP + commandes Claude Code

Objectif : exposer la résolution intelligente de conflits comme service MCP pour les agents de code (Claude Code, Cursor, Windsurf), et enrichir l'intégration `.claude/` existante.

#### Pourquoi GitWand en MCP et pas un MCP Git générique

Les serveurs MCP Git existants (git-mcp-server, gitMCP) font des opérations Git basiques (status, diff, commit). GitWand apporterait quelque chose d'unique : la résolution intelligente de conflits avec scoring de confiance et `DecisionTrace` structuré. Le core `@gitwand/core` est déjà framework-agnostic, la CLI est séparée, et le JSON de sortie est propre — exactement ce qu'un LLM peut consommer.

#### Étape 1 — Quick win : enrichir `.claude/commands/` (effort : minimal)

Le dossier `.claude/` existe déjà dans le repo. Ajouter des commandes Claude Code qui décrivent les workflows GitWand pour que Claude les utilise via `bash_tool` sans nouveau package :

```
.claude/commands/resolve.md      → instructions pour lancer gitwand resolve --ci
.claude/commands/preview.md      → workflow merge preview + analyse des risques
```

En parallèle, enrichir le payload `--ci` existant : le mode JSON retourne déjà les résolutions, mais il manque les hunks non résolus dans le payload. Ajouter `pendingHunks` avec leur contenu brut permettrait à Claude Code d'utiliser la CLI directement sans attendre le serveur MCP.

#### Étape 2 — Package `@gitwand/mcp` (effort : moyen)

Nouveau package dans le monorepo, utilisant le SDK officiel `@modelcontextprotocol/sdk` TypeScript.

**Structure du package :**

```
packages/
  mcp/                    ← nouveau @gitwand/mcp
    src/
      server.ts           ← point d'entrée MCP (stdio ou HTTP)
      tools/
        resolve.ts        ← gitwand_resolve_conflicts
        preview.ts        ← gitwand_preview_merge
        status.ts         ← gitwand_status
        explain.ts        ← gitwand_explain_hunk
        apply.ts          ← gitwand_apply_resolution
      resources/
        conflicts.ts      ← gitwand://repo/conflicts
        policy.ts         ← gitwand://repo/policy
        hunk.ts           ← gitwand://hunk/{file}/{line}
      schemas/            ← JSON Schema des inputs/outputs (réutilise les types core)
```

**Tools exposés (ce que le LLM peut invoquer) :**

| Tool | Description |
|---|---|
| `gitwand_resolve_conflicts` | Lance le core sur un fichier, retourne le résultat + DecisionTrace |
| `gitwand_preview_merge` | Simule un merge, retourne la liste ours/partial/manual |
| `gitwand_status` | Liste les fichiers en conflit + leur complexité estimée |
| `gitwand_explain_hunk` | Explique pourquoi un hunk est "complex" (pour que le LLM décide) |
| `gitwand_apply_resolution` | Applique une résolution suggérée par le LLM sur un hunk manual |

**Resources exposées (contexte que le LLM peut lire) :**

| Resource | Description |
|---|---|
| `gitwand://repo/conflicts` | État actuel des conflits |
| `gitwand://repo/policy` | Contenu du .gitwandrc |
| `gitwand://hunk/{file}/{line}` | Le hunk brut d'un conflit pour que le LLM le lise |

Le tool `gitwand_apply_resolution` est la clé de voûte : il crée une boucle de collaboration — GitWand résout ce qu'il peut avec certitude, passe les hunks `complex` au LLM avec leur contexte, le LLM propose une résolution, GitWand l'applique de façon sécurisée.

**Configuration pour l'utilisateur final :**

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["@gitwand/mcp"]
    }
  }
}
```

#### Étape 3 — Publication au registre MCP (effort : faible)

Une fois publié sur npm, soumettre sur `github.com/modelcontextprotocol/servers` et le MCP Registry officiel. C'est là que les développeurs utilisant Claude Desktop, Cursor ou Windsurf cherchent des outils.

#### Améliorations du core nécessaires pour le MCP

**1. Output JSON structuré enrichi.** Le `DecisionTrace` actuel est lisible humain. Pour MCP, il faudrait un mode `--output json` (le `--ci` existe déjà, à étoffer) avec un payload structuré incluant les hunks pendants :

```json
{
  "file": "src/config.ts",
  "autoResolved": 3,
  "pendingHunks": [
    {
      "line": 41,
      "pattern": "complex",
      "ours": "...",
      "theirs": "...",
      "context": "...",
      "suggestedResolution": null
    }
  ]
}
```

**2. Mode explain pour les hunks complex.** Actuellement les hunks `complex` sont skippés sans explication. Ajouter une explication textuelle du *pourquoi* (overlapping at lines X–Y, both sides modified the same function signature) pour que le LLM comprenne le contexte sans lire tout le diff.

**3. Streaming du DecisionTrace.** Pour les gros repos, permettre un output streaming (NDJSON line-by-line) pour que le LLM affiche la progression en temps réel via MCP.

#### Ce que ça change concrètement pour un dev avec Claude Code

1. Détection automatique des conflits après un `git pull` / `git merge`
2. Lancement de `gitwand_preview_merge` avant de merger une branche pour résumer les risques
3. Auto-résolution des conflits certains/high sans intervention
4. Soumission **uniquement** des hunks `complex` avec leur contexte pour décision humaine ou LLM
5. Logging de l'historique des résolutions pour alimenter le hotspot analysis

#### Récapitulatif effort / valeur

| Approche | Effort | Public cible | Disponibilité |
|---|---|---|---|
| `.claude/commands/` enrichi | Minimal | Devs Claude Code sur le repo | Immédiat |
| Payload `--ci` enrichi (pendingHunks) | Faible | Devs utilisant la CLI via bash_tool | Court terme |
| `@gitwand/mcp` sur npm | Moyen | Tout dev avec Claude Desktop/Code/Cursor | Moyen terme |
| Soumission MCP Registry | Faible (soumission) | Communauté Claude/Cursor/Windsurf | Après publish |

---

## Risques si on ne change rien

### 1. Accumulation de faux positifs “raisonnables”
Le moteur peut paraître bon en test mais produire des décisions discutables sur des projets réels.

### 2. Perception de magie
Le produit peut être perçu comme utile mais imprévisible.

### 3. Difficulté de maintenance
Les heuristiques grossissent sans contrat explicite ni mesure de qualité.

### 4. Limitation sur les formats modernes
Le moteur restera performant sur les conflits textuels simples mais moins convaincant sur les fichiers structurés.

---

## Conclusion
Le core actuel est une bonne base de moteur de merge déterministe.
Il a trois qualités majeures :
- lisibilité
- sécurité
- explicabilité partielle

Sa principale faiblesse est de rester un moteur textuel heuristique alors que les cas modernes demandent davantage :
- de structure
- de validation
- de traçabilité
- de spécialisation par format

La meilleure évolution n’est pas de le rendre “plus magique”, mais de le rendre :
- plus explicite
- plus prévisible
- plus format-aware
- plus vérifiable

## Priorités recommandées
1. Ajouter une trace de décision par hunk
2. Ajouter une validation post-résolution
3. Introduire des stratégies par type de fichier
4. Calibrer la confiance avec un score composite
5. Rendre les politiques de merge configurables
6. Enrichir `.claude/commands/` et le payload `--ci` (quick win MCP)
7. Packager `@gitwand/mcp` et publier sur le MCP Registry
