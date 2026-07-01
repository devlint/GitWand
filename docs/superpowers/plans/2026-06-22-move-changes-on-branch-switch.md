# Move-Changes-on-Branch-Switch Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the working tree is dirty and the user switches to an existing branch or creates a new one (in `ask` mode), show a modal offering to *bring the changes along* (native git carry) or *commit them first* on the current branch.

**Architecture:** Frontend-only. A pure decision helper (`branchSwitchDecision.ts`) decides, from `(dirty, switchBehavior)`, whether to open the modal / refuse / proceed directly. A new lazy-loaded `BranchDirtySwitchModal.vue` (built on `BaseModal`) renders the choice. `App.vue` holds a `pendingDirtySwitch` ref, wires both the switch and the create-branch paths through the helper, and on confirm calls the existing `switchBranch` / `createBranch` composable functions (which already run `git checkout` / `git checkout -b`, natively carrying changes and erroring on conflict). No Rust, `backend.ts`, or `dev-server.mjs` changes.

**Tech Stack:** Vue 3 `<script setup>` (Composition API), TypeScript, Vitest (jsdom), Tauri (unchanged).

## Global Constraints

- Package manager: **pnpm only**.
- New component conditioned by a default-false `v-if` MUST be lazy-loaded via `defineAsyncComponent(() => import(...))` (perf invariant P1.2).
- `<script setup>` Composition API only — no Options API.
- Every user-visible string MUST exist in **all 5** locale files: `en`, `fr`, `es`, `pt-BR`, `zh-CN`. Never hardcode UI text.
- `BaseModal` button base class `.bm-btn` must stay at specificity `(0,1,0)` — never prefix it with an ancestor selector.
- Do not mock the git layer in tests; spin up a real temp repo if a test exercises a real switch.
- Modes `refuse` and `stash` of `switchBehavior` must remain behaviorally unchanged. The modal replaces only the `ask` branch of `handleSwitchBranch`, and adds an equivalent guard to the (previously unguarded) create-branch path.

---

### Task 1: Pure decision helper

**Files:**
- Create: `apps/desktop/src/utils/branchSwitchDecision.ts`
- Test: `apps/desktop/src/utils/__tests__/branchSwitchDecision.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SwitchBehavior = "ask" | "refuse" | "stash"` and `function resolveDirtySwitchAction(dirty: boolean, behavior: SwitchBehavior): "modal" | "refuse" | "direct"`.
  - `dirty === false` → `"direct"` (regardless of behavior).
  - `dirty && behavior === "ask"` → `"modal"`.
  - `dirty && behavior === "refuse"` → `"refuse"`.
  - `dirty && behavior === "stash"` → `"direct"` (the caller keeps its existing stash-or-carry handling; the helper does not open the new modal for stash mode).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/utils/__tests__/branchSwitchDecision.test.ts
import { describe, it, expect } from "vitest";
import { resolveDirtySwitchAction } from "../branchSwitchDecision";

