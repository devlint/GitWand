# Repo Lock Canonicalization + Reconstruct Concurrency Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close a real serialization gap in `repo_lock` (per-repo `RwLock` keyed by a literal,
non-canonicalized `cwd` string — two path representations of the same physical repo bypass
serialization entirely) discovered while investigating a production `.git/index` truncation
incident. Also add a defensive concurrency limit on the base-recovery feature's git subprocess
calls (read-only, not the proven cause, but reduces load as a precaution).

**Architecture:** Two independent, small changes. Rust: canonicalize the `repo_lock` map key.
TypeScript: extract the existing local `concurrentMap` utility into a shared module, add a
complementary `createSemaphore` primitive, and wrap the two `reconstructConflict` call sites in
`useGitWand.ts` with it.

**Tech Stack:** Rust (`std::fs::canonicalize`, existing `cargo test` conventions — real temp
dirs, no mocking), TypeScript (Vitest).

## Global Constraints

- Tests Rust : vrais répertoires temporaires (`std::env::temp_dir()` + PID/nanos, pattern déjà
  utilisé partout dans `commands/ops.rs` — pas de crate `tempfile`, elle n'est pas une
  dépendance du projet).
- `read()`/`write()` de `repo_lock.rs` gardent leur signature `&str` — seule la résolution
  interne de la clé change, aucun appelant à modifier.
- `concurrentMap` garde sa signature exacte (déjà utilisée en production dans
  `useLaunchpadTeam.ts`) — l'extraction ne doit rien changer côté appelant hormis le chemin
  d'import.

---

### Task 1: Canonicaliser la clé de `repo_lock` (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/git/repo_lock.rs:68-75` (`lock_for`)
- Test: `apps/desktop/src-tauri/src/git/repo_lock.rs` (module `#[cfg(test)] mod tests`, déjà
  présent lignes 92-131)

**Interfaces:**
- Consumes: `std::fs::canonicalize` (std, aucune nouvelle dépendance).
- Produces: `lock_for(cwd: &str) -> Arc<RwLock<()>>` — comportement observable inchangé pour un
  `cwd` unique et stable ; deux représentations différentes du même répertoire physique
  résolvent désormais au même verrou.

- [ ] **Step 1: Écrire le test de régression (symlink → même verrou)**

Ajouter dans le module `#[cfg(test)] mod tests` existant de
`apps/desktop/src-tauri/src/git/repo_lock.rs` (après `distinct_repos_do_not_block`) :

