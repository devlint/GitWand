# Résolution globale au niveau fichier + règle mémorisée auto-appliquée

- **Date** : 2026-06-17
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `apps/desktop` (frontend Vue uniquement — aucun changement du moteur `packages/core`)

## Problème

Sur un merge avec beaucoup de conflits (ex. `public/build/manifest.json` : 245 conflits dont 241
auto-résolvables), l'utilisateur ne gagne pas de temps :

1. **Queue résiduelle** — « Résoudre auto » n'applique que les hunks sûrs
   (`type !== "complex"` ET confiance ≥ medium). Les hunks restants (ici 4) forcent un passage en
   mode manuel. Le coût réel d'une résolution est le changement de contexte, pas le nombre de hunks :
   devoir traiter 4 hunks à la main fait perdre ~80 % du bénéfice de l'automatisation.
2. **Règle mémorisée non appliquée** — une règle `theirs → manifest.json` peut exister et s'afficher
   dans un bandeau vert, mais elle n'est **qu'une suggestion** : il faut cliquer hunk par hunk pour
   l'appliquer. Même avec une règle apprise, l'utilisateur peut cliquer 245 fois.
3. **Aucune action globale niveau fichier** — il n'existe que les actions par hunk
   (courante / entrante / les deux) et le bouton « Résoudre auto ». Pas de
   « tout accepter theirs/ours » pour un fichier entier — pourtant la bonne unité de décision pour
   un artefact auto-généré comme `manifest.json`.

## Objectif

Fermer la boucle « je ne re-clique jamais » pour les fichiers à résolution uniforme, sans toucher
au moteur de résolution algorithmique ni à la parité Rust↔TS.

## Non-objectifs (YAGNI pour cette passe)

- Effondrer les fichiers détectés comme générés en **une seule** décision (au lieu d'afficher les N
  hunks). Reporté — peut suivre si l'usage le réclame.
- Réglage Settings « auto-appliquer les règles mémorisées sans confirmation » (mode silencieux).
  On reste sur le 1-clic explicite partout.
- Toute modification de `packages/core` (patterns, classifier, resolvers) et donc de la parité.

## Solution — trois changements formant une seule boucle

### A — Actions globales au niveau fichier

Dans l'en-tête de chaque fichier en conflit (là où s'affiche `245 conflits — 241 auto`), trois
actions :

```
Tout accepter :  Courante  ·  Entrante  ·  Les deux
```

- S'applique à **100 % des hunks** du fichier, y compris les hunks `complex` et low-confidence.
  C'est l'intention explicite « je sais ce que je veux pour TOUT ce fichier ».
- Distinct de « Résoudre auto » (qui ne touche que les hunks sûrs).
- **Réversible** : passe par le même chemin d'écriture que les résolutions existantes, donc
  l'annulation/undo en place continue de fonctionner.
- **Garde-fou `Les deux` sur fichier généré** : on garde les 3 actions, mais quand le fichier est
  détecté comme généré (manifest de build, lockfile…), afficher un avertissement inline
  **non bloquant** à côté de « Les deux » : « ⚠ Concaténer peut casser un fichier généré ».

### B — Mémorisation depuis l'action globale

Après une action globale, afficher un bandeau discret :

```
Mémoriser : theirs → manifest.json ?   [Mémoriser]  [Ignorer]
```

- Réutilise la mécanique et le store existants (`useResolutionMemory`, `localStorage` clé
  `gitwand-resolution-memory`), même structure de clé `(fichier, stratégie)`. Aucun nouveau format.
- Mémorisation **sur demande** (pas automatique) — choix validé.

### C — Auto-application en 1 clic

À l'ouverture d'un fichier qui possède une règle mémorisée, rendre le bandeau « Règle mémorisée »
(aujourd'hui purement informatif) **actionnable** :

```
Règle mémorisée : theirs → manifest.json   [Appliquer à 245 hunks]
```

- 1 clic résout tout le fichier selon la règle. **1-clic explicite** (choix validé) — pas de
  résolution silencieuse à l'ouverture, zéro surprise.
- **Validité par hunk** : `theirs` / `ours` / `both` sont toujours applicables ;
  `date-latest` / `number-max` / `custom` peuvent ne pas l'être sur certains hunks. Les hunks non
  applicables sont **sautés gracieusement** et signalés : `242/245 appliqués, 3 à vérifier`.

### Boucle complète

`A (action globale) → B (mémoriser) → prochain merge : C (1 clic applique tout)`.

## Composants touchés (`apps/desktop` uniquement)

| Fichier | Changement |
|---|---|
| `src/components/MergeEditor.vue` | En-tête fichier : 3 boutons globaux (A) ; bandeau auto-apply actionnable (C) ; bandeau mémorisation post-action (B) ; avertissement inline `Les deux` sur fichier généré. |
| `src/composables/useGitWand.ts` | Nouveau `resolveFileBulk(path, choice)` appliquant le choix à **tous** les hunks, en réutilisant la même mécanique multi-hunks que `resolveAll()` (pas de nouvelle voie de parsing des marqueurs). |
| `src/composables/useResolutionMemory.ts` | `applyMemoryToFile(path)` (boucle `applyMemory` sur tous les hunks, saute gracieusement les hunks invalides et retourne un compte `appliqués/total`) ; helper « une règle existe pour ce fichier ». |
| `src/locales/{en,fr,es,pt-BR,zh-CN}.json` | Nouvelles clés UI (via skill `i18n-sync`). Aucune string en dur dans les composants. |

## Contraintes & règles projet à respecter

- **`packages/core` : zéro changement.** Pas de nouveau pattern, pas de modification du classifier
  ni des resolvers → la parité Rust↔TS n'est pas impactée.
- **CSS modal** : la classe `.bm-btn` doit rester à spécificité `(0,1,0)` (jamais préfixée). Si les
  boutons globaux ne sont pas des boutons modaux, utiliser le style des actions inline existantes.
- **i18n** : toute string visible doit exister dans les 5 locales.
- **IPC** : aucune nouvelle commande Tauri attendue (logique purement frontend sur des hunks déjà
  parsés). Si un besoin backend émerge, passer par `src/utils/backend.ts`.
- **Composition API** + logique métier en composables (déjà le cas ici).

## Tests

- **Vrais repos git temporaires** (règle AGENTS.md — aucun mock de la couche git) :
  - Fichier multi-hunks → `resolveFileBulk(path, 'theirs')` résout les N hunks, fichier marqué résolu.
  - Fichier multi-hunks avec hunks `complex` → l'action globale les résout aussi (contrairement à
    « Résoudre auto »).
  - Boucle B→C : action globale → mémoriser → ré-merger le même fichier → le bandeau C apparaît et
    1 clic résout tout.
  - Règle `date-latest` partiellement applicable → compte `appliqués/total` correct, hunks invalides
    laissés en conflit.
- **Pas de bench `packages/core`** nécessaire (hot path du moteur non touché).

## Risques

- **Réversibilité** : vérifier dans le plan que `resolveFileBulk` passe bien par le chemin d'undo
  existant et ne court-circuite pas l'historique de résolution.
- **Ordre d'application multi-hunks** : appliquer plusieurs hunks décale les offsets de lignes —
  réutiliser la mécanique éprouvée de `resolveAll()` plutôt que d'itérer naïvement.
