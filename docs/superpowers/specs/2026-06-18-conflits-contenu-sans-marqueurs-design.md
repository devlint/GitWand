# Résolution des conflits de contenu sans marqueurs (reconstruction depuis l'index)

- **Date** : 2026-06-18
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `apps/desktop` (backend Rust + frontend Vue). Aucun changement de `packages/core`.
- **Branche** : `feat/resolution-globale-fichier` (même PR #53).

## Problème

Un fichier en conflit de contenu (`UU` — modifié des deux côtés, les 3 stages d'index présents)
peut se retrouver **sans marqueurs `<<<<<<<` dans le working tree** (ex. après un `git checkout`
/ `restore` du chemin, une stratégie `-X ours/theirs`, rerere, ou un outil tiers). GitWand détecte
et parse les conflits **uniquement** à partir des marqueurs du working tree : sans marqueur,
`resolve()` renvoie `totalConflicts: 0` → le fichier s'affiche **« 0 conflit »** alors que git le
considère toujours non mergé. L'utilisateur ne peut pas le résoudre depuis GitWand.

PhpStorm, lui, lit directement les blobs des stages 2/3 et fait son propre 3-way — d'où l'affichage
correct du conflit. **Cause racine confirmée** (diagnostic sur le repo Dendreo) :

```
u UU N... 100644 100644 100644 100644  <base 2b274…> <ours 8b24e…> <theirs 78529…>  topbar-border.blade.php
```

stages 1/2/3 présents, blobs distincts, working tree sans marqueurs, rerere off, pas de merge driver.

## Objectif

Rendre GitWand **stage-authoritative** pour ce cas : reconstruire le conflit 3-way depuis l'index
et le faire passer par le pipeline de résolution existant (hunks, accept ours/theirs/both, « Tout
accepter », mémoire) — sans toucher au moteur `packages/core` ni au flux des conflits qui ONT des
marqueurs (cas commun, inchangé).

## Non-objectifs (YAGNI)

- Aucun changement du flux des conflits de contenu **avec** marqueurs (inchangé).
- Pas de bascule générale « toujours lire depuis l'index » : on ne reconstruit que lorsque le
  working tree n'a pas de marqueurs pour un chemin non mergé.
- Pas de gestion des conflits d'arborescence ici (déjà livrés : modify/delete, both-deleted).
- Aucun changement `packages/core`.

## Décision clé — working tree vs reconstruction

Le contenu working-tree d'un `UU` sans marqueurs peut être :
- **un côté** (== stage 2 *ours* ou stage 3 *theirs*) — résultat d'un checkout d'un côté → on peut
  reconstruire le 3-way silencieusement.
- **autre chose** (≠ tous les stages) — probable **résolution manuelle non stagée** → ne pas
  écraser ; proposer un choix explicite.

## Architecture & flux

Détection (sans coût supplémentaire notable) : un chemin issu de `getConflictedFiles` qui n'est
**pas** un conflit d'arborescence (cf. `getTreeConflicts`) et dont `resolveAsync(contenu working
tree)` donne `totalConflicts === 0` est, par élimination, un conflit de contenu sans marqueurs →
reconstruire.

### Backend Rust (`apps/desktop/src-tauri/`)

Nouvelle commande :

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct ReconstructedConflict { pub content: String, pub wt_matches_side: bool }

#[tauri::command]
pub(crate) async fn reconstruct_conflict(cwd: String, path: String) -> Result<ReconstructedConflict, String>
```

- Lit les blobs des stages via `git show :1:<path>` / `:2:<path>` / `:3:<path>` (base/ours/theirs).
  Stage 1 (base) peut être absent (add/add) → fichier base vide.
- Produit le contenu avec marqueurs via `git merge-file -p --diff3 <ours> <base> <theirs>` (fichiers
  temporaires des blobs), labels `ours` / `base` / `theirs`. (Sortie identique à un conflit git
  normal, donc parsable par le moteur existant.)
- `wt_matches_side` = le contenu working-tree actuel est byte-identique au blob stage 2 **ou** stage 3.
- Sécurité : arguments en **tableaux** (pas d'interpolation shell) ; `safe_repo_path()` pour valider
  le chemin ; fichiers temporaires écrits dans un répertoire temp dédié et nettoyés.
- Enregistrée dans `lib.rs` ; wrapper typé dans `backend.ts` (même PR).

### Frontend (`useGitWand.ts` / `loadRealFiles`)

Pour chaque chemin en conflit **non-tree** dont le `result.stats.totalConflicts === 0` :
appeler `reconstructConflict(cwd, path)` :
- **`wtMatchesSide === true`** → remplacer `content` par le contenu reconstruit (avec marqueurs),
  ré-exécuter `resolveAsync` → le fichier a de vrais hunks et suit le flux normal. Marquer
  `ConflictFile.reconstructed = true` pour afficher un bandeau d'information.
- **`wtMatchesSide === false`** → ne pas écraser : poser `ConflictFile.markerless = { reconstructed }`
  (le contenu working-tree reste affiché) pour déclencher le panneau de choix.

Nouvelle fonction composable `reconstructAndResolve(path)` (bascule un fichier `markerless` vers le
contenu reconstruit + ré-résolution) et réutilisation de l'existant pour « stager tel quel ».

### Composants Vue

- **`MergeEditor.vue`** :
  - Cas `reconstructed === true` : flux hunks normal **+** un bandeau discret « Conflit reconstruit
    depuis l'index — le fichier n'avait pas de marqueurs ».
  - Cas `markerless` (édition manuelle possible) : panneau de choix (style du panneau tree) :
    **« Reconstruire le conflit »** (→ `reconstructAndResolve`) vs **« Garder ma version (stager
    tel quel) »** (→ stage + avance via le flux existant).
- **`App.vue`** : câbler les deux actions via le helper partagé `advanceToNextConflictOrFinalize`.
- **`FileList.vue`** : une fois reconstruits, ces fichiers affichent un compte de hunks normal
  (aucun traitement spécial requis ; le cas `markerless` peut réutiliser un badge « conflit »).

### i18n

Nouvelles clés (5 locales) : bandeau « reconstruit depuis l'index », boutons « Reconstruire le
conflit » / « Garder ma version », titre/explication du panneau de choix.

## Gestion des erreurs

- `git merge-file` qui produit un contenu **sans** marqueurs (stages se mergent proprement) → traiter
  comme résolvable : proposer le staging plutôt qu'un faux conflit.
- Stage manquant inattendu → erreur explicite via le `error` ref existant (ne devrait pas arriver,
  les conflits d'arborescence sont filtrés en amont).
- Fichiers temporaires des blobs toujours nettoyés (même en cas d'erreur).

## Tests

- **Rust (vrais repos temporaires, pas de mock)** :
  - `UU` puis `git checkout --ours -- f` (marqueurs effacés, WT == ours) → `reconstruct_conflict`
    renvoie un contenu **avec** marqueurs, `wt_matches_side === true`.
  - `UU` puis écrire un 3e contenu distinct dans le WT → `wt_matches_side === false`.
  - Vérifier que le contenu reconstruit est parsable (contient `<<<<<<<` / `=======` / `>>>>>>>`).
- **Frontend** : un chemin en conflit avec 0 marqueur déclenche la reconstruction ; le cas
  `wtMatchesSide=false` ne remplace pas le contenu working-tree.
- Pas de bench `packages/core` (moteur non touché).

## Contraintes & règles projet

- Sécurité : pas d'interpolation shell (tableaux d'args) ; `safe_repo_path()` pour les chemins
  utilisateur ; pas de log de secret ; nettoyage des fichiers temporaires.
- IPC : wrapper `backend.ts` dans la même PR ; aucun `invoke()` hors `backend.ts`.
- Composition API `<script setup>` ; logique en composable.
- i18n : toute string visible dans les 5 locales.
- Versions : ne pas éditer les fichiers de version à la main.
- `packages/core` : zéro changement → parité Rust↔TS intacte.

## Risques

- **`git merge-file` ordre des arguments** : `git merge-file -p <ours> <base> <theirs>` (le fichier
  du milieu = ancêtre commun). Bien mapper stage 2→ours, stage 1→base, stage 3→theirs ; tester.
- **Base absente (add/add)** : passer un fichier base vide à `merge-file`.
- **Comparaison byte-identique WT vs stage** : comparer les octets bruts (pas de normalisation de
  fins de ligne) pour `wt_matches_side`.
- **Ré-entrance** : après reconstruction silencieuse, le fichier ne doit pas être re-détecté comme
  « markerless » (il a maintenant des marqueurs en mémoire) — la détection se fait une fois au load.
