# Design — Modale « changements non commités au changement de branche »

Date : 2026-06-22
Branche de travail : `feat/move-changes-on-branch-switch`

## Contexte

Quand l'utilisateur a des fichiers modifiés (working tree sale) et déclenche un
changement de branche, le comportement actuel de GitWand est implicite :

- **Switch vers une branche existante** → géré par le réglage `switchBehavior`
  (`ask` / `refuse` / `stash`). Le mode `ask` affiche aujourd'hui un simple
  `askConfirm` « Discard changes? » (App.vue:957-969).
- **Création de branche** (`createBranch`) → appelle `gitCreateBranch(..., checkout=true)`
  soit `git checkout -b`, qui **emporte silencieusement** les changements sur la
  nouvelle branche, sans aucune confirmation (useGitRepo.ts:1020).

À l'instar des clients concurrents (GitKraken, Fork, Sublime Merge), on veut
remplacer ce comportement implicite par une **décision explicite** : une modale
qui propose à l'utilisateur d'emporter ses changements ou de les commiter d'abord.

## Objectif

Présenter une modale claire, déclenchée quand le tree est sale au moment d'un
switch ou d'une création de branche, offrant deux actions explicites + annuler.

## Déclencheur

La modale s'affiche quand **les deux** conditions sont réunies :

1. `isDirty()` est vrai (staged + unstaged + untracked > 0), et
2. `settings.switchBehavior === "ask"`

…sur **deux** chemins d'entrée :

1. **Switch** vers une branche existante — `handleSwitchBranch(name)` (App.vue:909)
2. **Création** de branche — nouveau `handleCreateBranch(name)` enveloppant
   `createBranch` (scénario « je suis sur main, je crée une branche »)

Les autres modes du réglage restent **strictement inchangés** :

- `refuse` → bloque avec `branches.switchRefusedDirty` (comportement actuel)
- `stash` → flux stash modal existant (`pendingSwitchBranch` + `confirmSwitchStash`)

La modale **remplace uniquement** la branche `ask` du `handleSwitchBranch`, et
**ajoute** la garde équivalente sur le chemin de création de branche (qui n'en
avait aucune).

## La modale — `BranchDirtySwitchModal.vue`

Nouveau composant, `<script setup>` (Composition API), construit sur `BaseModal`.

### Props

| Prop | Type | Rôle |
|---|---|---|
| `targetBranch` | `string` | Nom de la branche cible (affiché en évidence) |
| `isCreate` | `boolean` | `true` si on crée la branche, `false` si switch existant (ajuste le wording) |
| `files` | `{ path: string; kind: 'staged' \| 'unstaged' \| 'untracked' }[]` | Fichiers concernés, dérivés de `repoStatus` |

### Emits

| Event | Déclenché par |
|---|---|
| `carry` | Bouton « Emporter les changements » |
| `commit-first` | Bouton « Commiter d'abord » |
| `close` | Bouton Annuler / Escape / backdrop |

### Contenu

- Titre + sous-titre rappelant la branche cible et le nombre de fichiers.
- Liste compacte des fichiers concernés (chemin + petit badge de type). Pas de
  diff, pas de sélection par fichier — c'est une décision globale.
- Footer avec les boutons (voir ci-dessous).

### Actions

| Bouton | Style | Effet |
|---|---|---|
| **Emporter les changements** | `bm-btn--primary` | Émet `carry`. App.vue appelle `switchBranch(name)` ou `createBranch(name)` (comportement natif git : les fichiers suivent). En cas d'échec git (un fichier modifié diffère entre les deux branches → checkout refusé), affiche un **message d'erreur clair** et **reste sur la branche actuelle**. |
| **Commiter d'abord** | `bm-btn` (ghost/secondaire) | Émet `commit-first`. App.vue **ne bascule pas** : ferme la modale et fait `viewMode.value = "changes"` pour amener l'utilisateur sur la vue Changes afin qu'il commite sur la **branche en cours**. Il re-déclenchera le switch ensuite. |
| **Annuler** | `bm-btn--ghost` | Émet `close`. Aucun effet, reste sur la branche actuelle. |

## Câblage dans App.vue

### Nouvel état

```ts
const pendingDirtySwitch = ref<{ name: string; isCreate: boolean } | null>(null);
```

Plus un computed exposant la liste de fichiers pour la modale, dérivé de
`repoStatus.value` (mappe staged/unstaged/untracked vers `{ path, kind }`).

### `handleSwitchBranch` — branche `ask`

Remplacer le bloc `if (behavior === "ask") { askConfirm(...) }` (App.vue:957-969)
par :

```ts
if (behavior === "ask") {
  pendingDirtySwitch.value = { name, isCreate: false };
  return;
}
```

### Nouveau `handleCreateBranch`