describe("resolveDirtySwitchAction", () => {
  it("clean tree always switches directly", () => {
    expect(resolveDirtySwitchAction(false, "ask")).toBe("direct");
    expect(resolveDirtySwitchAction(false, "refuse")).toBe("direct");
    expect(resolveDirtySwitchAction(false, "stash")).toBe("direct");
  });

  it("dirty + ask opens the modal", () => {
    expect(resolveDirtySwitchAction(true, "ask")).toBe("modal");
  });

  it("dirty + refuse refuses", () => {
    expect(resolveDirtySwitchAction(true, "refuse")).toBe("refuse");
  });

  it("dirty + stash does not open the new modal (caller keeps stash flow)", () => {
    expect(resolveDirtySwitchAction(true, "stash")).toBe("direct");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/branchSwitchDecision.test.ts`
Expected: FAIL — cannot resolve module `../branchSwitchDecision`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/utils/branchSwitchDecision.ts

/** The three behaviors a user can set for switching with a dirty working tree. */
export type SwitchBehavior = "ask" | "refuse" | "stash";

/**
 * Decide what to do when the user triggers a branch switch / create.
 *
 * - "direct"  → proceed with the switch/create (clean tree, or stash mode which
 *               the caller handles with its own existing flow).
 * - "modal"   → open the BranchDirtySwitchModal (dirty + ask).
 * - "refuse"  → block with an error (dirty + refuse).
 */
export function resolveDirtySwitchAction(
  dirty: boolean,
  behavior: SwitchBehavior,
): "modal" | "refuse" | "direct" {
  if (!dirty) return "direct";
  if (behavior === "ask") return "modal";
  if (behavior === "refuse") return "refuse";
  return "direct";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/branchSwitchDecision.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/branchSwitchDecision.ts apps/desktop/src/utils/__tests__/branchSwitchDecision.test.ts
git commit -m "feat(branches): pure decision helper for dirty branch switch"
```

---

### Task 2: i18n keys in all 5 locales

**Files:**
- Modify: `apps/desktop/src/locales/en.ts` (after `switchStashConfirm`, line ~493)
- Modify: `apps/desktop/src/locales/fr.ts` (after `switchStashConfirm`, line ~486)
- Modify: `apps/desktop/src/locales/es.ts` (after `switchStashConfirm`, line ~479)
- Modify: `apps/desktop/src/locales/pt-BR.ts` (after `switchStashConfirm`, line ~480)
- Modify: `apps/desktop/src/locales/zh-CN.ts` (after `switchStashConfirm`, line ~476)

**Interfaces:**
- Consumes: nothing.
- Produces: keys under `branches.`: `dirtySwitchTitle`, `dirtySwitchSwitchHint`, `dirtySwitchCreateHint`, `dirtySwitchFilesLabel`, `dirtySwitchCarry`, `dirtySwitchCommitFirst`, `dirtySwitchCarryFailed`, `dirtySwitchCancel`. All hint/failed strings take `{0}`.

- [ ] **Step 1: Add keys to `en.ts`**

Insert immediately after the `switchStashConfirm: "...",` line inside the `branches:` object:

```typescript
    dirtySwitchTitle: "Uncommitted changes",
    dirtySwitchSwitchHint: "You have uncommitted changes. Bring them along to « {0} », or commit them on the current branch first.",
    dirtySwitchCreateHint: "You have uncommitted changes. Bring them onto the new branch « {0} », or commit them on the current branch first.",
    dirtySwitchFilesLabel: "Affected files",
    dirtySwitchCarry: "Bring changes along",
    dirtySwitchCommitFirst: "Commit first",
    dirtySwitchCancel: "Cancel",
    dirtySwitchCarryFailed: "Couldn’t bring your changes — they conflict with the target branch. Commit or stash them first. ({0})",
```

- [ ] **Step 2: Add keys to `fr.ts`**

```typescript
    dirtySwitchTitle: "Modifications non commitées",
    dirtySwitchSwitchHint: "Vous avez des modifications non commitées. Emportez-les vers « {0} », ou commitez-les d’abord sur la branche actuelle.",
    dirtySwitchCreateHint: "Vous avez des modifications non commitées. Emportez-les sur la nouvelle branche « {0} », ou commitez-les d’abord sur la branche actuelle.",
    dirtySwitchFilesLabel: "Fichiers concernés",
    dirtySwitchCarry: "Emporter les changements",
    dirtySwitchCommitFirst: "Commiter d’abord",
    dirtySwitchCancel: "Annuler",
    dirtySwitchCarryFailed: "Impossible d’emporter vos modifications — elles sont en conflit avec la branche cible. Commitez ou stashez-les d’abord. ({0})",
```

- [ ] **Step 3: Add keys to `es.ts`**

```typescript
    dirtySwitchTitle: "Cambios sin confirmar",
    dirtySwitchSwitchHint: "Tienes cambios sin confirmar. Llévalos a « {0} », o confírmalos primero en la rama actual.",
    dirtySwitchCreateHint: "Tienes cambios sin confirmar. Llévalos a la nueva rama « {0} », o confírmalos primero en la rama actual.",
    dirtySwitchFilesLabel: "Archivos afectados",
    dirtySwitchCarry: "Llevar los cambios",
    dirtySwitchCommitFirst: "Confirmar primero",
    dirtySwitchCancel: "Cancelar",
    dirtySwitchCarryFailed: "No se pudieron llevar tus cambios: entran en conflicto con la rama destino. Confírmalos o guárdalos en stash primero. ({0})",
```

- [ ] **Step 4: Add keys to `pt-BR.ts`**

```typescript
    dirtySwitchTitle: "Alterações não confirmadas",
    dirtySwitchSwitchHint: "Você tem alterações não confirmadas. Leve-as para « {0} », ou confirme-as primeiro na branch atual.",
    dirtySwitchCreateHint: "Você tem alterações não confirmadas. Leve-as para a nova branch « {0} », ou confirme-as primeiro na branch atual.",
    dirtySwitchFilesLabel: "Arquivos afetados",
    dirtySwitchCarry: "Levar as alterações",
    dirtySwitchCommitFirst: "Confirmar primeiro",
    dirtySwitchCancel: "Cancelar",
    dirtySwitchCarryFailed: "Não foi possível levar suas alterações — elas conflitam com a branch de destino. Confirme ou guarde-as no stash primeiro. ({0})",
```

- [ ] **Step 5: Add keys to `zh-CN.ts`**

```typescript
    dirtySwitchTitle: "未提交的更改",
    dirtySwitchSwitchHint: "你有未提交的更改。可将其带到「{0}」，或先在当前分支提交。",
    dirtySwitchCreateHint: "你有未提交的更改。可将其带到新分支「{0}」，或先在当前分支提交。",
    dirtySwitchFilesLabel: "受影响的文件",
    dirtySwitchCarry: "带上更改",
    dirtySwitchCommitFirst: "先提交",
    dirtySwitchCancel: "取消",
    dirtySwitchCarryFailed: "无法带走你的更改 — 它们与目标分支冲突。请先提交或储藏。({0})",
```

- [ ] **Step 6: Type-check (verifies all locales share the same key set)**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: No errors. (The `LocaleKey` type forces all 5 files to declare identical keys; a missing key in any file fails here.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(i18n): dirty-branch-switch modal strings (5 locales)"
```

---

### Task 3: `BranchDirtySwitchModal.vue` component

**Files:**
- Create: `apps/desktop/src/components/BranchDirtySwitchModal.vue`

**Interfaces:**
- Consumes: `BaseModal` (existing), `useI18n` (existing), the `branches.dirtySwitch*` keys (Task 2).
- Produces: a component with
  - Props: `targetBranch: string`, `isCreate: boolean`, `files: { path: string; kind: "staged" | "unstaged" | "untracked" }[]`.
  - Emits: `carry`, `commit-first`, `close`.

- [ ] **Step 1: Create the component**

```vue
<script setup lang="ts">
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{
  targetBranch: string;
  isCreate: boolean;
  files: { path: string; kind: "staged" | "unstaged" | "untracked" }[];
}>();

const emit = defineEmits<{
  (e: "carry"): void;
  (e: "commit-first"): void;
  (e: "close"): void;
}>();

const { t } = useI18n();
</script>

<template>
  <BaseModal
    :title="t('branches.dirtySwitchTitle')"
    size="sm"
    role="alertdialog"
    @close="emit('close')"
  >
    <p class="dsm-hint">
      {{ isCreate
        ? t('branches.dirtySwitchCreateHint', props.targetBranch)
        : t('branches.dirtySwitchSwitchHint', props.targetBranch) }}
    </p>

    <div v-if="files.length" class="dsm-files">
      <div class="dsm-files__label">{{ t('branches.dirtySwitchFilesLabel') }} ({{ files.length }})</div>
      <ul class="dsm-files__list">
        <li v-for="f in files" :key="f.kind + ':' + f.path" class="dsm-files__item">
          <span class="dsm-files__badge" :class="`dsm-files__badge--${f.kind}`">{{ f.kind.charAt(0).toUpperCase() }}</span>
          <span class="dsm-files__path">{{ f.path }}</span>
        </li>
      </ul>
    </div>

    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost" @click="emit('close')">
        {{ t('branches.dirtySwitchCancel') }}
      </button>
      <button type="button" class="bm-btn" @click="emit('commit-first')">
        {{ t('branches.dirtySwitchCommitFirst') }}
      </button>
      <button type="button" class="bm-btn bm-btn--primary" @click="emit('carry')">
        {{ t('branches.dirtySwitchCarry') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.dsm-hint {
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  line-height: 1.5;
}
.dsm-files__label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}
.dsm-files__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsm-files__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
}
.dsm-files__badge {
  flex: none;
  width: 1.1rem;
  height: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 0.65rem;
  font-weight: 700;
  color: #fff;
}
.dsm-files__badge--staged { background: var(--accent, #2ea043); }
.dsm-files__badge--unstaged { background: var(--warning, #d29922); }
.dsm-files__badge--untracked { background: var(--text-muted, #6e7681); }
.dsm-files__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
```

- [ ] **Step 2: Type-check the new component**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: No errors.

> Note: If `var(--accent)` / `var(--warning)` / `var(--text-muted)` tokens are not defined in the theme, the fallback hex values render. Confirm visually in Task 5.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/BranchDirtySwitchModal.vue
git commit -m "feat(branches): BranchDirtySwitchModal component"
```

---

### Task 4: Wire App.vue + return booleans from composable

**Files:**
- Modify: `apps/desktop/src/composables/useGitRepo.ts` (`switchBranch` ~1031-1049, `createBranch` ~1020-1029)
- Modify: `apps/desktop/src/App.vue` (lazy import block ~27-33; `handleSwitchBranch` ~909-974; create-branch binding ~2370; new state + handlers near the other branch handlers; modal template near the existing stash overlay ~2750)

**Interfaces:**
- Consumes: `resolveDirtySwitchAction`, `SwitchBehavior` (Task 1); `BranchDirtySwitchModal` (Task 3); `branches.dirtySwitch*` keys (Task 2).
- Produces (composable): `switchBranch(name: string): Promise<boolean>` and `createBranch(name: string): Promise<boolean>` — `true` on success, `false` if the operation set an error. Existing call sites ignore the return value, so this is non-breaking.
- Produces (App.vue): `pendingDirtySwitch` ref, `pendingDirtySwitchFiles` computed, `handleCreateBranch(name)`, `confirmDirtyCarry()`, `confirmDirtyCommitFirst()`.

- [ ] **Step 1: Make `createBranch` return a boolean**

In `useGitRepo.ts`, replace the body of `createBranch`:

```typescript
  async function createBranch(name: string): Promise<boolean> {
    if (!folderPath.value) return false;
    try {
      await gitCreateBranch(folderPath.value, name, true);
      await refresh();
      await loadBranches();
      return true;
    } catch (err: any) {
      error.value = `create branch: ${err.message}`;
      return false;
    }
  }
```

- [ ] **Step 2: Make `switchBranch` return a boolean**

Replace the body of `switchBranch`:

```typescript
  async function switchBranch(name: string): Promise<boolean> {
    if (!folderPath.value) return false;
    isSwitchingBranch.value = true;
    try {
      await gitSwitchBranch(folderPath.value, name);
      forcePushPreferred.value = false;
      await refresh();
      await loadBranches();
      await loadWorktrees();
      return true;
    } catch (err: any) {
      if (err.message?.includes("already used by worktree")) {
        error.value = t("branches.switchWorktree");
      } else {
        error.value = `switch branch: ${err.message}`;
      }
      return false;
    } finally {
      isSwitchingBranch.value = false;
    }
  }
```

- [ ] **Step 3: Lazy-import the modal in App.vue**

In the `defineAsyncComponent` block (near line 27), add:

```typescript
const BranchDirtySwitchModal = defineAsyncComponent(() => import("./components/BranchDirtySwitchModal.vue"));
```

Also import the helper near the other util imports:

```typescript
import { resolveDirtySwitchAction } from "./utils/branchSwitchDecision";
```

- [ ] **Step 4: Add state + computed (near the other branch handlers, e.g. after `isDirty`)**

```typescript
const pendingDirtySwitch = ref<{ name: string; isCreate: boolean } | null>(null);

const pendingDirtySwitchFiles = computed(() => {
  const s = repoStatus.value;
  if (!s) return [] as { path: string; kind: "staged" | "unstaged" | "untracked" }[];
  return [
    ...s.staged.map((f) => ({ path: f.path, kind: "staged" as const })),
    ...s.unstaged.map((f) => ({ path: f.path, kind: "unstaged" as const })),
    ...s.untracked.map((path) => ({ path, kind: "untracked" as const })),
  ];
});
```

- [ ] **Step 5: Replace the `ask` branch of `handleSwitchBranch`**

Replace the whole `if (behavior === "ask") { ... }` block (currently App.vue:957-969) with:

```typescript
  if (behavior === "ask") {
    pendingDirtySwitch.value = { name, isCreate: false };
    return;
  }
```

(Leave the `refuse`, `stash`, clean-tree, and fallback branches untouched.)

- [ ] **Step 6: Add `handleCreateBranch` (near `handleSwitchBranch`)**

```typescript
async function handleCreateBranch(name: string) {
  if (!repoFolderPath.value) return;
  const action = resolveDirtySwitchAction(isDirty(), settings.value.switchBehavior);
  if (action === "modal") {
    pendingDirtySwitch.value = { name, isCreate: true };
    return;
  }
  if (action === "refuse") {
    repoError.value = t("branches.switchRefusedDirty");
    return;
  }
  // "direct": clean tree, or stash mode (keep historic checkout -b carry behavior)
  await createBranch(name);
}
```

- [ ] **Step 7: Add the confirm handlers (near `confirmSwitchStash`, ~1812)**

```typescript
async function confirmDirtyCarry() {
  const pending = pendingDirtySwitch.value;
  if (!pending) return;
  pendingDirtySwitch.value = null;
  const ok = pending.isCreate
    ? await createBranch(pending.name)
    : await switchBranch(pending.name);
  if (!ok) {
    // switchBranch/createBranch already set repoError to the underlying git error;
    // wrap it in a clear carry-specific message.
    repoError.value = t("branches.dirtySwitchCarryFailed", repoError.value ?? "");
    return;
  }
  if (!pending.isCreate) await promptPullIfBehind();
}

function confirmDirtyCommitFirst() {
  pendingDirtySwitch.value = null;
  viewMode.value = "changes";
}
```

- [ ] **Step 8: Update the create-branch binding in the template**

At App.vue:2370, change `@create-branch="createBranch"` to `@create-branch="handleCreateBranch"`.

- [ ] **Step 9: Add the modal to the template (near the existing stash overlay, ~2750)**

```html
    <BranchDirtySwitchModal
      v-if="pendingDirtySwitch"
      :target-branch="pendingDirtySwitch.name"
      :is-create="pendingDirtySwitch.isCreate"
      :files="pendingDirtySwitchFiles"
      @carry="confirmDirtyCarry"
      @commit-first="confirmDirtyCommitFirst"
      @close="pendingDirtySwitch = null"
    />
```

- [ ] **Step 10: Type-check + run the full unit suite**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit && pnpm vitest run src/utils/__tests__/branchSwitchDecision.test.ts`
Expected: No type errors; 4 tests pass.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/composables/useGitRepo.ts apps/desktop/src/App.vue
git commit -m "feat(branches): dirty-switch modal wiring (carry / commit-first) for switch + create"
```

---

### Task 5: Manual verification in dev:web

**Files:** none (verification only).

- [ ] **Step 1: Start the web dev server**

Run: `cd apps/desktop && pnpm dev:web`
Open the served URL; open a repo with the mock backend.

- [ ] **Step 2: Verify settings precondition**

Ensure `switchBehavior` is set to `ask` (Settings panel). With a clean tree, switching a branch must still switch directly (no modal).

- [ ] **Step 3: Switch scenario**

Make a change so the tree is dirty. Trigger a switch to an existing branch.
Expected: `BranchDirtySwitchModal` appears, titled "Uncommitted changes", showing the target branch in the hint and the affected files list.
- Click **Bring changes along** → switches, working changes follow (when no conflict).
- Re-dirty, trigger switch, click **Commit first** → modal closes, view switches to Changes.
- Re-dirty, trigger switch, click **Cancel** → modal closes, stays on current branch.

- [ ] **Step 4: Create scenario**

On the base branch with a dirty tree, create a new branch.
Expected: modal appears with the create hint ("Bring them onto the new branch …"). **Bring changes along** creates the branch carrying the changes.

- [ ] **Step 5: Carry-failure message (best-effort)**

If the mock backend can simulate a checkout conflict, confirm the `dirtySwitchCarryFailed` banner appears and the branch does not change. (If not reproducible in dev:web, note it for the verifier to check against the real Tauri backend.)

- [ ] **Step 6: Regression — other modes untouched**

Set `switchBehavior` to `refuse`: dirty switch shows the refuse error, no modal. Set to `stash`: dirty switch shows the existing stash-message overlay, no new modal.

---

## Self-Review

**Spec coverage:**
- Trigger (dirty + ask, switch + create) → Tasks 1, 4 (steps 5–6).
- Modal with 2 actions + cancel, target branch + file list → Task 3.
- Carry via native git + clear error on failure → Task 4 (steps 1–2, 7).
- Commit-first → Changes view → Task 4 (step 7).
- `refuse`/`stash` unchanged → Task 4 (steps 5–6) + Task 5 (step 6).
- Lazy load → Task 4 (step 3). i18n 5 locales → Task 2. Frontend-only (no Rust/backend.ts/dev-server) → respected throughout.

**Placeholder scan:** No TBD/TODO; all code steps contain full code; verification steps name exact expected behavior.

**Type consistency:** `resolveDirtySwitchAction(dirty, behavior)` / `SwitchBehavior` used consistently (Tasks 1, 4). `pendingDirtySwitch: { name, isCreate }` and `pendingDirtySwitchFiles: { path, kind }[]` match the modal's `files` prop and `targetBranch`/`isCreate` props (Tasks 3, 4). `switchBranch`/`createBranch` return `Promise<boolean>` consistently (Task 4 steps 1–2 vs step 7). Emit names `carry` / `commit-first` / `close` match the template bindings.
