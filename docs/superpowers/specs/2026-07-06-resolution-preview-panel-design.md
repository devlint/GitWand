# Panneau de prévisualisation généralisé pour toute résolution auto-calculée

- **Date** : 2026-07-06
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `apps/desktop/src` (frontend uniquement). Aucun changement `packages/core` ni Rust.
- **Branche** : à créer, ou à ajouter sur `main` directement (les deux chantiers précédents de
  la session y sont déjà fusionnés).

## Problème

Deux mécanismes distincts existent aujourd'hui pour « appliquer une résolution », avec des
résultats potentiellement **différents** pour le même hunk :

1. **Bouton global « Résoudre auto »** (`MergeEditor.vue:677-687`, émet `resolve(file.path)`) —
   applique `result.resolutions[i].resolvedLines`, calculé par `packages/core` (ex. la vraie
   fusion LCS 3-way pour `non_overlapping`).
2. **Bouton par-hunk « Accepter les deux »** (`resolveHunkManual()`,
   `useGitWand.ts:720-789`, branche `choice === "both"`) — fait
   `newLines.push(...oursLines, ...theirsLines)`, une **concatenation brute** qui ignore
   totalement le résultat déjà calculé par le moteur.

Le badge RECOMMANDÉ (`isRecommended()`, `MergeEditor.vue`) pousse visuellement l'utilisateur vers
« Accepter les deux » pour un hunk `non_overlapping`, sans préciser que ce clic ne produit **pas**
le même résultat que « Résoudre auto » aurait produit sur ce même hunk. Aucun des deux chemins
n'affiche d'aperçu avant application — l'utilisateur clique à l'aveugle.

**Constat direct de l'utilisateur** (test réel sur Dendreo, suite au chantier
`token_level_merge`/récupération de base) : un hunk `non_overlapping` nouvellement débloqué
affiche « RECOMMANDÉ » sur « Accepter les deux » sans montrer ce que ça va produire, et le clic
n'aurait de toute façon pas fait la vraie fusion.

## Objectif

Pour tout hunk où `packages/core` a déjà calculé une résolution (`result.resolutions[i].autoResolved
=== true`), afficher le contenu fusionné exact avant validation, et faire en sorte que le clic
« Accepter » applique **ce même contenu** — jamais une reconstruction ad hoc côté frontend.

## Non-objectifs (YAGNI)

- Pas de changement pour les hunks `complex` : la barre d'actions actuelle (Accepter courante /
  entrante / les deux / Éditer) reste inchangée — il n'y a pas de meilleure résolution
  pré-calculée à prévisualiser, et « Accepter les deux » (concatenation brute) reste un choix de
  secours légitime quand aucune fusion intelligente n'est possible.
- Pas de suppression de `resolveHunkManual()` — elle reste utilisée pour les hunks `complex`
  (choix ours/theirs/both/both-theirs-first bruts), simplement plus jamais appelée pour un hunk
  `autoResolved === true` une fois ce chantier en place.
- Pas de changement à `packages/core` — `resolvedLines` existe déjà pour tous les types
  auto-résolvables via `assembleResolution()`.

## Décision clé — un panneau générique, remplaçant conditionnel

1. **Nouveau composant `ResolutionPreviewPanel.vue`**, sur le modèle exact de
   `TokenMergePanel.vue` (déjà livré cette session) : props `{ resolvedLines: string[], hunkId:
   number, explanation: string, accepted?: boolean }`, emits `{ accept: [hunkId], reject:
   [hunkId] }`.
2. **Remplace la barre d'actions actuelle** (`Accepter courante/entrante/les deux/Éditer`)
   **uniquement** quand `result.resolutions[i].autoResolved === true` ET
   `hunk.type !== "llm_proposed" && hunk.type !== "token_level_merge"` (ces deux derniers ont déjà
   leur panneau dédié). Couvre : `same_change`, `one_side_change`, `non_overlapping`,
   `whitespace_only`, `reorder_only`, `insertion_at_boundary`, `value_only_change`,
   `generated_file`, `refactoring_aware_merge`.
3. **Accepter** → émet `resolveHunkCustom(path, hunkIndex, resolvedLines.join("\n"))` — **même
   chemin** que `TokenMergePanel`/l'édition manuelle. Corrige mécaniquement le bug « les deux » :
   on applique enfin le `resolvedLines` du moteur, jamais une reconstruction frontend.
