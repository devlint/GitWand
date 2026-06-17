# Résolution des conflits d'arborescence (modify/delete, both-deleted, add/add)

- **Date** : 2026-06-17
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `apps/desktop` (backend Rust + frontend Vue). Aucun changement de `packages/core`.

## Problème

Quand un fichier est modifié d'un côté et supprimé de l'autre (et plus généralement
pour tout conflit d'arborescence), git laisse un chemin *unmerged* SANS marqueurs
`<<<<<<<` dans le working tree. GitWand charge les fichiers en conflit en lisant leur
contenu et en parsant les marqueurs ; sans marqueur, `resolve()` renvoie
`totalConflicts: 0`. Résultat : le fichier s'affiche comme « 0 conflit » / résolu — l'utilisateur
ne voit pas qu'il a été supprimé d'un côté et ne dispose d'aucune action pour choisir
« garder » ou « accepter la suppression ». Le merge reste bloqué.

Cas « sans marqueurs » concernés (codes git short-status) :
- `UD` — modifié côté courant (ours), supprimé côté entrant (theirs)
- `DU` — supprimé côté courant, modifié côté entrant
- `DD` — supprimé des deux côtés
- `AA` / `AU` / `UA` — add/add et variantes (les deux côtés ont ajouté, ou un seul)

Note : `git diff --name-only --diff-filter=U` (commande actuelle `get_conflicted_files`,
`ops.rs:2454`) liste bien ces chemins (ils sont unmerged), mais pour `DD` le fichier est
absent du working tree → la lecture de contenu échoue. Les codes de conflit sont déjà
connus côté Rust (`ops.rs:1828`).

## Objectif

Détecter les conflits d'arborescence, les présenter clairement (badge dans la liste +
panneau dédié), et offrir une résolution en un clic — sans toucher au moteur de
résolution de contenu ni à la parité Rust↔TS.

## Non-objectifs (YAGNI)

- Aucun changement du flux des conflits de contenu (avec marqueurs) — il reste identique.
- Pas de mémorisation de règle pour les conflits d'arborescence (la mémoire est par contenu ;
  hors périmètre).
- Pas de gestion des renommages complexes au-delà de ce que le modèle stage-driven couvre
  naturellement (rename/delete apparaît comme add/delete via les stages).
- Aucun changement `packages/core`.

## Modèle — piloté par les stages d'index

Tout chemin unmerged possède jusqu'à 3 stages : base (1), ours (2), theirs (3). La
classification ET les actions disponibles découlent de la présence de ours/theirs :

| Cas | ours (st2) | theirs (st3) | Actions proposées |
|---|---|---|---|
| `UD` modifié ours / supprimé theirs | ✓ | ✗ | Garder la version courante · Accepter la suppression |
| `DU` supprimé ours / modifié theirs | ✗ | ✓ | Garder la version entrante · Accepter la suppression |
| `DD` supprimé des deux côtés | ✗ | ✗ | Accepter la suppression |
| `AA`/`AU`/`UA` les deux présents | ✓ | ✓ | Garder courante · Garder entrante · Accepter la suppression |

Règle d'affichage : « Garder la version courante » visible ssi `hasOurs` ; « Garder la
version entrante » visible ssi `hasTheirs` ; « Accepter la suppression » toujours visible.

## Composants & flux de données

### Backend Rust (`apps/desktop/src-tauri/`)

1. **`get_tree_conflicts(cwd) -> Vec<TreeConflict>`** — parse `git status --porcelain=v2`,
   lignes `u ` (unmerged). Pour chaque ligne, les trois champs de mode octal (stages 1/2/3)
   valent `000000` si le stage est absent → en déduit `hasBase` / `hasOurs` / `hasTheirs`.
   Retourne `TreeConflict { path: String, code: String, has_base: bool, has_ours: bool, has_theirs: bool }`.
   `code` = code short-status dérivé (UD/DU/DD/AA/AU/UA) pour l'affichage.
