# Récupération automatique de la base pour les conflits 2-way (sans `|||||||`)

- **Date** : 2026-07-06
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `apps/desktop/src` (frontend uniquement, `useGitWand.ts` + `MergeEditor.vue`).
  **Aucun changement Rust** — réutilise `reconstruct_conflict` tel quel.
- **Branche** : à créer, ou à ajouter à la branche `worktree-token-level-merge` existante.

## Problème

Quand `merge.conflictstyle` n'est pas réglé sur `diff3`/`zdiff3` (comportement par défaut de
git), un conflit s'écrit dans le working tree avec seulement 2 côtés (`<<<<<<< ours` /
`=======` / `>>>>>>> theirs`), **sans section `|||||||`**. `packages/core` classe alors chaque
hunk avec `baseLines: []`, et **tous** les patterns `requires: "diff3"` (`non_overlapping`,
`one_side_change`, `reorder_only`, `insertion_at_boundary`, `token_level_merge` — livré dans la
même session) sont écartés d'office : le hunk tombe systématiquement sur `complex`, peu importe
sa simplicité réelle.

**Cas réel confirmé** : `resources/views/gestion/upsells/suggestions/index.blade.php` — deux
lignes modifiées, chacune par un seul côté (cas normalement trivial pour `non_overlapping`),
reste classé `complex` parce que `git config --get merge.conflictstyle` n'est réglé ni en local
ni en global sur ce repo.

## Objectif

Quand un fichier a des marqueurs de conflit mais aucune base, récupérer automatiquement la base
ancêtre commune depuis l'index git (stage 1) et enrichir silencieusement le contenu utilisé pour
la résolution — sans jamais modifier le fichier sur disque ni exiger d'action de l'utilisateur.

## Non-objectifs (YAGNI)

- Pas de suggestion « activez `merge.conflictstyle=diff3` » dans ce chantier — la récupération
  automatique couvre déjà tous les conflits existants et futurs sans rien demander à
  l'utilisateur ; la suggestion de config git devient un nice-to-have marginal, à traiter
  séparément si un jour ça semble utile.
- Pas de nouvelle commande Rust — `reconstruct_conflict` (livré juin 2026, voir
  `docs/superpowers/specs/2026-06-18-conflits-contenu-sans-marqueurs-design.md`) est réutilisé
  tel quel.
- Pas de modification du fichier sur disque — l'enrichissement n'affecte que le contenu passé au
  moteur de résolution en mémoire, jamais le working tree réel.
- Pas de confirmation utilisateur avant enrichissement — l'ours/theirs affiché reste strictement
  identique à avant (seule la base est ajoutée en interne), donc pas d'ambiguïté à valider.

## Décision clé — détection, garde-fou, silence

1. **Détection** : après le premier `resolveAsync(content, ...)`, si **au moins un hunk a
   `baseLines.length === 0`** — signal déjà disponible sans re-parser le texte brut.
2. **Récupération** : appeler `reconstructConflict(cwd, filePath)` (même commande Rust, même
   wrapper `backend.ts`, réutilisé sans modification).