```rust
    #[cfg(unix)]
    #[test]
    fn symlink_and_real_path_share_one_lock() {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let real = std::env::temp_dir().join(format!("gitwand-repolock-real-{}-{}", pid, nanos));
        let link = std::env::temp_dir().join(format!("gitwand-repolock-link-{}-{}", pid, nanos));
        std::fs::create_dir_all(&real).expect("create real dir");
        std::os::unix::fs::symlink(&real, &link).expect("create symlink");

        let a = lock_for(real.to_str().unwrap());
        let b = lock_for(link.to_str().unwrap());

        std::fs::remove_dir_all(&real).ok();
        std::fs::remove_file(&link).ok();

        assert!(
            Arc::ptr_eq(&a, &b),
            "a symlink and its real path must resolve to the same lock"
        );
    }

    #[test]
    fn nonexistent_path_falls_back_to_raw_string_without_panic() {
        let a = lock_for("/gitwand-repolock-does-not-exist-1");
        let b = lock_for("/gitwand-repolock-does-not-exist-1");
        assert!(Arc::ptr_eq(&a, &b), "same nonexistent path must still share one lock");
    }
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils passent déjà (le fallback actuel les couvre partiellement)**

Run: `cd apps/desktop/src-tauri && cargo test --lib git::repo_lock`
Expected: `symlink_and_real_path_share_one_lock` **FAIL** (deux chemins littéralement différents
→ deux verrous distincts avec le code actuel). `nonexistent_path_falls_back_to_raw_string_without_panic`
devrait déjà **PASS** (le comportement actuel gère déjà ce cas trivialement, aucun changement de
code requis pour lui — il sert de garde-fou de non-régression pour l'étape suivante).

- [ ] **Step 3: Modifier `lock_for` pour canonicaliser la clé**

Remplacer (lignes 68-75) :

```rust
fn lock_for(cwd: &str) -> Arc<RwLock<()>> {
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(cwd.to_string())
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}
```

par :

```rust
fn lock_for(cwd: &str) -> Arc<RwLock<()>> {
    // Canonicalize so two path representations of the same physical repo (a symlink,
    // a trailing slash, `..` components) resolve to the same lock — otherwise the
    // serialization this module exists for silently doesn't apply between them.
    // Falls back to the raw string if canonicalization fails (path removed between
    // the frontend call and this command running, unavailable network mount, …) —
    // same behavior as before this fallback existed, never a regression.
    let key = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string());
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}
```

- [ ] **Step 4: Relancer les tests pour vérifier qu'ils passent tous**

Run: `cd apps/desktop/src-tauri && cargo test --lib git::repo_lock`
Expected: PASS (6 tests — les 4 existants + les 2 nouveaux).

- [ ] **Step 5: Lancer la suite complète Rust pour vérifier l'absence de régression**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS. Vérifier en particulier qu'aucun autre test n'assume implicitement que
`lock_for("/tmp/repo-a")` sur un chemin **inexistant** littéral produit une clé identique au
chemin brut avant canonicalisation (les tests existants du module utilisent des chemins fictifs
`/tmp/repo-a`, `/tmp/repo-one`, etc. qui n'existent pas sur le disque — ils continueront de
fonctionner via le fallback, mais le confirmer explicitement en lisant leur sortie).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/git/repo_lock.rs
git commit -m "fix(desktop): canonicalize repo_lock key so path aliases share one lock"
```

---

### Task 2: Extraire `concurrentMap` + ajouter `createSemaphore`

**Files:**
- Create: `apps/desktop/src/utils/concurrentMap.ts`
- Create: `apps/desktop/src/utils/__tests__/concurrentMap.test.ts`
- Modify: `apps/desktop/src/composables/useLaunchpadTeam.ts` (retire la définition locale,
  importe depuis le nouveau module)

**Interfaces:**
- Produces: `concurrentMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number):
  Promise<R[]>` (signature inchangée) et `createSemaphore(limit: number): { run<T>(fn: () =>
  Promise<T>): Promise<T> }` (nouveau).

- [ ] **Step 1: Écrire le test du nouveau module**

```typescript
// apps/desktop/src/utils/__tests__/concurrentMap.test.ts
import { describe, it, expect } from "vitest";
import { concurrentMap, createSemaphore } from "../concurrentMap";

describe("concurrentMap", () => {
  it("resolves all items in order, respecting the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await concurrentMap(
      [1, 2, 3, 4, 5],
      async (n) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return n * 10;
      },
      2,
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("createSemaphore", () => {
  it("runs at most `limit` callbacks concurrently", async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let maxActive = 0;
    const runOne = () =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return active;
      });
    await Promise.all([runOne(), runOne(), runOne(), runOne(), runOne()]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("propagates the wrapped function's return value and rejection", async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/concurrentMap.test.ts`
Expected: FAIL — module `../concurrentMap` introuvable.

- [ ] **Step 3: Créer le module**

```typescript
// apps/desktop/src/utils/concurrentMap.ts

/** Run async `fn` on each item with at most `limit` concurrent in-flight promises. */
export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i]).then((r) => { results[i] = r; });
    executing.add(p.finally(() => executing.delete(p)));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.allSettled(executing);
  return results;
}

/**
 * Throttle ad-hoc, scattered call sites (not a known-upfront array) to at most
 * `limit` concurrent in-flight invocations. Complementary to `concurrentMap`,
 * which maps over a list; this is a bare semaphore for call sites that don't
 * fit that shape (e.g. conditional calls nested inside a larger per-item
 * pipeline already running under its own `Promise.all`).
 */
export function createSemaphore(limit: number): { run<T>(fn: () => Promise<T>): Promise<T> } {
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
```

- [ ] **Step 4: Relancer le test pour vérifier qu'il passe**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/concurrentMap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mettre à jour `useLaunchpadTeam.ts` pour importer depuis le nouveau module**

