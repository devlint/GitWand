# Resolution Preview Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every hunk where `packages/core` already computed a resolution
(`result.resolutions[i].autoResolved === true`), show the exact merged content before the user
validates, and make "Accepter" apply that exact content — never a frontend-reconstructed
approximation. Fixes a real inconsistency: the per-hunk "Accepter les deux" button currently
does a raw `[...oursLines, ...theirsLines]` concatenation instead of the engine's real
`resolvedLines` (e.g. the LCS 3-way merge for `non_overlapping`).

**Architecture:** Pure frontend addition (`apps/desktop/src`). New generic
`ResolutionPreviewPanel.vue`, modeled directly on the existing `TokenMergePanel.vue`, replaces
the classic action bar for hunks with a computed resolution — `complex` hunks are untouched. A
new `ResolveAutoSummaryModal.vue` gates the file-level "Résoudre auto" button behind a
confirmation listing what will be applied.

**Tech Stack:** Vue 3 `<script setup>`, Vitest (native `createApp` mount convention, no
`@vue/test-utils` — see `TokenMergePanel.test.ts`).

## Global Constraints

- **Aucun changement `packages/core` ni Rust.** `HunkResolution.resolvedLines` existe déjà pour
  tous les types auto-résolvables via `assembleResolution()` (`resolver/assemble.ts`).
- i18n : nouvelles clés dans les 5 locales (`en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts` —
  casse exacte des noms de fichiers).
- Convention de test des composants de ce module : montage natif `createApp(Component, props)`
  dans un container jsdom, pas `@vue/test-utils` (voir `TokenMergePanel.test.ts`,
  `LlmTracePanel.test.ts`).
- Perf : tout nouveau modal conditionné par un `v-if` (flag par défaut `false`) doit être
  lazy-loadé via `defineAsyncComponent` (règle P1.2, `apps/desktop/CLAUDE.md`).
- `resolveHunkManual()` n'est **pas** supprimée — elle reste le chemin pour les hunks `complex`.

---

### Task 1: Composant `ResolutionPreviewPanel.vue` + i18n

**Files:**
- Create: `apps/desktop/src/components/ResolutionPreviewPanel.vue`
- Test: `apps/desktop/src/components/__tests__/ResolutionPreviewPanel.test.ts`
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: rien de nouveau côté `@gitwand/core` — `resolvedLines: string[]` et `explanation:
  string` sont passés en props depuis le parent (Task 2), déjà disponibles sur
  `HunkResolution.resolvedLines` / `ConflictHunk.explanation`.
- Produces: composant `props: { resolvedLines: string[], hunkId: number, explanation: string,
  accepted?: boolean }`, `emits: { accept: [hunkId: number]; reject: [hunkId: number] }` —
  contrat identique à `TokenMergePanel.vue`.

- [ ] **Step 1: Ajouter les clés i18n (référence : `fr.ts`, à côté de `mergeEditor.tokenLevelMerge`)**

Dans `apps/desktop/src/locales/fr.ts`, chercher le bloc `tokenLevelMerge: { ... },` (namespace
`mergeEditor`) et ajouter juste après :

```typescript
    resolutionPreview: {
      title: "Résolution proposée",
      accept: "Accepter",
      reject: "Rejeter → résolution manuelle",
      accepted: "Accepté",
    },
```

- [ ] **Step 2: Ajouter les clés dans `en.ts`**

```typescript
    resolutionPreview: {
      title: "Proposed resolution",
      accept: "Accept",
      reject: "Reject → resolve manually",
      accepted: "Accepted",
    },
```

- [ ] **Step 3: Ajouter les clés dans `es.ts`**

```typescript
    resolutionPreview: {
      title: "Resolución propuesta",
      accept: "Aceptar",
      reject: "Rechazar → resolver manualmente",
      accepted: "Aceptado",
    },
```

- [ ] **Step 4: Ajouter les clés dans `pt-BR.ts`**

```typescript
    resolutionPreview: {
      title: "Resolução proposta",
      accept: "Aceitar",
      reject: "Rejeitar → resolver manualmente",
      accepted: "Aceito",
    },
```

- [ ] **Step 5: Ajouter les clés dans `zh-CN.ts`**

```typescript
    resolutionPreview: {
      title: "提议的解决方案",
      accept: "接受",
      reject: "拒绝 → 手动解决",
      accepted: "已接受",
    },
```

