# GitTree — Filtres rapides & séparateurs de date

**Date :** 2026-06-30
**Périmètre :** `apps/desktop` — `CommitGraph.vue`, `useGitRepo.ts`, locales

---

## Contexte

Le GitTree (composant `CommitGraph.vue`) manque de deux types de repères visuels :

1. Des **filtres rapides** accessibles en un clic pour ne voir que les commits de la branche courante ou ses propres commits.
2. Des **séparateurs de date** pour s'orienter temporellement dans l'historique.

`logAuthorFilter` ("mine") est déjà implémenté dans `useGitRepo.ts` mais n'a aucune UI. Le filtre "branche courante" est supporté par l'API (`all: boolean`, `branch?: string`) mais hardcodé à `all: true`.

---

## Feature 1 — Filtres rapides

### UI

Deux boutons icône SVG ajoutés dans `.cg-search-bar`, **avant** le `<input>` de recherche :

```
[ 🌿 ] [ 👤 ] [  Rechercher par id de commit...  ] [↑][↓][⊞][✕]
```

- **Bouton branche** : icône git-branch, toggle `"all" / "current"`
- **Bouton auteur** : icône user/person, toggle `"all" / "mine"`
- Classe de base : `.cg-filter-icon-btn` (même gabarit que `.cg-search-nav`)
- État actif : `.cg-filter-icon-btn--active` → `color: var(--color-accent)`, `background: var(--color-accent-soft)`
- `title` et `aria-label` via clés i18n
- Pas de label texte — icône seule, tooltip au hover

### Props ajoutées à CommitGraph.vue

```typescript
logBranchFilter: { type: String as PropType<"all" | "current">, default: "all" }
logAuthorFilter: { type: String as PropType<"all" | "mine">, default: "all" }
```

### Emits ajoutés à CommitGraph.vue

```typescript
"set-log-branch-filter": (filter: "all" | "current") => void
"set-log-author-filter": (filter: "all" | "mine") => void
```

Les boutons appellent directement `emit("set-log-branch-filter", newVal)` — CommitGraph ne gère pas l'état lui-même, il relaie vers App.vue.

### App.vue

Wire les deux emits vers les fonctions de `useGitRepo` :

```typescript
@set-log-branch-filter="setLogBranchFilter"
@set-log-author-filter="setLogAuthorFilter"
```

Passe les props :

```typescript
:log-branch-filter="logBranchFilter"
:log-author-filter="logAuthorFilter"
```

Expose `logBranchFilter` depuis la destructuration de `useGitRepo`.

### useGitRepo.ts

**Nouvel état :**

```typescript
const logBranchFilter = ref<"all" | "current">("all");
```

**Nouvelle fonction `setLogBranchFilter`** :

```typescript
async function setLogBranchFilter(filter: "all" | "current") {
  if (logBranchFilter.value === filter) return;
  logBranchFilter.value = filter;
  await loadLog();
}
```

**Modifications de `loadLog()` et `loadMoreLog()`** — quand `logBranchFilter === "current"` :
- Passe `all: false` (au lieu de `true`)
- Passe `branch: repoStatus.value?.branch ?? undefined`

Quand `logBranchFilter === "all"` : comportement actuel inchangé (`all: true`, `branch: undefined`).

**Exports depuis `useGitRepo`** : ajouter `logBranchFilter` et `setLogBranchFilter`.

### Cas limite

- Si `currentBranch` est null/undefined (repo detached HEAD), le filtre "branche courante" passe `all: false` sans `branch` — git log retourne l'historique depuis HEAD, ce qui est le comportement attendu.
- Quand les deux filtres sont actifs simultanément, ils se combinent : email auteur + branche courante passés ensemble à `getGitLog`.

---

## Feature 2 — Séparateurs de date

### Buckets

5 buckets, calculés par rapport à `Date.now()` au moment du rendu :

| Bucket | Condition | Label (FR) |
|--------|-----------|------------|
| `today` | < 24h | Aujourd'hui |
| `yesterday` | 24h–48h | Hier |
| `this-week` | 2–7 jours | Cette semaine |
| `this-month` | 7–30 jours | Ce mois-ci |
| `older` | > 30 jours | Plus ancien |