Le template branche actuellement `@create-branch="createBranch"` (App.vue:2370).
On introduit un `handleCreateBranch(name)` qui applique la même garde :

```ts
async function handleCreateBranch(name: string) {
  if (!repoFolderPath.value) return;
  const behavior = settings.value.switchBehavior;
  if (isDirty() && behavior === "ask") {
    pendingDirtySwitch.value = { name, isCreate: true };
    return;
  }
  if (isDirty() && behavior === "refuse") {
    repoError.value = t("branches.switchRefusedDirty");
    return;
  }
  // stash mode + clean tree → comportement direct existant
  await createBranch(name);
}
```

Et brancher `@create-branch="handleCreateBranch"`.

> Note : en mode `stash`, la création de branche conserve le comportement
> historique (carry direct via `checkout -b`). Le flux stash modal ne couvre que
> le switch existant ; on ne l'étend pas ici (YAGNI).

### Handlers de confirmation

```ts
async function confirmDirtyCarry() {
  const pending = pendingDirtySwitch.value;
  if (!pending) return;
  pendingDirtySwitch.value = null;
  try {
    if (pending.isCreate) await createBranch(pending.name);
    else await switchBranch(pending.name);
    await promptPullIfBehind(); // switch existant uniquement (no-op si create)
  } catch (err: any) {
    repoError.value = t("branches.dirtySwitchCarryFailed", err.message);
  }
}

function confirmDirtyCommitFirst() {
  pendingDirtySwitch.value = null;
  viewMode.value = "changes";
}
```

> Détail d'implémentation : `switchBranch`/`createBranch` (useGitRepo) capturent
> aujourd'hui leurs erreurs dans `error.value` sans relancer. Pour que
> `confirmDirtyCarry` puisse afficher un message dédié au carry, le plan devra
> soit les faire relancer/retourner un booléen de succès, soit lire l'erreur
> exposée par le composable après l'appel. Le plan tranchera la mécanique exacte
> en préservant le comportement actuel des autres appelants.

### Template

Ajouter en fin de template (zone des modales) :

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

Le composant est conditionné par un `v-if` sur un flag par défaut faux → il doit
être **lazy-loadé** via `defineAsyncComponent(() => import(...))` (invariant perf
P1.2 du CLAUDE.md desktop).

## i18n

Nouvelles clés sous `branches.` dans les **5** fichiers de locale
(`en`, `fr`, `es`, `pt-BR`, `zh-CN`) :

| Clé | EN (référence) |
|---|---|
| `branches.dirtySwitchTitle` | "Uncommitted changes" |
| `branches.dirtySwitchSwitchHint` | "You have uncommitted changes. Bring them along to « {0} », or commit them on the current branch first." |
| `branches.dirtySwitchCreateHint` | "You have uncommitted changes. Bring them onto the new branch « {0} », or commit them on the current branch first." |
| `branches.dirtySwitchCarry` | "Bring changes along" |
| `branches.dirtySwitchCommitFirst` | "Commit first" |
| `branches.dirtySwitchCarryFailed` | "Couldn't bring your changes: they conflict with the target branch. Commit or stash them first. ({0})" |
| `branches.dirtySwitchFilesLabel` | "Affected files" (+ pluriel si besoin) |

(libellés exacts ajustables à l'implémentation ; le `i18n-sync` skill peut aider.)

## Hors périmètre (YAGNI)

- Pas de nouvelle commande Rust, pas de wrapper `backend.ts`, pas de route
  `dev-server.mjs` — le carry réutilise `switchBranch`/`createBranch` existants.
- Pas de sélection par fichier (décision globale uniquement).
- Pas d'option « Discard » dans cette modale (le mode `ask` actuel l'avait via
  un confirm ; on le remplace volontairement par carry + commit-first).
- Pas de stash auto en cas d'échec de carry (choix : message d'erreur clair).
- Pas d'extension du flux stash à la création de branche.

## Tests

- Test unitaire sur la logique de décision : tree sale + mode `ask` → ouvre la
  modale (état `pendingDirtySwitch` posé) ; modes `refuse` / `stash` → conservent
  leur comportement ; tree propre → switch/create direct.
- Conformément à AGENTS.md, ne pas mocker la couche git : si un test touche un
  vrai switch, monter un repo git temporaire.
- Vérifier visuellement en `pnpm dev:web` (mock backend) les deux scénarios
  (switch existant + create depuis main) et le message d'échec de carry.

## Fichiers touchés (récap)

- `apps/desktop/src/components/BranchDirtySwitchModal.vue` — **nouveau**
- `apps/desktop/src/App.vue` — état, handlers, lazy import, template, binding `@create-branch`
- `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` — clés `branches.dirtySwitch*`
- (tests) `apps/desktop/src/**/__tests__/` selon le découpage du plan
