# Canonicaliser la clé de `repo_lock` + limiter la concurrence de reconstruction

- **Date** : 2026-07-06
- **Auteur** : Laurent Guitton (design assisté)
- **Statut** : Design validé — prêt pour le plan d'implémentation
- **Périmètre** : `apps/desktop/src-tauri/src/git/repo_lock.rs` (Rust) +
  `apps/desktop/src/utils/` et `apps/desktop/src/composables/useGitWand.ts` (TypeScript).
- **Branche** : à créer, ou directement sur `main` (comme le reste de la session, avec
  consentement explicite de l'utilisateur pour continuer sur `main`).

## Problème

Un incident réel s'est produit sur le repo de production « Dendreo » : `.git/index` a été
tronqué à 0 octet pendant une session active de résolution de conflits dans GitWand, en plein
merge (`master → feat/tailwind-v4`). Réparé manuellement (`git read-tree HEAD`) par une session
Claude Code distincte, sans perte de contenu de fichiers, mais avec perte des stages de conflit
en cours (13 fichiers restaient avec des marqueurs texte non résolus).

**Deux investigations menées cette session** :

1. Aucune écriture directe de `.git/index` côté Rust GitWand (ni via libgit2, ni en bytes bruts)
   — tout le staging passe par le CLI `git` (`git add`, `git apply --cached`), chaque appel
   protégé par un `repo_lock::write(&cwd)`.
2. **Faille trouvée** : `repo_lock::lock_for(cwd)` (`apps/desktop/src-tauri/src/git/repo_lock.rs:68-75`)
   indexe son registre de verrous par la **chaîne `cwd` littérale**, sans canonicalisation. Deux
   représentations différentes du même repo physique (lien symbolique, chemin avec/sans slash
   final, chemin relatif résolu différemment) obtiennent des `Arc<RwLock<()>>` **distincts** —
   la garantie de sérialisation des écritures sur un même `.git/index` ne tient plus dans ce cas.

**Constat secondaire, non causal mais amenant une bonne pratique** : la fonctionnalité de
récupération automatique de base (livrée dans cette même session) a introduit jusqu'à 4
sous-processus git supplémentaires (`git show` ×3 + `git merge-file`) **par fichier concerné**,
tous lancés en parallèle via `Promise.all` dans `loadRealFiles()` — en lecture pure, donc ce
n'est **pas** le mécanisme de la corruption observée, mais une charge de sous-processus plus
élevée qu'avant reste une surface de risque à réduire par prudence.

## Objectif

1. Fermer la vraie faille de sérialisation trouvée (canonicalisation du chemin dans `repo_lock`).
2. Réduire, par prudence, la charge de sous-processus git concurrents introduite par la
   récupération automatique de base.

## Non-objectifs (YAGNI)

- Pas de changement à l'architecture de `repo_lock` au-delà de la clé de map (le mécanisme
  `RwLock` par repo, lecture partagée / écriture exclusive, reste inchangé).
- Pas de migration des commandes d'écriture git vers `spawn_blocking` (constat secondaire fait
  lors de l'investigation — problème de réactivité, pas de corruption ; hors périmètre de ce
  correctif, à traiter séparément si besoin).
- Pas de changement au mécanisme `reconstruct_conflict` lui-même (Rust) — il reste en lecture
  pure, aucune modification requise là.

## Décision clé

1. **`lock_for()` canonicalise `cwd` via `std::fs::canonicalize()`** avant de l'utiliser comme
   clé de map, avec repli sur la chaîne brute si la canonicalisation échoue (chemin supprimé
   entre l'appel frontend et l'exécution, montage réseau indisponible, etc.) — pour ne jamais
   régresser par rapport au comportement actuel dans ce cas rare.
2. **Un sémaphore partagé (`createSemaphore(4)`)** englobe les deux points d'appel à
   `reconstructConflict` dans `useGitWand.ts` (bloc « markerless » existant depuis juin 2026, et
   le nouveau bloc « récupération de base »), limitant à 4 le nombre de reconstructions git
   concurrentes, tous fichiers confondus.
3. `concurrentMap` (utilitaire déjà existant en local dans `useLaunchpadTeam.ts`) est extrait
   dans un nouveau module partagé `apps/desktop/src/utils/concurrentMap.ts`, qui héberge aussi
   le nouveau `createSemaphore`.

## Architecture & flux

### Rust — `repo_lock.rs`

```rust
fn lock_for(cwd: &str) -> Arc<RwLock<()>> {
    let key = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string());
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard.entry(key).or_insert_with(|| Arc::new(RwLock::new(()))).clone()
}
```

Signature de `read()`/`write()` inchangée — elles continuent de prendre `&str`, seule la
résolution interne de la clé change. Aucun appelant à modifier.

### TypeScript — `apps/desktop/src/utils/concurrentMap.ts` (nouveau)

- `concurrentMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]>` —
  déplacé tel quel depuis `useLaunchpadTeam.ts`.
- `createSemaphore(limit: number): { run<T>(fn: () => Promise<T>): Promise<T> }` — nouveau,
  primitif complémentaire pour throttler des points d'appel dispersés (pas une liste connue à
  l'avance), même mécanique interne (`Set` d'exécutants + `Promise.race`).

### `useLaunchpadTeam.ts`

Supprime sa définition locale de `concurrentMap`, importe depuis le nouveau module.

### `useGitWand.ts`

```typescript
import { createSemaphore } from "../utils/concurrentMap";

const reconstructLimiter = createSemaphore(4);
```

Les deux appels existants `const rec = await reconstructConflict(cwd, filePath);` deviennent
`const rec = await reconstructLimiter.run(() => reconstructConflict(cwd, filePath));` — dans le
bloc « markerless » et dans le bloc « récupération de base ».

## Tests

- **Rust** (`repo_lock.rs`, module de tests existant) : nouveau cas — créer un répertoire
  temporaire réel + un lien symbolique pointant vers lui (vrai filesystem, pas de mock, conforme
  à la règle du projet), vérifier que `lock_for(path_reel)` et `lock_for(path_symlink)`
  retournent le **même** `Arc` (`Arc::ptr_eq`). Vérifier aussi qu'un chemin inexistant retombe
  proprement sur la chaîne brute (pas de panic).
- **TypeScript** (`concurrentMap.test.ts`, nouveau fichier) : `createSemaphore(2).run(...)` sur 5
  promesses contrôlées (résolues manuellement) — vérifier qu'au plus 2 s'exécutent simultanément
  à tout instant.
- Régression : la suite existante `useLaunchpadTeam` doit continuer à passer après le changement
  d'import de `concurrentMap`.

## Risques

- **`std::fs::canonicalize()` a un coût I/O** (résolution du chemin réel sur disque) — appelé une
  fois par commande d'écriture/lecture protégée, pas sur un hot path de polling à haute
  fréquence ; impact négligeable comparé au coût du sous-processus git qui suit.
- **Repli silencieux si canonicalize échoue** : comportement identique à avant ce correctif dans
  ce cas — pas de régression, mais pas de garantie renforcée non plus pour ce cas limite précis
  (accepté, cas rare).