- [ ] **Step 6: Écrire le test du composant**

```typescript
// apps/desktop/src/components/__tests__/ResolutionPreviewPanel.test.ts
/**
 * ResolutionPreviewPanel.vue — accept/reject action UI for any hunk the core
 * already auto-resolved (non_overlapping, one_side_change, whitespace_only, …).
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep) and a
 * real `useI18n` (default locale → English keys), mirroring TokenMergePanel.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import ResolutionPreviewPanel from "../ResolutionPreviewPanel.vue";

const resolvedLines = ['<div class="flex items-baseline space-x-2 mr-2">', '<label class="font-bold">'];

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(ResolutionPreviewPanel, {
    resolvedLines,
    hunkId: 3,
    explanation: "Les deux branches ont modifié des zones différentes du même bloc.",
    ...props,
  });
  app.mount(container);
}

beforeEach(() => {
  localStorage.clear(); // ensure default (English) locale
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

describe("ResolutionPreviewPanel actions", () => {
  it("shows the Accept button (not the badge) when not accepted", () => {
    mount({ accepted: false });
    expect(container.querySelector(".resolution-preview-panel__btn--accept")).not.toBeNull();
    expect(container.querySelector(".resolution-preview-panel__accepted-badge")).toBeNull();
  });

  it("displays the resolved content and the explanation", () => {
    mount({ accepted: false });
    expect(container.textContent).toContain("space-x-2");
    expect(container.textContent).toContain("modifié des zones différentes");
  });

  it("swaps the Accept/Reject buttons for a badge when accepted", () => {
    mount({ accepted: true });
    expect(container.querySelector(".resolution-preview-panel__accepted-badge")).not.toBeNull();
    expect(container.querySelector(".resolution-preview-panel__btn--accept")).toBeNull();
    expect(container.querySelector(".resolution-preview-panel__btn--reject")).toBeNull();
  });

  it("emits `accept` with the hunk id when Accept is clicked", async () => {
    const onAccept = vi.fn();
    mount({ accepted: false, onAccept });
    container
      .querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!
      .click();
    await nextTick();
    expect(onAccept).toHaveBeenCalledWith(3);
  });

  it("emits `reject` with the hunk id when Reject is clicked", async () => {
    const onReject = vi.fn();
    mount({ accepted: false, onReject });
    container
      .querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--reject")!
      .click();
    await nextTick();
    expect(onReject).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 7: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/ResolutionPreviewPanel.test.ts`
Expected: FAIL — `Cannot find module '../ResolutionPreviewPanel.vue'`.

- [ ] **Step 8: Implémenter le composant**

```vue
<!-- apps/desktop/src/components/ResolutionPreviewPanel.vue -->
<script setup lang="ts">
import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
  resolvedLines: string[];
  hunkId: number;
  explanation: string;
  accepted?: boolean;
}>();

const emit = defineEmits<{
  accept: [hunkId: number];
  reject: [hunkId: number];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="resolution-preview-panel">
    <div class="resolution-preview-panel__header">
      <span class="resolution-preview-panel__title">{{ t('mergeEditor.resolutionPreview.title') }}</span>
    </div>
    <p class="resolution-preview-panel__explanation">{{ props.explanation }}</p>
    <pre class="resolution-preview-panel__preview">{{ props.resolvedLines.join('\n') }}</pre>
    <div class="resolution-preview-panel__actions">
      <template v-if="!props.accepted">
        <button
          type="button"
          class="resolution-preview-panel__btn resolution-preview-panel__btn--accept"
          @click="emit('accept', props.hunkId)"
        >
          {{ t('mergeEditor.resolutionPreview.accept') }}
        </button>
        <button
          type="button"
          class="resolution-preview-panel__btn resolution-preview-panel__btn--reject"
          @click="emit('reject', props.hunkId)"
        >
          {{ t('mergeEditor.resolutionPreview.reject') }}
        </button>
      </template>
      <span v-else class="resolution-preview-panel__accepted-badge">
        {{ t('mergeEditor.resolutionPreview.accepted') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.resolution-preview-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  margin: 8px 0;
  background: var(--color-bg-secondary);
}
.resolution-preview-panel__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.resolution-preview-panel__title {
  font-weight: 600;
  font-size: 13px;
}
.resolution-preview-panel__explanation {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0 0 8px 0;
}
.resolution-preview-panel__preview {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-bg-primary);
  border-radius: var(--radius-sm);
  padding: 8px;
  overflow-x: auto;
  margin: 0 0 8px 0;
}
.resolution-preview-panel__actions {
  display: flex;
  gap: 8px;
}
.resolution-preview-panel__btn {
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--color-border);
}
.resolution-preview-panel__btn--accept {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.resolution-preview-panel__btn--reject {
  background: transparent;
}
.resolution-preview-panel__accepted-badge {
  font-size: 12px;
  color: var(--color-success);
}
</style>
```

