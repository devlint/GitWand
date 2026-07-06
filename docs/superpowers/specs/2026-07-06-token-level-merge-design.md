# Pattern `token_level_merge` — résolution assistée des conflits intra-hunk fins

- **Date** : 2026-07-06
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `packages/core` (nouveau pattern + registre + types) et `apps/desktop`
  (UI de proposition/confirmation). Parité Rust obligatoire (`apps/desktop/src-tauri/`).
- **Branche** : à créer (`feat/token-level-merge`).

## Problème

Tous les patterns du classifier (`packages/core/src/classifier.ts`) raisonnent au niveau
**ligne entière** ou **bloc d'édition contigu**. Quand un hunk regroupe plusieurs lignes
adjacentes modifiées, même si chaque ligne prise isolément n'a qu'un seul côté qui diverge de
la base (ou des tokens disjoints modifiés par chaque côté sur une même ligne), le pattern
`non_overlapping` échoue car `mergeNonOverlapping()` détecte un chevauchement au niveau du
bloc d'édition, pas ligne par ligne. Le hunk tombe alors sur `complex` (confiance 0,
résolution manuelle forcée), alors que le conflit est en réalité non-ambigu ou décomposable.

**Cas réel observé** : `resources/views/gestion/upsells/suggestions/index.blade.php` — deux
lignes adjacentes (`class="... gap-x-2 ..."` et `class="... font-weight-bold ..."`), chacune
modifiée par un seul côté par rapport à la base, classées `complex` par GitWand alors que
PhpStorm les recombine (par interclassement heuristique basé sur les dates de commit, pas par
une vraie fusion sémantique).

## Objectif

Ajouter un nouveau pattern qui **propose** une fusion fine (ligne-par-ligne, puis token-level
pour les lignes encore ambiguës) — sans jamais l'auto-appliquer. L'utilisateur doit
explicitement accepter ou rejeter la proposition, réutilisant le mécanisme déjà existant pour
`llm_proposed` (panneau Accept/Reject).

## Non-objectifs (YAGNI)

- Pas de compréhension sémantique du contenu (Tailwind, CSS, etc.) — le pattern reste
  syntaxique : il détecte l'absence de chevauchement textuel, jamais le sens.
- Pas de résolution partielle silencieuse : si une seule ligne du hunk résiste aux deux passes,
  le pattern entier échoue et retombe sur `complex`.
- Pas d'auto-application, même à confiance élevée — contrairement aux patterns 10-60
  existants. C'est une propriété permanente du pattern, pas un seuil réglable.
- Pas de réordonnancement de lignes ni de fusion inter-lignes (les lignes restent alignées 1:1
  par position ; le réordonnancement est déjà couvert par `reorder_only`).

## Décision clé — deux passes, échec global si une ligne résiste

1. **Passe 1 — décomposition ligne-par-ligne** : pour chaque ligne `i` du hunk, comparer
   `base[i]` / `ours[i]` / `theirs[i]`. Si exactement un côté diffère de la base → résolue
   trivialement (équivalent `one_side_change` local). Les lignes où aucun côté ne diffère sont
   triviales aussi (contexte). Les lignes restantes passent en passe 2.
2. **Passe 2 — diff word-level** sur les lignes encore en conflit : tokenizer (découpage sur
   espaces, `=`, guillemets — générique, pas de parsing HTML/CSS) et faire un 3-way merge de
   la séquence de tokens via l'algo LCS déjà présent (`diff/lcs.ts`, réutilisé sans
   réécriture). Si les tokens modifiés par `ours` et `theirs` sont disjoints → ligne résolue.
3. **Condition de succès globale** : `detect()` retourne `true` uniquement si **toutes** les
   lignes du hunk sont résolues (passe 1 ou 2). Sinon échec complet → `complex`.

## Architecture & flux

### `packages/core`

- **`src/types.ts`** : ajouter `"token_level_merge"` à l'union `ConflictType`.
- **`src/patterns/token-level-merge.ts`** (nouveau fichier, default export `PatternPlugin`) :
  - `priority: 65` — après `value_only_change` (60), avant `refactoring_aware_merge` (970).
    Même famille que les patterns textuels 10-60 : évalué seulement si ceux-ci ont tous échoué.
  - `requires: "diff3"` (la base est nécessaire pour la passe 1).
  - `confidence()` : toujours `label: "medium"`, `dataRisk` non nul (≈35-40) — signal explicite
    pour le frontend que ce type ne doit jamais s'auto-appliquer, indépendamment du score.
  - `explanation()` : précise combien de lignes ont été résolues par passe 1 vs passe 2 (texte
    lisible affiché dans le panneau UI).
- **`src/classifier.ts`** : importer et enregistrer le nouveau pattern dans `PATTERNS`.
- **`src/resolver/assemble.ts`** : s'assurer que `type === "token_level_merge"` n'est **jamais**
  routé vers l'auto-application (même garde que pour `llm_proposed` avant acceptation
  utilisateur — vérifier le point d'entrée exact lors du plan d'implémentation).