3. **Garde-fou** : relancer `resolveAsync(rec.content, ...)` → `enrichedResult`. Comparer,
   hunk par hunk, `enrichedResult.hunks[i].oursLines`/`theirsLines` avec
   `result.hunks[i].oursLines`/`theirsLines` (résultat original, sans base). Si un seul hunk
   diverge (édition manuelle post-conflit, désynchronisation de l'index) → abandonner
   l'enrichissement, garder `content`/`result` d'origine tels quels.
4. **Application silencieuse** : si tout correspond → utiliser `rec.content` comme `content` et
   `enrichedResult` comme `result`, avec un nouveau flag `ConflictFile.baseEnriched: true`.

## Architecture & flux

### Backend — aucun changement

`reconstruct_conflict_impl` (`apps/desktop/src-tauri/src/commands/ops.rs:3065`) lit déjà les
stages 1/2/3 via `git show :N:<path>` et appelle `git merge-file -p --diff3`, indépendamment de
ce que contiennent les marqueurs du working tree — le composant ne fait aucune hypothèse sur
l'absence totale de marqueurs, il regarde uniquement l'index. Réutilisé tel quel, y compris le
wrapper `backend.ts::reconstructConflict()` et le type `ReconstructedConflict { content,
wtMatchesSide }`.

### Frontend (`apps/desktop/src/composables/useGitWand.ts`)

Nouveau bloc inséré à côté du flux "markerless → reconstruct" existant (ligne ~450-469), après
le calcul de `result` normal (fichier avec marqueurs, `totalConflicts > 0`) :

```typescript
const content = await readFile(cwd, filePath);
const result = await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts);

// Marqueurs présents mais sans base (merge.conflictstyle par défaut, pas diff3/zdiff3) →
// tenter de récupérer la base depuis l'index et réévaluer avec.
if (result.stats.totalConflicts > 0 && result.hunks.some((h) => h.baseLines.length === 0)) {
  try {
    const rec = await reconstructConflict(cwd, filePath);
    const enrichedResult = await resolveAsync(rec.content, filePath, resolveOptionsWithLlm, structuralOpts);
    const sameOursTheirs =
      enrichedResult.hunks.length === result.hunks.length &&
      enrichedResult.hunks.every((h, i) =>
        h.oursLines.join("\n") === result.hunks[i].oursLines.join("\n") &&
        h.theirsLines.join("\n") === result.hunks[i].theirsLines.join("\n"),
      );
    if (sameOursTheirs) {
      return { path: filePath, content: rec.content, result: enrichedResult, baseEnriched: true };
    }
    // Divergence (édition manuelle post-conflit) → abandon silencieux, comportement inchangé.
  } catch { /* pas de stage récupérable (ex: add/add) → fall through */ }
}
return { path: filePath, content, result };
```

Ce bloc s'insère **après** le bloc existant "markerless" (qui gère `totalConflicts === 0`) et
**avant** le `return` final — les deux flux sont mutuellement exclusifs (l'un traite l'absence
totale de marqueurs, l'autre leur présence sans base).

### Type `ConflictFile` (`useGitWand.ts`)

Ajouter `baseEnriched?: boolean` à côté du champ `reconstructed?: boolean` existant.

### UI (`apps/desktop/src/components/MergeEditor.vue`)

Bandeau discret quand `file.baseEnriched === true`, sur le même modèle visuel que le bandeau
`reconstructed` existant (juin 2026) — texte : « Base ancêtre récupérée depuis l'index git ».
Pas de bouton, pas de confirmation.

### i18n

Nouvelle clé (5 locales) pour le texte du bandeau, dans le même groupe que les clés
`reconstructed` existantes.

## Gestion des erreurs

- `reconstructConflict` échoue (pas de stage 1 récupérable, ex. add/add) → `catch` silencieux,
  comportement inchangé (le fichier reste `complex` si c'était déjà le cas).
- Le garde-fou de comparaison ours/theirs échoue → abandon silencieux, pas de log d'erreur bruyant
  (cas attendu et non exceptionnel — édition manuelle légitime).
- Aucune écriture sur disque à aucun moment de ce flux.

## Tests

- **`useGitWand.test.ts`** (vrais repos temporaires, jamais de mock git — règle du projet) :
  - Repo avec `merge.conflictstyle` par défaut (2-way), conflit à un seul côté modifié par
    ligne → après enrichissement, classifié `one_side_change` (ou `non_overlapping` /
    `token_level_merge` selon le cas construit) au lieu de `complex`. Vérifier
    `file.baseEnriched === true`.
  - Le working tree a été édité manuellement après le conflit (contenu ours/theirs modifié,
    divergent des stages) → enrichissement abandonné, `file.baseEnriched` absent, comportement
    identique à avant ce chantier.
  - Cas add/add (pas de stage 1) → pas de crash, `reconstructConflict` échoue proprement,
    fallback sur le résultat non enrichi.
  - Régression : le flux "markerless" existant (juin 2026) n'est pas affecté — même
    fixture/test, même comportement observé.
- **`MergeEditor.test.ts`** : le bandeau `baseEnriched` s'affiche quand `file.baseEnriched ===
  true`, ne s'affiche pas sinon.

## Contraintes & règles projet

- Aucun changement `packages/core` ni Rust.
- IPC : `reconstructConflict` déjà wrappé dans `backend.ts`, aucun nouvel appel `invoke()` direct.
- i18n : nouvelle clé dans les 5 locales.
- Tests : vrais repos temporaires (pas de mock git), cohérent avec `AGENTS.md`.

## Risques

- **Faux positif du garde-fou par fin de ligne** : une comparaison stricte de chaîne pourrait
  échouer à tort si CRLF/LF diffère entre le blob d'index et le fichier disque — comportement
  conservateur accepté (le gain est perdu pour ce fichier, mais aucune corruption possible).
- **Coût** : un appel Rust supplémentaire (`git show` ×3 + `git merge-file`) par fichier
  concerné, uniquement quand un hunk sans base est détecté — aucun coût sur le chemin heureux
  (conflits diff3/zdiff3 déjà complets).
