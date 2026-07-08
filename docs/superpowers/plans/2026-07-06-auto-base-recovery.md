# Auto Base Recovery for 2-Way Conflicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a conflicted file has markers but no `|||||||` base section (git's default
`merge.conflictstyle`, not diff3/zdiff3), silently recover the base from the git index and
re-resolve with it — unlocking every `requires: "diff3"` pattern (`non_overlapping`,
`one_side_change`, `reorder_only`, `insertion_at_boundary`, `token_level_merge`) without any
user action.

**Architecture:** Pure frontend addition. Reuses the existing `reconstruct_conflict` Rust
command and `backend.ts::reconstructConflict()` wrapper as-is (already reads git index stages
1/2/3 via `git show` + `git merge-file --diff3`, regardless of what the working tree markers
contain). New logic lives entirely in `useGitWand.ts::loadRealFiles()` plus a banner in
`MergeEditor.vue`.

**Tech Stack:** TypeScript (Vue 3 composable + component), Vitest (jsdom, mocked `backend.ts`
per existing composable-test convention).

## Global Constraints

- **Aucun changement Rust ni `packages/core`.** `reconstruct_conflict` (Rust) et `resolveAsync`
  (core) sont consommés tels quels.
- Le fichier sur disque n'est **jamais** modifié par ce flux — seul le contenu en mémoire
  (`ConflictFile.content`) est enrichi.
- IPC : `reconstructConflict` est déjà wrappé dans `apps/desktop/src/utils/backend.ts` — aucun
  nouvel appel `invoke()` à ajouter.
- i18n : toute nouvelle string visible dans les 5 locales (`en.ts`, `fr.ts`, `es.ts`,
  `pt-BR.ts`, `zh-CN.ts` — noms de fichiers exacts, respecter la casse).
- Tests composable : ce projet mocke `@/utils/backend` dans les tests de composables (voir
  `useRepoFileTree.test.ts`) — la règle "pas de mock de la couche git" d'`AGENTS.md` vise les
  tests Rust avec de vrais repos temporaires, pas les tests de composables Vue qui mockent déjà
  systématiquement la frontière IPC.

---

### Task 1: Détection + récupération + garde-fou dans `useGitWand.ts`

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts:26-35` (interface `ConflictFile`)
- Modify: `apps/desktop/src/composables/useGitWand.ts:449-470` (bloc dans `loadRealFiles`)
- Test: `apps/desktop/src/composables/__tests__/useGitWand-base-recovery.test.ts` (nouveau fichier)

**Interfaces:**
- Consumes: `reconstructConflict(cwd, path): Promise<{ content: string; wtMatchesSide: boolean }>`
  (déjà importé dans `useGitWand.ts:11`, `backend.ts:141`), `resolveAsync(content, filePath,
  options, structuralOpts): Promise<MergeResult>` (déjà importé, `@gitwand/core`).
- Produces: `ConflictFile.baseEnriched?: boolean` — nouveau champ optionnel, lu par `MergeEditor.vue`
  au Task 2.

- [ ] **Step 1: Écrire le test qui vérifie l'enrichissement réussi**

```typescript
// apps/desktop/src/composables/__tests__/useGitWand-base-recovery.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const OURS_LINE = '<div class="flex items-baseline gap-x-3 mr-2">'; // changed from base
const THEIRS_LINE = '<div class="flex items-baseline gap-x-2 mr-2">'; // == base, unchanged
const CONTENT_2WAY = [
  "before",
  "<<<<<<< ours",
  OURS_LINE,
  "=======",
  THEIRS_LINE,
  ">>>>>>> theirs",
  "after",
].join("\n");

const RECONSTRUCTED_DIFF3 = [
  "before",
  "<<<<<<< ours",
  OURS_LINE,
  "||||||| base",
  THEIRS_LINE, // base matches theirs → one_side_change (ours changed)
  "=======",
  THEIRS_LINE,
  ">>>>>>> theirs",
  "after",
].join("\n");

const mockReconstructConflict = vi.fn(async () => ({
  content: RECONSTRUCTED_DIFF3,
  wtMatchesSide: false,
}));

vi.mock("@/utils/backend", () => ({
  pickFolder: vi.fn(),
  getConflictedFiles: vi.fn(async () => ["src/foo.html"]),
  readFile: vi.fn(async () => CONTENT_2WAY),
  writeFile: vi.fn(),
  readGitwandrc: vi.fn(async () => ""),
  getTreeConflicts: vi.fn(async () => []),
  resolveTreeConflict: vi.fn(),
  reconstructConflict: mockReconstructConflict,
  gitStage: vi.fn(),
}));