### Parité Rust (`apps/desktop/src-tauri/`)

Porter les deux passes (décomposition ligne-par-ligne + tokenizer + merge LCS) côté Rust.
Le tokenizer et le merge LCS doivent produire des résultats identiques bit-à-bit dans les deux
langages — le `parity-probe` doit passer. **Poste de coût principal du projet** ; à détailler
comme étape dédiée dans le plan d'implémentation (le tokenizer générique est le point le plus
sensible à la divergence Rust/TS : ordre d'itération, gestion des guillemets, etc.).

### Frontend (`apps/desktop`)

- **Généralisation de `LlmTracePanel.vue`** → `ProposedResolutionPanel.vue` (extraction de la
  logique Accept/Reject commune ; `LlmTracePanel` devient une spécialisation qui lui passe des
  props différentes — pas de duplication).
- **`MergeEditor.vue`** :
  - Condition d'affichage étendue : `v-if="hunk.type === 'llm_proposed' || hunk.type === 'token_level_merge'"`.
  - Contenu du panneau pour `token_level_merge` : diff word-level annoté, chaque token changé
    surligné avec sa provenance (bleu = ours, violet = theirs — cohérent avec les couleurs déjà
    utilisées dans le viewer 3-way).
  - Boutons `Accepter` / `Rejeter` : mêmes émissions que l'existant (`accept` applique la
    résolution proposée ; `reject` ajoute le hunk à un `Set` côté client, comme
    `rejectedLlmHunks`, et revient à l'affichage manuel 3 colonnes — pas de changement de
    `hunk.type` côté core).
  - Minimap (ligne ~1091) : nouvelle couleur ambre/orange dédiée pour "proposition en attente"
    (distincte du vert "auto-résolu" et du rouge "manuel").
- **`useMergePreview.ts`** : aucun changement — il consomme déjà `resolve()` tel quel.
- **i18n** : nouvelles clés (5 locales) pour le libellé du panneau, l'explication passe 1/passe 2.

## Gestion des erreurs / garde-fous

- Le tokenizer reste syntaxique — jamais de règle spécifique à un framework CSS.
- Aucune résolution partielle silencieuse : échec total du pattern si une ligne résiste.
- La confirmation utilisateur obligatoire est la garde-fou principal contre les faux positifs
  sémantiques (ex. deux classes Tailwind mutuellement exclusives) — pas une heuristique
  supplémentaire dans l'algorithme.
- Rejet utilisateur = pas de perte : le hunk repasse simplement en édition manuelle (comportement
  identique à un `complex` classique).

## Tests

Minimum 15 cas (règle `packages/core/CLAUDE.md` : 10 minimum par nouveau pattern, ici renforcé
car deux sous-mécaniques) :

- **5 cas passe 1 seule** — plusieurs lignes adjacentes, un seul côté change par ligne (dont le
  cas de régression réel `upsells/suggestions/index.blade.php`, ajouté à `__tests__/corpus.ts`).
- **5 cas passe 2** — chevauchement intra-ligne avec tokens disjoints (ex. `class="a b"` → ours
  change `a`, theirs change `b`).
- **5 cas négatifs** — tokens qui se chevauchent réellement (les deux côtés touchent le même
  token) → doit échouer et retomber sur `complex`.
- **Parity probe** : chaque cas ci-dessus rejoué côté Rust, résultat identique bit-à-bit.
- **Frontend** : le panneau `ProposedResolutionPanel` s'affiche pour `token_level_merge`, le
  rejet downgradé bascule bien vers le 3-way manuel, l'acceptation applique les bonnes lignes.

## Contraintes & règles projet

- `packages/core` : zéro dépendance Node.js (tokenizer en JS/TS pur).
- Parité Rust/TS obligatoire avant merge (`pnpm test:parity`).
- IPC : aucun changement Tauri nécessaire (le pattern vit entièrement dans `packages/core`,
  consommé tel quel par `useMergePreview.ts`).
- i18n : toute string visible du nouveau panneau dans les 5 locales.
- Diff parsing : respecter la règle des lignes de contexte (`line.startsWith(' ')`) déjà en
  vigueur dans le parser — le tokenizer de la passe 2 s'appuie sur les lignes déjà extraites,
  pas sur le diff brut.

## Risques

- **Divergence Rust/TS du tokenizer** : le risque principal. Mitigation : spécifier l'algorithme
  de tokenisation de façon exhaustive avant d'écrire le code Rust (table de règles, pas
  d'implémentation "au feeling" séparée).
- **Confidence toujours "medium" mais jamais auto-appliqué** : rupture avec la convention
  actuelle où confidence pilote l'auto-application. À documenter clairement dans
  `packages/core/CLAUDE.md` (tableau des patterns) pour éviter qu'un futur pattern copie ce
  comportement par erreur.
- **Fatigue de confirmation** : si ce pattern matche très souvent, l'utilisateur peut se lasser
  de cliquer "Accepter" à répétition. Hors périmètre de ce design (pas de mémorisation de
  préférence "toujours accepter ce type" — à évaluer après usage réel, pas préventivement).