2. **`resolve_tree_conflict(cwd, path, choice)`** — `choice ∈ {"ours","theirs","delete"}` :
   - `ours` : `git checkout --ours -- <path>` puis `git add -- <path>`
   - `theirs` : `git checkout --theirs -- <path>` puis `git add -- <path>`
   - `delete` : `git rm -f -- <path>`
   Tous les arguments passés en **tableau** (jamais d'interpolation shell), chemin validé via
   **`safe_repo_path()`**. Chaque étape git vérifiée ; en cas d'échec, renvoie un message
   d'erreur explicite.
3. Les deux commandes sont enregistrées dans l'`invoke_handler` de `lib.rs`.

### IPC (`apps/desktop/src/utils/backend.ts`)

Wrappers typés `getTreeConflicts(cwd)` et `resolveTreeConflict(cwd, path, choice)` + le type
`TreeConflict`, ajoutés dans la même PR (règle IPC). Aucun `invoke()` direct ailleurs.

### Frontend (`apps/desktop/src/composables/useGitWand.ts`)

- `ConflictFile` gagne un champ optionnel `tree?: TreeConflictInfo`
  (`{ code, hasOurs, hasTheirs, hasBase }`).
- `loadRealFiles` : appelle `getTreeConflicts(cwd)`. Pour chaque chemin marqué tree-conflict,
  construit un `ConflictFile` avec `tree` renseigné, **sans** parser les marqueurs ; lit le
  contenu du working tree en best-effort (pour l'aperçu), en tolérant son absence (pas
  d'aperçu si absent, ne jette jamais). Les chemins restants suivent le flux de contenu existant.
- Nouvelle fonction `resolveTreeConflictFile(path, choice)` : appelle `resolveTreeConflict`,
  retire le fichier de `files.value`, puis poursuit/avance le merge en réutilisant la logique
  d'avance existante (équivalent `checkAndSaveIfResolved` : si plus aucun fichier en conflit,
  `git merge --continue`).

### Composants Vue

- **`FileList.vue`** : si `file.tree` est défini, afficher une icône/badge distincte
  (état « arborescence/supprimé ») au lieu de l'état « 0 conflit / résolu ».
- **`MergeEditor.vue`** : si `file.tree` est défini, rendre un **panneau dédié** à la place de
  la vue diff/hunks : une explication contextualisée (« Modifié côté courant, supprimé côté
  entrant », etc. selon `code`), les boutons d'action applicables (selon `hasOurs`/`hasTheirs`),
  et un **aperçu en lecture seule** du contenu qui survivrait (le contenu working-tree lu
  best-effort ; masqué si absent). Émet un événement vers `App.vue` qui appelle
  `resolveTreeConflictFile`.

### i18n

Nouvelles clés (5 locales) : libellés des actions (garder courante / entrante / accepter la
suppression), titres/explications par cas, libellé du badge sidebar, et libellé d'aperçu.

## Gestion des erreurs

- `resolve_tree_conflict` vérifie le `status` de chaque commande git et retourne un message
  d'erreur clair ; le frontend l'affiche via le `error` ref existant.
- Lecture du contenu pour l'aperçu : best-effort, l'absence n'est pas une erreur (cas `DD`).
- `delete` utilise `git rm -f` pour gérer le cas « modifié d'un côté mais on veut supprimer »
  (le working tree diffère de l'index).

## Tests

- **Rust (vrais repos temporaires, pas de mock — AGENTS.md)** : construire chaque cas via de
  vrais merges (modify/delete dans les deux sens, both-deleted), puis :
  - `get_tree_conflicts` renvoie les bons `has_ours`/`has_theirs`/`code` par cas.
  - `resolve_tree_conflict` avec `ours` / `theirs` / `delete` laisse l'index dans l'état
    résolu attendu (fichier stagé avec la bonne version, ou supprimé), et le path n'est plus
    unmerged.
- **Frontend** : la classification (flags de stage → actions affichées) est pure et testée
  unitairement ; vérifier que `loadRealFiles` tolère un fichier tree-conflict absent du
  working tree sans jeter.
- Pas de bench `packages/core` (moteur non touché).

## Contraintes & règles projet

- **Sécurité** : jamais d'interpolation shell dans les commandes git (tableaux d'args) ;
  toujours `safe_repo_path()` pour les chemins fournis par l'utilisateur ; ne pas logger de secret.
- **IPC** : toute nouvelle commande Rust a son wrapper dans `backend.ts` dans la même PR ;
  aucun `invoke()` hors `backend.ts`.
- **Binaires Tauri** : sans objet (pas de nouveau binaire).
- **Composition API** `<script setup>` ; logique métier en composable.
- **i18n** : toute string visible dans les 5 locales.
- **Versions** : ne pas éditer les fichiers de version à la main.
- **`packages/core`** : zéro changement → parité Rust↔TS intacte.

## Risques

- **`git checkout --ours/--theirs`** échoue si le stage correspondant est absent : ne proposer
  l'action que lorsque le stage existe (`hasOurs`/`hasTheirs`) — garde-fou côté UI ET
  re-vérification côté Rust.
- **Parsing porcelain v2** : bien gérer les lignes `u` (9 champs avant le chemin) et les
  chemins avec espaces (le chemin est le dernier champ, jusqu'à la fin de ligne).
- **Avance du merge** : après résolution d'un tree-conflict, recharger ou retirer proprement
  le fichier et ne déclencher `git merge --continue` que lorsque plus aucun conflit (contenu
  OU arborescence) ne subsiste.