import { useGitWand } from "../useGitWand";

beforeEach(() => {
  mockReconstructConflict.mockClear();
});

describe("useGitWand : récupération de base pour conflits 2-way", () => {
  it("enrichit un fichier dont le hunk n'a pas de base et marque baseEnriched", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    expect(mockReconstructConflict).toHaveBeenCalledWith("/repo", "src/foo.html");
    const file = gw.files.value[0];
    expect(file.baseEnriched).toBe(true);
    expect(file.content).toBe(RECONSTRUCTED_DIFF3);
    expect(file.result.hunks[0].type).not.toBe("complex");
    expect(file.result.hunks[0].baseLines.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useGitWand-base-recovery.test.ts`
Expected: FAIL — `file.baseEnriched` est `undefined` (le bloc n'existe pas encore), le hunk reste
probablement `complex` ou classifié sans base.

- [ ] **Step 3: Ajouter le champ à l'interface `ConflictFile`**

Dans `apps/desktop/src/composables/useGitWand.ts`, modifier (lignes 26-35) :

```typescript
export interface ConflictFile {
  path: string;
  content: string;
  result: MergeResult;
  tree?: TreeConflictInfo;
  /** True when content was rebuilt from the index because the working tree had no markers. */
  reconstructed?: boolean;
  /** Set when an unmerged file has no markers AND the working tree matches no side (possible manual edit). */
  markerless?: { reconstructed: string };
  /**
   * True when the file had 2-way markers (no `|||||||` base — git's default
   * merge.conflictstyle) and the base was silently recovered from the git index.
   * The ours/theirs content shown to the user is unchanged; only the base was added.
   */
  baseEnriched?: boolean;
}
```

- [ ] **Step 4: Ajouter le bloc d'enrichissement dans `loadRealFiles`**

Dans `apps/desktop/src/composables/useGitWand.ts`, remplacer (lignes ~449-470) :

```typescript
        const content = await readFile(cwd, filePath);
        const result = await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts);
        // Unmerged file with no parseable markers → reconstruct the 3-way from the index.
        if (result.stats.totalConflicts === 0) {
          try {
            const rec = await reconstructConflict(cwd, filePath);
            if (rec.content.includes("<<<<<<<")) {
              if (rec.wtMatchesSide) {
                // Working tree is just one side → swap in reconstructed markers and resolve normally.
                return {
                  path: filePath,
                  content: rec.content,
                  result: await resolveAsync(rec.content, filePath, resolveOptionsWithLlm, structuralOpts),
                  reconstructed: true,
                };
              }
              // Working tree matches no side → possible manual edit; keep it, offer a choice.
              return { path: filePath, content, result, markerless: { reconstructed: rec.content } };
            }
          } catch { /* not reconstructable → fall through to plain result */ }
        }
        return { path: filePath, content, result };
```

par :

```typescript
        const content = await readFile(cwd, filePath);
        const result = await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts);
        // Unmerged file with no parseable markers → reconstruct the 3-way from the index.
        if (result.stats.totalConflicts === 0) {
          try {
            const rec = await reconstructConflict(cwd, filePath);
            if (rec.content.includes("<<<<<<<")) {
              if (rec.wtMatchesSide) {
                // Working tree is just one side → swap in reconstructed markers and resolve normally.
                return {
                  path: filePath,
                  content: rec.content,
                  result: await resolveAsync(rec.content, filePath, resolveOptionsWithLlm, structuralOpts),
                  reconstructed: true,
                };
              }
              // Working tree matches no side → possible manual edit; keep it, offer a choice.
              return { path: filePath, content, result, markerless: { reconstructed: rec.content } };
            }
          } catch { /* not reconstructable → fall through to plain result */ }
        }
        // Markers present but at least one hunk has no base (merge.conflictstyle isn't
        // diff3/zdiff3) → try recovering the base from the index so diff3-only patterns
        // (non_overlapping, one_side_change, token_level_merge, …) can apply.
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
            // ours/theirs diverge from the index (manual edit since the conflict) → abandon silently.
          } catch { /* no recoverable stage (e.g. add/add) → fall through to plain result */ }
        }
        return { path: filePath, content, result };