- [ ] **Step 9: Relancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/ResolutionPreviewPanel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/components/ResolutionPreviewPanel.vue apps/desktop/src/components/__tests__/ResolutionPreviewPanel.test.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): add ResolutionPreviewPanel for pre-computed hunk resolutions"
```

---

### Task 2: Câbler dans `MergeEditor.vue` — corrige le bug « Accepter les deux »

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue`
  - Import (haut de fichier, à côté de `TokenMergePanel`)
  - Nouveau computed `resolutions` (à côté de `hunks`, ligne ~272)
  - État réactif + handlers (à côté de `rejectedTokenMergeHunks`/`onTokenMergeAccept`)
  - Template : rendu conditionnel du panneau + masquage de la barre d'actions classique
- Test: `apps/desktop/src/components/__tests__/MergeEditor.test.ts`

**Interfaces:**
- Consumes: `ResolutionPreviewPanel` (Task 1), `file.result.resolutions[hunkIndex]`
  (`HunkResolution { hunk, resolvedLines, autoResolved, resolutionReason }` — `@gitwand/core`),
  emit existant `resolveHunkCustom(path, hunkIndex, content: string)`.
- Produces: quand l'utilisateur clique « Accepter », `MergeEditor` émet
  `resolveHunkCustom(file.path, hunkIndex, resolvedLines.join("\n"))` avec le **vrai**
  `resolvedLines` du moteur — plus jamais la concaténation brute de `resolveHunkManual()` pour
  ces hunks.

- [ ] **Step 1: Écrire le test de régression clé**

Ajouter dans `apps/desktop/src/components/__tests__/MergeEditor.test.ts`, en suivant le modèle
`tokenMergeHunk()`/`tokenMergeFile()`/`mountDirect()` déjà présents dans ce fichier :

```typescript
import type { HunkResolution } from "@gitwand/core";

function nonOverlappingHunk(): ConflictHunk {
  return {
    baseLines: ["line1", "line2"],
    oursLines: ["line1-changed", "line2"],
    theirsLines: ["line1", "line2-changed"],
    startLine: 2,
    type: "non_overlapping",
    confidence: {
      score: 90,
      label: "high",
      dimensions: { typeClassification: 90, dataRisk: 20, scopeImpact: 0, fileFrequency: 0, baseAvailability: 100 },
      boosters: [],
      penalties: [],
    },
    explanation: "Les deux branches ont modifié des zones différentes du même bloc. Fusion automatique possible.",
    trace: { steps: [], selected: "non_overlapping", summary: "test", hasBase: true },
  };
}

function nonOverlappingResolution(): HunkResolution {
  return {
    hunk: nonOverlappingHunk(),
    resolvedLines: ["line1-changed", "line2-changed"], // le vrai merge LCS — PAS ours+theirs concaténés
    autoResolved: true,
    resolutionReason: "Merge LCS 3-way réussi.",
  };
}

function nonOverlappingFile(): ConflictFile {
  const content = [
    "<<<<<<< ours",
    "line1-changed",
    "line2",
    "|||||||",
    "line1",
    "line2",
    "=======",
    "line1",
    "line2-changed",
    ">>>>>>> theirs",
  ].join("\n");
  return {
    path: "src/config.ts",
    content,
    result: {
      filePath: "src/config.ts",
      mergedContent: null,
      hunks: [nonOverlappingHunk()],
      resolutions: [nonOverlappingResolution()],
      stats: { totalConflicts: 1, autoResolved: 1 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

describe("MergeEditor : panneau de résolution générique (non_overlapping)", () => {
  it("affiche ResolutionPreviewPanel pour un hunk auto-résolu (non_overlapping)", () => {
    mountDirect(nonOverlappingFile());
    expect(container.querySelector(".resolution-preview-panel")).not.toBeNull();
  });

  it("masque la barre d'actions classique quand le panneau est affiché", () => {
    mountDirect(nonOverlappingFile());
    expect(container.querySelector(".inline-actions")).toBeNull();
  });

  it("émet resolveHunkCustom avec le VRAI resolvedLines (pas une concaténation ours+theirs)", async () => {
    let emitted: unknown[] | null = null;
    mountDirect(nonOverlappingFile(), {
      onResolveHunkCustom: (...args: unknown[]) => { emitted = args; },
    });
    container
      .querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!
      .click();
    await nextTick();
    // resolvedLines réel : ["line1-changed", "line2-changed"] — PAS
    // ["line1-changed", "line2", "line1", "line2-changed"] (ce que ferait l'ancienne
    // concaténation ours+theirs de resolveHunkManual("both")).
    expect(emitted).toEqual(["src/config.ts", 0, "line1-changed\nline2-changed"]);
  });

  it("un hunk token_level_merge n'obtient pas ce panneau (a déjà le sien, TokenMergePanel)", () => {
    const file = tokenMergeFile(); // type token_level_merge — exclu explicitement dans showResolutionPreviewFor
    mountDirect(file);
    expect(container.querySelector(".resolution-preview-panel")).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "panneau de résolution générique"`