4. **Rejeter** → bascule vers la vue manuelle 3 colonnes classique (avec ses boutons Accepter
   courante/entrante/les deux/Éditer/IA/Expliquer), exactement comme le rejet fonctionne déjà pour
   `llm_proposed`/`token_level_merge`. C'est la porte de sortie si l'utilisateur n'est pas
   d'accord avec la résolution proposée — pas de bouton « Éditer » séparé dans le nouveau panneau,
   le rejet donne accès à l'édition manuelle déjà existante.
5. **Bouton global « Résoudre auto »** : au clic, affiche une modale récapitulative listant les N
   hunks concernés avec leur `resolvedLines` respectif, puis, après confirmation, valide tous les
   panneaux individuels en une fois (équivalent à cliquer « Accepter » sur chacun).

## Architecture & flux

### Nouveau composant (`apps/desktop/src/components/ResolutionPreviewPanel.vue`)

Calqué sur `TokenMergePanel.vue` — `<script setup>`, props/emits ci-dessus, template avec
`<pre>{{ resolvedLines.join('\n') }}</pre>` + explication + boutons Accepter/Rejeter. Nouvelles
classes CSS dédiées `.resolution-preview-panel*` (mêmes règles visuelles que
`.token-merge-panel*`, dupliquées plutôt que partagées — chaque composant reste autonome, pas de
mixin/classe utilitaire partagée à introduire pour deux consommateurs seulement).

### `MergeEditor.vue`

- Nouvelle fonction `showResolutionPreviewFor(hunkIndex, hunk): boolean` : retourne `true` si
  `file.result.resolutions[hunkIndex]?.autoResolved === true`, le type n'est ni `llm_proposed` ni
  `token_level_merge`, et le hunk n'a pas été rejeté (même mécanique de `Set` que
  `rejectedLlmHunks`/`rejectedTokenMergeHunks` — nouveau `rejectedPreviewHunks`).
- Le rendu conditionnel actuel de la barre d'actions (`v-if="hunkForSegment(seg) &&
  editingHunkIndex !== seg.hunkIndex"`, ligne ~832) devient `v-if="... && !showResolutionPreviewFor(...)"`
  — la barre ne s'affiche que quand le panneau ne s'affiche pas.
- `onPreviewAccept(hunkIndex)` : lit `file.result.resolutions[hunkIndex].resolvedLines`, émet
  `resolveHunkCustom(file.path, hunkIndex, resolvedLines.join("\n"))`.
- `onPreviewReject(hunkIndex)` : ajoute à `rejectedPreviewHunks`, bascule vers la barre
  d'actions classique pour ce hunk.

### Bouton global « Résoudre auto »

- Nouvelle modale `ResolveAutoSummaryModal.vue` (ou réutilisation de `BaseModal.vue` avec un
  contenu dédié) : liste chaque hunk auto-résolu du fichier avec son `resolvedLines` en aperçu
  compact.
- Au clic sur « Résoudre auto », ouvrir la modale au lieu d'émettre directement `resolve(file.path)`.
  Confirmation dans la modale → émettre `resolve(file.path)` comme avant (comportement
  d'application inchangé côté composable, seul le déclenchement passe par une confirmation
  visuelle).

## Tests

- **`ResolutionPreviewPanel.test.ts`** (mêmes conventions que `TokenMergePanel.test.ts` — montage
  natif `createApp`, pas `@vue/test-utils`) : affiche `resolvedLines`, émet `accept`/`reject`
  avec le bon `hunkId`, bascule accepted→badge.
- **`MergeEditor.test.ts`** — cas de régression clé : pour un hunk `non_overlapping` avec
  `autoResolved: true`, cliquer « Accepter » sur le panneau émet `resolveHunkCustom` avec
  exactement `resolvedLines.join("\n")` — **pas** une concaténation `oursLines + theirsLines`.
  Vérifier aussi qu'un hunk `complex` (`autoResolved: false`) affiche toujours la barre d'actions
  classique, inchangée.
- **Modale récapitulative** : s'ouvre au clic sur « Résoudre auto », liste bien N hunks, la
  confirmation déclenche `resolve(file.path)`.

## Risques

- **`resolveHunkManual()` devient inatteignable pour les types auto-résolus** — vérifier qu'aucun
  autre point d'entrée (ex. raccourci clavier, action de la sidebar) n'appelle encore `choice:
  "both"` sur un hunk auto-résolu en contournant le nouveau panneau.
- **Cohérence de `hunkIndex`** entre `file.result.hunks[i]` et `file.result.resolutions[i]` — les
  deux tableaux doivent rester alignés par index (déjà une invariant existant, pas une nouvelle
  contrainte, mais à vérifier explicitement dans les tests).