```

- [ ] **Step 5: Relancer le test pour vérifier qu'il passe**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useGitWand-base-recovery.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Écrire le test du garde-fou (divergence → abandon)**

Ajouter au même fichier :

```typescript
describe("useGitWand : garde-fou — abandon si ours/theirs divergent", () => {
  it("n'enrichit pas si la base reconstruite ne correspond pas au working tree", async () => {
    mockReconstructConflict.mockResolvedValueOnce({
      content: [
        "before",
        "<<<<<<< ours",
        "SOMETHING ELSE ENTIRELY", // diverges from CONTENT_2WAY's ours line
        "||||||| base",
        THEIRS_LINE,
        "=======",
        THEIRS_LINE,
        ">>>>>>> theirs",
        "after",
      ].join("\n"),
      wtMatchesSide: false,
    });
    const gw = useGitWand();
    await gw.openPath("/repo");

    const file = gw.files.value[0];
    expect(file.baseEnriched).toBeUndefined();
    expect(file.content).toBe(CONTENT_2WAY);
  });
});
```

- [ ] **Step 7: Lancer ce test pour vérifier qu'il passe déjà (le garde-fou du Step 4 le couvre)**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useGitWand-base-recovery.test.ts`
Expected: PASS (2 tests). Si ce test échoue, corriger la comparaison `sameOursTheirs` du Step 4
avant de continuer — ne pas passer au Step 8 avec un garde-fou qui ne garde rien.

- [ ] **Step 8: Écrire le test du cas add/add (pas de stage récupérable)**

```typescript
describe("useGitWand : reconstructConflict échoue (add/add) → fallback propre", () => {
  it("garde le résultat non enrichi sans planter si reconstructConflict rejette", async () => {
    mockReconstructConflict.mockRejectedValueOnce(new Error("no index stages for src/foo.html"));
    const gw = useGitWand();
    await gw.openPath("/repo");

    const file = gw.files.value[0];
    expect(file.baseEnriched).toBeUndefined();
    expect(file.content).toBe(CONTENT_2WAY);
    expect(gw.error.value).toBeNull();
  });
});
```

- [ ] **Step 9: Lancer tous les tests du fichier**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useGitWand-base-recovery.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Lancer la suite complète pour vérifier l'absence de régression**