Dans `apps/desktop/src/composables/useLaunchpadTeam.ts`, remplacer la définition locale (lignes
~10-26) :

```typescript
/** Run async `fn` on each item with at most `limit` concurrent in-flight promises. */
async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i]).then((r) => { results[i] = r; });
    executing.add(p.finally(() => executing.delete(p)));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.allSettled(executing);
  return results;
}
```

par un import, à côté des autres imports en haut du fichier :

```typescript
import { concurrentMap } from "../utils/concurrentMap";
```

(Vérifier l'ordre exact des imports existants dans le fichier avant d'insérer — suivre la
convention déjà en place plutôt que de l'imposer arbitrairement.)

- [ ] **Step 6: Lancer la suite `useLaunchpadTeam` pour vérifier l'absence de régression**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useLaunchpadTeam*.test.ts`
Expected: PASS. (Si aucun fichier de test ne matche ce glob, lancer `pnpm test` complet à la
place et vérifier qu'aucun test lié à `useLaunchpadTeam` ne régresse.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/utils/concurrentMap.ts apps/desktop/src/utils/__tests__/concurrentMap.test.ts apps/desktop/src/composables/useLaunchpadTeam.ts
git commit -m "refactor(desktop): extract concurrentMap into a shared utils module, add createSemaphore"
```

---

### Task 3: Limiter la concurrence des appels `reconstructConflict`

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts:11` (import), et lignes ~460 et ~481
  (les deux points d'appel `reconstructConflict`)
- Test: `apps/desktop/src/composables/__tests__/useGitWand-base-recovery.test.ts` (fichier
  existant, livré plus tôt cette session — ajouter un cas de concurrence)

**Interfaces:**
- Consumes: `createSemaphore` (Task 2).
- Produces: au plus 4 appels `reconstructConflict` en vol simultanément, tous fichiers et tous
  blocs (markerless + récupération de base) confondus, pour un `loadRealFiles()` donné.

- [ ] **Step 1: Étendre le `vi.hoisted()` existant pour rendre `getConflictedFiles` reconfigurable, puis écrire le test**

Le fichier `useGitWand-base-recovery.test.ts` fige déjà `getConflictedFiles` sur un seul fichier
(`vi.fn(async () => ["src/foo.html"])`, ligne 46, non hoisté donc non accessible depuis un
`it()`). Pour ce nouveau cas (10 fichiers), déplacer `mockGetConflictedFiles` dans le bloc
`vi.hoisted()` existant, à côté de `mockReconstructConflict` :

```typescript
const {
  OURS_LINE,
  THEIRS_LINE,
  CONTENT_2WAY,
  RECONSTRUCTED_DIFF3,
  mockReconstructConflict,
  mockGetConflictedFiles,
} = vi.hoisted(() => {
  // … contenu existant inchangé (OURS_LINE, THEIRS_LINE, CONTENT_2WAY, RECONSTRUCTED_DIFF3) …
  return {
    OURS_LINE,
    THEIRS_LINE,
    CONTENT_2WAY,
    RECONSTRUCTED_DIFF3,
    mockReconstructConflict: vi.fn(),
    mockGetConflictedFiles: vi.fn(async () => ["src/foo.html"]),
  };
});
```

Puis dans `vi.mock("@/utils/backend", ...)`, remplacer `getConflictedFiles: vi.fn(async () =>
["src/foo.html"]),` par `getConflictedFiles: mockGetConflictedFiles,`. Ajouter un
`mockGetConflictedFiles.mockClear()` dans le `beforeEach` existant, à côté de
`mockReconstructConflict.mockClear()`, et remettre son implémentation par défaut sur un seul
fichier (`mockGetConflictedFiles.mockImplementation(async () => ["src/foo.html"]);`) pour ne
pas casser les 3 tests existants du fichier.

Ajouter ensuite le nouveau cas :

```typescript
describe("useGitWand : concurrence de reconstructConflict limitée", () => {
  it("ne lance jamais plus de 4 reconstructConflict en vol simultanément", async () => {
    // 10 fichiers, chacun sans base → chacun déclenche un appel reconstructConflict.
    const manyPaths = Array.from({ length: 10 }, (_, i) => `src/file${i}.html`);
    mockGetConflictedFiles.mockResolvedValueOnce(manyPaths);

    let active = 0;
    let maxActive = 0;
    mockReconstructConflict.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { content: RECONSTRUCTED_DIFF3, wtMatchesSide: false };
    });

    const gw = useGitWand();
    await gw.openPath("/repo");

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(mockReconstructConflict).toHaveBeenCalledTimes(10);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useGitWand-base-recovery.test.ts -t "concurrence"`
Expected: FAIL — `maxActive` dépasse 4 (aucune limite en place, les 10 appels partent tous en
même temps via `Promise.all`).

- [ ] **Step 3: Importer `createSemaphore` et créer le limiteur**

Dans `apps/desktop/src/composables/useGitWand.ts`, à côté des autres imports de `backend.ts`
(ligne ~11) :

```typescript
import { createSemaphore } from "../utils/concurrentMap";
```

Juste avant la définition de `useGitWand()` (ou à un emplacement de niveau module cohérent avec
le reste du fichier) :

```typescript
/**
 * Reads the index via `git show` ×3 + runs `git merge-file` per call — up to 4
 * git subprocesses per file. `loadRealFiles()` runs fully in parallel across all
 * conflicted files, so without a cap a repo with many base-less conflicts could
 * spawn dozens of concurrent git subprocesses at once. Defensive, not a proven
 * fix for any specific incident — reduces subprocess load regardless.
 */
const reconstructLimiter = createSemaphore(4);
```

- [ ] **Step 4: Envelopper les deux appels existants**

Remplacer (ligne ~460, bloc « markerless ») :

```typescript
            const rec = await reconstructConflict(cwd, filePath);
```

par :

```typescript
            const rec = await reconstructLimiter.run(() => reconstructConflict(cwd, filePath));
```

Remplacer (ligne ~481, bloc « récupération de base ») :

```typescript
            const rec = await reconstructConflict(cwd, filePath);
```

par :

```typescript
            const rec = await reconstructLimiter.run(() => reconstructConflict(cwd, filePath));
```

(Les deux occurrences sont textuellement identiques — utiliser le contexte environnant de
chaque bloc, déjà cité ci-dessus, pour cibler la bonne occurrence lors de l'édition.)

- [ ] **Step 5: Relancer le test pour vérifier qu'il passe**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useGitWand-base-recovery.test.ts`
Expected: PASS (tous les tests du fichier, incluant les 3 existants + le nouveau).

- [ ] **Step 6: Lancer la suite complète pour vérifier l'absence de régression**

Run: `cd apps/desktop && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts apps/desktop/src/composables/__tests__/useGitWand-base-recovery.test.ts
git commit -m "fix(desktop): cap concurrent reconstructConflict git subprocesses at 4"
```

---

### Task 4: Vérification de bout en bout

**Files:** aucun changement de code — vérification uniquement.

- [ ] **Step 1: Suite Rust complète**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS, aucune régression.

- [ ] **Step 2: Type-check + suite complète TypeScript**

Run:
```bash
cd apps/desktop && ./node_modules/.bin/vue-tsc --noEmit && pnpm test
```
Expected: exit code 0 pour le type-check, tous les tests passent.

- [ ] **Step 3: `packages/core` — confirmer l'absence d'impact croisé**

Run: `cd packages/core && pnpm test`
Expected: PASS (ce chantier ne touche pas `packages/core`, aucune régression attendue).

- [ ] **Step 4: Vérification manuelle du comportement du verrou (si possible sans risque)**

Si un accès sûr à un repo de test est disponible : ouvrir le même repo physique via deux chemins
différents (ex. un lien symbolique créé exprès dans un dossier temporaire) dans deux fenêtres/
onglets GitWand, déclencher une résolution de conflit dans les deux simultanément, et vérifier
qu'aucune corruption ni erreur `index.lock` inattendue ne se produit. Si aucun environnement de
test sûr n'est disponible pour ce scénario précis, documenter cette limitation plutôt que de la
tester sur un repo de production.
