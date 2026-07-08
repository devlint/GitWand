# Décision — Fusion commutative généralisée : NON ; tokens quote-aware : OUI

Status: **Décidé (mesures à l'appui)** · Date: 2026-07-08 · Corpus: dendreo 2000 merges (`scripts/replay-conflicts.mjs --lists`)

## 1. Question initiale

L'analyse comparative avec l'état de l'art (Mergiraf, Spork) avait identifié la
« fusion de listes commutatives pilotée par la grammaire » (imports, clés
d'objet, variants d'enum, éléments de tableau) comme l'un des deux manques
potentiels du moteur. Avant d'ouvrir le chantier : mesurer l'opportunité sur
conflits réels, même discipline que token_level_merge (7,5 % → build) et
cherry_pick_echo (1 % → no build).

## 2. Mesure

Heuristique `--lists` du script de replay : parmi les hunks `complex`, combien
sont « en forme de liste » (chaque ligne non vide ressemble à un élément de
collection), et parmi ceux-là, combien sont *prouvablement fusionnables* au
grain ligne (aucune ligne de base touchée par les deux côtés) ?

| Mesure | Valeur |
|---|---|
| Hunks complex | 198 |
| … en forme de liste | 101 (51 %) |
| … **fusionnables (éléments disjoints)** | **1 (0,5 %)** |
| … même élément touché des deux côtés | 100 |

## 3. Verdict : ne pas construire

Le 51 % de forme était un mirage de sélection : **tout ce qui est disjoint est
déjà absorbé en amont** par `non_overlapping` (LCS 3-way, prio 40) et
`insertion_at_boundary` (union, prio 57). Ce qui atteint `complex` est, par
construction, du « même élément modifié des deux côtés » — précisément le cas
où un set-merge commutatif ne peut rien (l'exemple DdToast.vue du corpus :
ours raffine un literal, theirs l'extrait en constante — vrai conflit
sémantique, territoire `llm_proposed`). Un moteur Mergiraf-like n'apporterait
ici qu'1 hunk sur 198.

## 4. Découverte en creusant les 100 « même élément » : le vrai gisement

Le hunk résiduel **le plus récurrent de tout le corpus** (16+ merges
différents) : `config/dendreo.php` → `'last_update' => '2026-07-06 11:42:00',`
— un timestamp quoté modifié des deux côtés. `value_only_change` le ratait
uniquement parce que `tokenizeLine` splitte les strings quotées sur leurs
espaces internes : `2026-07-06 11:42:00` devient deux fragments dont aucun ne
matche la regex datetime.

**Fix livré avec cette décision** :
- `tokenizeLineQuoteAware` (utils.ts) : contenu quoté atomique — utilisé par
  `detectValueOnlyChange` et `pickNewerSemverSide` (le dénominateur du ratio
  de confiance garde la granularité historique, seuils non retouchés ;
  `token_level_merge` garde volontairement l'ancien tokenizer, la fusion
  intra-string y est voulue).
- Comparaison datetime ISO dans `pickNewerSemverSide` (ordre lexicographique =
  chronologique) : le timestamp le plus tardif gagne, déterministe — même
  doctrine que semver-max.

## 5. Impact mesuré (avant → après, même corpus)

| | Avant | Après |
|---|---|---|
| `complex` | 198 | **96** |
| Résidu (post-trivial) | 214 | **104** |
| `value_only_change` | 0 | 1598* |

\* dont ~1488 hunks de manifests qui passaient par la reclassification
`generated_file` (même tier trivial, même résolution) — le gain réel est la
conversion de **102 hunks complex** en résolutions déterministes, soit un
résidu divisé par deux. 8 hunks `token_level_merge` sont aussi pris plus tôt
par `value_only_change` (prio 60 < 65) : valeurs quotées ordonnables → auto au
lieu d'un panneau de confirmation, cohérent.

## 6. Si la fusion commutative revient un jour

Le corpus dendreo est un monorepo PHP/Vue à branches courtes ; un corpus
TypeScript à gros barrels d'exports ou un monorepo à conflits d'imports
massifs pourrait donner un autre chiffre. Re-mesurer avec `--lists` avant tout
chantier — le seuil de viabilité utilisé jusqu'ici : ≥ 5 % du résidu.