Run: `cd apps/desktop && pnpm test`
Expected: PASS — en particulier, le flux "markerless" existant (`totalConflicts === 0`) ne doit
pas être affecté (il reste dans son propre `if`, non touché).

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts apps/desktop/src/composables/__tests__/useGitWand-base-recovery.test.ts
git commit -m "feat(desktop): recover base from git index for 2-way conflicts"
```

---

### Task 2: Bandeau UI + i18n

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue:784` (bandeau, à côté du bandeau
  `reconstructed` existant) et section `<style>` (ligne ~1764)
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts` (clé
  `merge.baseEnrichedBanner`, à côté de `merge.reconstructedBanner`)
- Test: `apps/desktop/src/components/__tests__/MergeEditor.test.ts` (nouveau cas, dans le
  fichier existant)

**Interfaces:**
- Consumes: `file.baseEnriched` (Task 1), `t('merge.baseEnrichedBanner')` (`useI18n.ts`, déjà
  importé dans `MergeEditor.vue`).

- [ ] **Step 1: Écrire le test du bandeau**

Ajouter dans `apps/desktop/src/components/__tests__/MergeEditor.test.ts` (réutiliser
`markerlessFile()`/`resolvedFile()` comme modèle) :

```typescript
function baseEnrichedFile(): ConflictFile {
  return {
    path: "src/foo.ts",
    content: "line one\nline two\n",
    result: {
      filePath: "src/foo.ts",
      mergedContent: "line one\nline two\n",
      hunks: [],
      resolutions: [],
      stats: { totalConflicts: 0, autoResolved: 0 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
    baseEnriched: true,
  };
}

describe("MergeEditor : bandeau baseEnriched", () => {
  it("affiche le bandeau quand baseEnriched est true", async () => {
    mountWithFile(baseEnrichedFile());
    await nextTick();
    expect(container.querySelector(".me-base-enriched-banner")).not.toBeNull();
  });

  it("n'affiche pas le bandeau quand baseEnriched est absent", async () => {
    mountWithFile(resolvedFile());
    await nextTick();
    expect(container.querySelector(".me-base-enriched-banner")).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "bandeau baseEnriched"`
Expected: FAIL — le bandeau n'existe pas encore.

- [ ] **Step 3: Ajouter les clés i18n (référence : `fr.ts`)**

Dans `apps/desktop/src/locales/fr.ts`, à côté de la clé existante (chercher
`reconstructedBanner:`) :

```typescript
    reconstructedBanner: "Conflit reconstruit depuis l'index — le fichier n'avait pas de marqueurs",
    baseEnrichedBanner: "Base ancêtre récupérée depuis l'index git",
```

- [ ] **Step 4: Ajouter la clé dans `en.ts`**

```typescript
    reconstructedBanner: "Conflict reconstructed from the index — the file had no markers",
    baseEnrichedBanner: "Common-ancestor base recovered from the git index",
```

- [ ] **Step 5: Ajouter la clé dans `es.ts`**

```typescript
    reconstructedBanner: "Conflicto reconstruido desde el índice — el archivo no tenía marcadores",
    baseEnrichedBanner: "Base ancestro común recuperada desde el índice de git",
```

- [ ] **Step 6: Ajouter la clé dans `pt-BR.ts`**

```typescript
    reconstructedBanner: "Conflito reconstruído a partir do índice — o arquivo não tinha marcadores",
    baseEnrichedBanner: "Base ancestral comum recuperada a partir do índice do git",
```

- [ ] **Step 7: Ajouter la clé dans `zh-CN.ts`**

```typescript
    reconstructedBanner: "冲突从索引重建 — 文件中没有冲突标记",
    baseEnrichedBanner: "已从 git 索引恢复共同祖先基线",
```

- [ ] **Step 8: Ajouter le bandeau dans le template `MergeEditor.vue`**

Juste après le bandeau `reconstructed` existant (ligne ~784-789) :

```vue
      <div v-if="file.reconstructed" class="me-reconstructed-banner">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-1.5h1.5v1.5zm0-3h-1.5V4.5h1.5V8.5z"/>
        </svg>
        <span>{{ t('merge.reconstructedBanner') }}</span>
      </div>
      <div v-if="file.baseEnriched" class="me-base-enriched-banner">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-1.5h1.5v1.5zm0-3h-1.5V4.5h1.5V8.5z"/>
        </svg>
        <span>{{ t('merge.baseEnrichedBanner') }}</span>
      </div>
```

- [ ] **Step 9: Ajouter le style, à côté de `.me-reconstructed-banner` (ligne ~1764)**

```css
.me-base-enriched-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--color-text-secondary, #888);
  background: var(--color-bg-secondary, rgba(0,0,0,0.03));
  border-bottom: 1px solid var(--color-border, #e0e0e0);
}
```

- [ ] **Step 10: Relancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "bandeau baseEnriched"`
Expected: PASS (2 tests).

- [ ] **Step 11: Lancer la suite complète du composant**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue apps/desktop/src/components/__tests__/MergeEditor.test.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): show a discreet banner when the conflict base was auto-recovered"
```

---

### Task 3: Vérification de bout en bout

**Files:** aucun changement de code — vérification uniquement.

- [ ] **Step 1: Type-check complet**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit -p tsconfig.json`
Expected: exit code 0, aucune erreur.

- [ ] **Step 2: Suite complète `apps/desktop`**

Run: `cd apps/desktop && pnpm test`
Expected: PASS, aucune régression (en particulier le flux `reconstructed`/`markerless` existant
et les tests `token_level_merge`/`llm_proposed` livrés dans la session précédente).

- [ ] **Step 3: Vérifier que le corpus/tests `packages/core` ne sont pas concernés**

Run: `cd packages/core && pnpm test`
Expected: PASS — ce chantier ne touche pas `packages/core`, ce run confirme juste l'absence de
régression croisée (aucune n'est attendue).

- [ ] **Step 4: Vérification manuelle (si un navigateur est disponible sans conflit de port)**

Ouvrir un repo réel avec `merge.conflictstyle` par défaut (pas de config `diff3`/`zdiff3`) et un
conflit à un seul côté modifié par ligne. Vérifier :
- Le fichier n'est plus classifié `complex` (ex. `one_side_change`, `non_overlapping`, ou
  `token_level_merge` selon le cas réel).
- Le bandeau « Base ancêtre récupérée depuis l'index git » s'affiche.
- Le fichier sur disque n'a pas été modifié (`git diff` ne montre aucun changement en dehors de
  la résolution explicite de l'utilisateur).

Si aucun navigateur isolé n'est disponible (port déjà utilisé par une autre session), documenter
cette limitation plutôt que de la contourner en modifiant la config de ports du projet.

- [ ] **Step 5: Mettre à jour `roadmap.md` si le projet suit cette convention pour les fixes shipped**

Vérifier `roadmap.md` à la racine (règle `AGENTS.md` — lire avant toute feature non triviale) :
si une section "Shipped" existe pour la version en cours, y ajouter une ligne courte
("Récupération automatique de la base git pour les conflits sans `|||||||`"). Si aucune section
pertinente n'existe encore pour cette version, ne pas en créer une seulement pour cette entrée —
laisser au mainteneur le choix du moment de version.