Expected: FAIL — `ResolutionPreviewPanel` non rendu (condition `v-if` absente, import manquant).

- [ ] **Step 3: Ajouter l'import**

En haut de `MergeEditor.vue`, à côté de l'import de `TokenMergePanel` :

```typescript
import ResolutionPreviewPanel from "./ResolutionPreviewPanel.vue";
```

- [ ] **Step 4: Ajouter le computed `resolutions`**

À côté de `const hunks = computed(() => props.file.result.hunks);` (ligne ~272) :

```typescript
const resolutions = computed(() => props.file.result.resolutions);
```

- [ ] **Step 5: Ajouter l'état réactif et les handlers**

À côté de `rejectedTokenMergeHunks`/`onTokenMergeAccept`/`onTokenMergeReject`/`showTokenMergePanelFor` :

```typescript
const rejectedPreviewHunks = ref<Set<number>>(new Set());

function onPreviewAccept(hunkIndex: number) {
  const resolution = resolutions.value[hunkIndex];
  if (!resolution?.resolvedLines) return;
  emit("resolveHunkCustom", props.file.path, hunkIndex, resolution.resolvedLines.join("\n"));
}

function onPreviewReject(hunkIndex: number) {
  const next = new Set(rejectedPreviewHunks.value);
  next.add(hunkIndex);
  rejectedPreviewHunks.value = next;
}

/**
 * Hunks avec une résolution déjà calculée par le moteur (autoResolved) obtiennent le
 * panneau générique — sauf llm_proposed/token_level_merge qui ont déjà le leur.
 */
function showResolutionPreviewFor(hunkIndex: number, hunk: ConflictHunk): boolean {
  if (hunk.type === "llm_proposed" || hunk.type === "token_level_merge") return false;
  if (!resolutions.value[hunkIndex]?.autoResolved) return false;
  if (!resolutions.value[hunkIndex]?.resolvedLines) return false;
  return !rejectedPreviewHunks.value.has(hunkIndex);
}
```

- [ ] **Step 6: Ajouter le rendu conditionnel dans le template**

Juste après le `<TokenMergePanel ... />` existant (ligne ~840-847), ajouter :

```vue
<!-- ── Résolution générique pré-calculée (non_overlapping, one_side_change, …) ── -->
<ResolutionPreviewPanel
  v-if="hunkForSegment(seg) && seg.hunkIndex != null && showResolutionPreviewFor(seg.hunkIndex, hunkForSegment(seg)!)"
  :resolved-lines="resolutions[seg.hunkIndex]!.resolvedLines!"
  :hunk-id="seg.hunkIndex"
  :explanation="hunkForSegment(seg)!.explanation"
  @accept="onPreviewAccept"
  @reject="onPreviewReject"
/>
```

- [ ] **Step 7: Masquer la barre d'actions classique quand le panneau est affiché**