### Computed `dateSeparators`

Calculé depuis `displayCommits` (liste déjà filtrée/paginée) :

```typescript
const dateSeparators = computed(() => {
  const now = Date.now();
  const seps: { index: number; label: string }[] = [];
  let lastBucket = "";
  displayCommits.value.forEach((commit, i) => {
    const bucket = dateBucket(new Date(commit.date).getTime(), now);
    if (bucket !== lastBucket) {
      seps.push({ index: i, label: t(`log.dateSep${capitalize(bucket)}`) });
      lastBucket = bucket;
    }
  });
  return seps;
});
```

`dateBucket(ts, now)` retourne `"today" | "yesterday" | "thisWeek" | "thisMonth" | "older"` — fonction pure locale à CommitGraph.vue.

### Rendu

Dans `.cg-info` (le conteneur des lignes de commits absolument positionnées), **après** la boucle `v-for` des rows :

```html
<div
  v-for="sep in dateSeparators"
  :key="'sep-' + sep.index"
  class="cg-date-sep"
  :style="{ top: sep.index * ROW_H - 1 + 'px' }"
  aria-hidden="true"
>
  <span class="cg-date-sep-label">{{ sep.label }}</span>
</div>
```

**CSS (scoped)** :

```css
.cg-date-sep {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  pointer-events: none;
  z-index: 2;
  border-top: 1px solid var(--color-border);
  opacity: 0.35;
}

.cg-date-sep-label {
  position: absolute;
  right: 8px;
  top: -9px;
  font-size: 10px;
  line-height: 1;
  color: var(--color-muted);
  background: var(--color-bg);
  padding: 0 4px;
  white-space: nowrap;
  pointer-events: none;
}
```

### Performance

`dateSeparators` est un `computed()` qui dépend de `displayCommits` — recalculé uniquement quand les commits changent. Complexité O(n) sur la liste visible. Aucun changement dans `dagLayout.ts`.

### Viewport culling

Les séparateurs hors de la zone visible ne sont pas filtrés explicitement (leur nombre est faible — 5 max). Si la liste devient très longue, ajouter un `.filter()` sur `visibleRange` identique à celui des commits.

---

## i18n — 7 nouvelles clés

À ajouter dans les 5 locales (`en.ts`, `fr.ts`, `es.ts`, `pt-br.ts`, `zh-cn.ts`) :

| Clé | EN | FR |
|-----|----|----|
| `log.filterCurrentBranch` | Current branch only | Branche courante uniquement |
| `log.filterMineCommits` | My commits only | Mes commits uniquement |
| `log.dateSepToday` | Today | Aujourd'hui |
| `log.dateSepYesterday` | Yesterday | Hier |
| `log.dateSepThisWeek` | This week | Cette semaine |
| `log.dateSepThisMonth` | This month | Ce mois-ci |
| `log.dateSepOlder` | Older | Plus ancien |

---

## Fichiers modifiés

| Fichier | Nature des changements |
|---------|----------------------|
| `apps/desktop/src/components/CommitGraph.vue` | Props, emits, template (2 boutons + séparateurs), computed, CSS |
| `apps/desktop/src/composables/useGitRepo.ts` | `logBranchFilter` state, `setLogBranchFilter()`, `loadLog()`, `loadMoreLog()`, exports |
| `apps/desktop/src/App.vue` | Destructuration `logBranchFilter`, props + wire emits sur `<CommitGraph>` |
| `apps/desktop/src/locales/en.ts` | 7 nouvelles clés |
| `apps/desktop/src/locales/fr.ts` | 7 nouvelles clés |
| `apps/desktop/src/locales/es.ts` | 7 nouvelles clés |
| `apps/desktop/src/locales/pt-br.ts` | 7 nouvelles clés |
| `apps/desktop/src/locales/zh-cn.ts` | 7 nouvelles clés |

**Non modifiés :** `dagLayout.ts`, `backend.ts`, Rust backend.

---

## Hors périmètre

- Persistance des filtres entre sessions (pas de sauvegarde dans `useSettings`)
- Reset des filtres au changement de repo (comportement naturel — `loadLog` est rappelé)
- Séparateurs par année pour les très longs historiques (bucket "older" couvre tout)