Modifier la condition existante de la barre d'actions (ligne ~850) :

```vue
<!-- avant -->
<div class="inline-actions" v-if="hunkForSegment(seg) && editingHunkIndex !== seg.hunkIndex">

<!-- après -->
<div
  class="inline-actions"
  v-if="hunkForSegment(seg) && editingHunkIndex !== seg.hunkIndex && !showResolutionPreviewFor(seg.hunkIndex!, hunkForSegment(seg)!)"
>
```

- [ ] **Step 8: Relancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "panneau de résolution générique"`
Expected: PASS (4 tests).

- [ ] **Step 9: Lancer la suite complète du composant pour vérifier l'absence de régression**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts`
Expected: PASS — en particulier les tests `token_level_merge` et `baseEnriched` déjà livrés cette
session ne doivent pas régresser (leurs hunks restent exclus du nouveau panneau).

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue apps/desktop/src/components/__tests__/MergeEditor.test.ts
git commit -m "fix(desktop): apply the engine's real resolvedLines via ResolutionPreviewPanel, not a raw ours+theirs concat"
```

---

### Task 3: Modale récapitulative pour « Résoudre auto »

**Files:**
- Create: `apps/desktop/src/components/ResolveAutoSummaryModal.vue`
- Test: `apps/desktop/src/components/__tests__/ResolveAutoSummaryModal.test.ts`
- Modify: `apps/desktop/src/components/MergeEditor.vue`
  (bouton « Résoudre auto », ligne ~677-687)
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: `BaseModal.vue` (existant, `apps/desktop/src/components/BaseModal.vue`),
  `resolutions.value` (Task 2) filtré sur `autoResolved === true`.
- Produces: composant `ResolveAutoSummaryModal.vue` avec `props: { resolutions: Array<{
  hunkIndex: number; resolvedLines: string[] }> }`, `emits: { confirm: []; cancel: [] }`. Le clic
  sur « Résoudre auto » dans `MergeEditor.vue` ouvre la modale au lieu d'émettre `resolve`
  directement ; la confirmation dans la modale émet `resolve(file.path)` comme avant.

- [ ] **Step 1: Ajouter les clés i18n (référence : `fr.ts`, namespace `merge`, à côté de `resolveAuto`)**

Dans `apps/desktop/src/locales/fr.ts`, chercher `resolveAuto: "Résoudre auto",` (namespace
`merge`, autour de la ligne 716) et ajouter juste après :

```typescript
    resolveAutoSummaryTitle: "Résoudre automatiquement ce fichier ?",
    resolveAutoSummaryBody: "{0} conflit(s) seront résolus ainsi :",
    resolveAutoSummaryConfirm: "Confirmer",
    resolveAutoSummaryCancel: "Annuler",
```

- [ ] **Step 2: Ajouter les clés dans `en.ts`** (namespace `merge`, à côté de `resolveAuto`)

```typescript
    resolveAutoSummaryTitle: "Auto-resolve this file?",
    resolveAutoSummaryBody: "{0} conflict(s) will be resolved as follows:",
    resolveAutoSummaryConfirm: "Confirm",
    resolveAutoSummaryCancel: "Cancel",
```

- [ ] **Step 3: Ajouter les clés dans `es.ts`**

```typescript
    resolveAutoSummaryTitle: "¿Resolver este archivo automáticamente?",
    resolveAutoSummaryBody: "Se resolverán {0} conflicto(s) así:",
    resolveAutoSummaryConfirm: "Confirmar",
    resolveAutoSummaryCancel: "Cancelar",
```

- [ ] **Step 4: Ajouter les clés dans `pt-BR.ts`**

```typescript
    resolveAutoSummaryTitle: "Resolver este arquivo automaticamente?",
    resolveAutoSummaryBody: "{0} conflito(s) serão resolvidos assim:",
    resolveAutoSummaryConfirm: "Confirmar",
    resolveAutoSummaryCancel: "Cancelar",
```

- [ ] **Step 5: Ajouter les clés dans `zh-CN.ts`**

```typescript
    resolveAutoSummaryTitle: "自动解决此文件？",
    resolveAutoSummaryBody: "将按以下方式解决 {0} 个冲突：",
    resolveAutoSummaryConfirm: "确认",
    resolveAutoSummaryCancel: "取消",
```

- [ ] **Step 6: Écrire le test du composant**

```typescript
// apps/desktop/src/components/__tests__/ResolveAutoSummaryModal.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import ResolveAutoSummaryModal from "../ResolveAutoSummaryModal.vue";

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(ResolveAutoSummaryModal, {
    resolutions: [
      { hunkIndex: 0, resolvedLines: ["line1-changed", "line2-changed"] },
      { hunkIndex: 2, resolvedLines: ["foo = 2"] },
    ],
    ...props,
  });
  app.mount(container);
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { app?.unmount(); app = null; container?.remove(); });

describe("ResolveAutoSummaryModal", () => {
  it("liste chaque résolution avec son contenu", () => {
    mount({});
    expect(container.textContent).toContain("line1-changed");
    expect(container.textContent).toContain("foo = 2");
  });

  it("affiche le nombre de conflits dans le titre/corps", () => {
    mount({});
    expect(container.textContent).toContain("2");
  });

  it("émet confirm au clic sur Confirmer", async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    container.querySelector<HTMLButtonElement>(".bm-btn--primary")!.click();
    await nextTick();
    expect(onConfirm).toHaveBeenCalled();
  });

  it("émet cancel au clic sur Annuler", async () => {
    const onCancel = vi.fn();
    mount({ onCancel });
    container.querySelector<HTMLButtonElement>(".bm-btn--ghost")!.click();
    await nextTick();
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/ResolveAutoSummaryModal.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 8: Implémenter le composant**

```vue
<!-- apps/desktop/src/components/ResolveAutoSummaryModal.vue -->
<script setup lang="ts">
import { useI18n } from "@/composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = defineProps<{
  resolutions: Array<{ hunkIndex: number; resolvedLines: string[] }>;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const { t } = useI18n();
</script>

<template>
  <BaseModal :title="t('merge.resolveAutoSummaryTitle')" size="md" role="dialog" @close="emit('cancel')">
    <p class="rasm-body">{{ t('merge.resolveAutoSummaryBody', props.resolutions.length) }}</p>
    <div class="rasm-list">
      <div v-for="r in props.resolutions" :key="r.hunkIndex" class="rasm-item">
        <pre class="rasm-preview">{{ r.resolvedLines.join('\n') }}</pre>
      </div>
    </div>
    <template #footer>
      <button class="bm-btn bm-btn--ghost" @click="emit('cancel')">
        {{ t('merge.resolveAutoSummaryCancel') }}
      </button>
      <button class="bm-btn bm-btn--primary" @click="emit('confirm')">
        {{ t('merge.resolveAutoSummaryConfirm') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.rasm-body {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.rasm-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.rasm-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.rasm-preview {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 8px;
  margin: 0;
  overflow-x: auto;
}
</style>
```

- [ ] **Step 9: Relancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/ResolveAutoSummaryModal.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Câbler la modale dans `MergeEditor.vue`**

Ajouter l'import lazy (règle P1.2, à côté des autres `defineAsyncComponent` du fichier s'il y en
a, sinon en haut du `<script setup>`) :

```typescript
import { defineAsyncComponent } from "vue"; // si pas déjà importé
const ResolveAutoSummaryModal = defineAsyncComponent(() => import("./ResolveAutoSummaryModal.vue"));
```

Ajouter l'état réactif à côté des autres refs de `MergeEditor.vue` :

```typescript
const showResolveAutoSummary = ref(false);

const autoResolutionsSummary = computed(() =>
  resolutions.value
    .map((r, hunkIndex) => ({ hunkIndex, resolvedLines: r.resolvedLines, autoResolved: r.autoResolved }))
    .filter((r) => r.autoResolved && r.resolvedLines !== null) as Array<{ hunkIndex: number; resolvedLines: string[] }>,
);

function confirmResolveAuto() {
  showResolveAutoSummary.value = false;
  emit("resolve", props.file.path);
}
```

Modifier le bouton existant (ligne ~677-687) :

```vue
<!-- avant -->
<button
  v-if="canResolve"
  class="btn btn--resolve"
  @click="emit('resolve', file.path)"
  :aria-label="t('merge.resolveAutoLabel')"
>

<!-- après -->
<button
  v-if="canResolve"
  class="btn btn--resolve"
  @click="showResolveAutoSummary = true"
  :aria-label="t('merge.resolveAutoLabel')"
>
```

Ajouter la modale en fin de template, à côté des autres éléments de fin de composant :

```vue
<ResolveAutoSummaryModal
  v-if="showResolveAutoSummary"
  :resolutions="autoResolutionsSummary"
  @confirm="confirmResolveAuto"
  @cancel="showResolveAutoSummary = false"
/>
```

- [ ] **Step 11: Écrire le test d'intégration**

Ajouter dans `MergeEditor.test.ts` :

```typescript
describe("MergeEditor : modale récapitulative Résoudre auto", () => {
  it("ouvre la modale au clic sur Résoudre auto, n'émet pas resolve immédiatement", async () => {
    let resolved = false;
    mountDirect(nonOverlappingFile(), { onResolve: () => { resolved = true; } });
    container.querySelector<HTMLButtonElement>(".btn--resolve")!.click();
    await nextTick();
    expect(resolved).toBe(false);
    expect(container.textContent).toContain("line1-changed");
  });

  it("émet resolve après confirmation dans la modale", async () => {
    let resolvedPath: string | null = null;
    mountDirect(nonOverlappingFile(), { onResolve: (p: string) => { resolvedPath = p; } });
    container.querySelector<HTMLButtonElement>(".btn--resolve")!.click();
    await nextTick();
    container.querySelector<HTMLButtonElement>(".bm-btn--primary")!.click();
    await nextTick();
    expect(resolvedPath).toBe("src/config.ts");
  });
});
```

- [ ] **Step 12: Lancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "modale récapitulative"`
Expected: PASS (2 tests). Si le sélecteur `.btn--resolve` ne matche rien, vérifier la classe
exacte du bouton dans le template actuel (ligne ~679, `class="btn btn--resolve"`) avant
d'ajuster le test plutôt que le composant.

- [ ] **Step 13: Lancer la suite complète du composant**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/desktop/src/components/ResolveAutoSummaryModal.vue apps/desktop/src/components/__tests__/ResolveAutoSummaryModal.test.ts apps/desktop/src/components/MergeEditor.vue apps/desktop/src/components/__tests__/MergeEditor.test.ts apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): confirm 'Résoudre auto' with a per-hunk summary before applying"
```

---

### Task 4: Vérification de bout en bout

**Files:** aucun changement de code — vérification uniquement.

- [ ] **Step 1: Type-check complet**

Run: `cd apps/desktop && ./node_modules/.bin/vue-tsc --noEmit`
Expected: exit code 0, aucune erreur.

- [ ] **Step 2: Suite complète `apps/desktop`**

Run: `cd apps/desktop && pnpm test`
Expected: PASS, aucune régression (en particulier les hunks `llm_proposed`, `token_level_merge`
et `complex` doivent conserver leur comportement inchangé — seuls les types déjà auto-résolus
textuellement passent par le nouveau panneau).

- [ ] **Step 3: Confirmer qu'aucun autre point d'entrée ne contourne le nouveau panneau**

Run: `grep -rn "resolveHunkManual\|resolveHunkWithMemory" apps/desktop/src --include=*.vue --include=*.ts | grep -v __tests__`

Vérifier que chaque appel restant (raccourci clavier, action de sidebar, etc.) ne s'applique
qu'à des hunks `complex` dans le flux réel — sinon, envisager d'ajouter le même garde
`showResolutionPreviewFor` à ce point d'entrée avant de merger.

- [ ] **Step 4: Vérification manuelle (si un navigateur est disponible sans conflit de port)**

Ouvrir un repo réel avec un conflit `non_overlapping` (ou tout autre type auto-résolu). Vérifier :
- Le panneau de prévisualisation s'affiche avec le contenu fusionné exact, pas la barre
  d'actions classique.
- Cliquer « Accepter » applique bien ce contenu (comparer avec ce que « Résoudre auto » aurait
  produit — doivent être identiques).
- Le bouton « Résoudre auto » ouvre la modale récapitulative avant d'appliquer quoi que ce soit.
- Un hunk `complex` garde son affichage inchangé (barre d'actions classique).

Si aucun navigateur isolé n'est disponible (port déjà utilisé par une autre session), documenter
cette limitation plutôt que de la contourner en modifiant la configuration du projet.
