# Audit — apps/desktop/src (Vue 3)

**Date :** 2026-04-28
**Scope :** `apps/desktop/src/` — frontend Vue 3
**Checks :** 6 axes · ✅ 5 conformes · ⚠️ 0 avertissements · ❌ 1 violation

---

## ✅ Points conformes

### Axe 1 — Isolation des appels Tauri via backend.ts
Aucun appel `invoke()` direct trouvé en dehors de `backend.ts`. Tous les composants et composables importent les fonctions publiques de `backend.ts`. Le wrapper interne `tauriInvoke<T>()` (lignes 19–25) est le seul point d'appel de `invoke()`.

### Axe 2 — Sanitisation HTML (`v-html`)
Toutes les occurrences de `v-html` dans les composants utilisent `safeHtml()` ou `renderMarkdown()` de `useSafeHtml.ts` :

| Composant | Nb occurrences | Wrapper utilisé |
|---|---|---|
| `MergeEditor.vue` | 3 | `safeHtml(lineHtml)` |
| `PrCreateView.vue` | 1 | `safeHtml(bodyPreview)` |
| `PrCommentThread.vue` | 1 | `safeHtml(renderBody(...))` |
| `PrInlineDiff.vue` | 1 | `safeHtml(hl(...))` |
| `PrDetailView.vue` | 1 | `renderMarkdown(...)` |
| `FileHistoryViewer.vue` | 2 | `safeHtml()` |
| `DashboardView.vue` | 1 | `safeHtml(renderReadme(...))` |
| `DiffViewer.vue` | 2 | `safeHtml()` |
| `CommitDiffViewer.vue` | 3 | `safeHtml()` |
| `PullRequestPanel.vue` | 1 | `safeHtml(renderBody(...))` |

Aucun `v-html` sans sanitisation. ✅

### Axe 3 — Cohérence des locales (i18n)
Les 5 fichiers de locale TypeScript (`en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`) ont exactement **38 clés de premier niveau identiques**. La conformité est garantie structurellement : `index.ts` importe `type Locale` depuis `en.ts` et force toutes les autres locales à respecter la même shape (vérification TypeScript à la compilation). Aucune chaîne user-visible hardcodée dans les composants — tous utilisent `t()` via `useI18n()`.

### Axe 5 — Composition API (`<script setup>`)
46 composants — tous utilisent `<script setup lang="ts">`. Aucun `export default { }` (Options API) trouvé. ✅

### Axe 6 — Business logic dans les composables
Toute logique métier est isolée dans `src/composables/` (30+ composables : `useGitRepo.ts`, `useCommitActions.ts`, `useAIProvider.ts`, `useSettings.ts`, etc.). Les composants orchestrent les composables et ne contiennent pas de logique métier propre.

---

## ❌ Violation à corriger

### [V1] Désynchronisation des interfaces Settings — Axe 4

**Fichiers :**
- `apps/desktop/src/composables/useSettings.ts` — interface `AppSettings` (lignes 21–36)
- `apps/desktop/src/components/SettingsPanel.vue` — interface locale `Settings` (lignes 39–62)

**8 champs présents dans `SettingsPanel.Settings` mais absents de `AppSettings` :**

| Champ manquant dans AppSettings | Ligne SettingsPanel.vue |
|---|---|
| `commitMessageLang` | 44 |
| `aiEnabled` | 55 |
| `aiProvider` | 56 |
| `aiApiKey` | 57 |
| `aiApiEndpoint` | 58 |
| `aiModel` | 59 |
| `aiOllamaUrl` | 60 |
| `aiOllamaModel` | 61 |

**Impact :** Les valeurs par défaut de ces champs (lignes 78–86 de SettingsPanel.vue) ne sont pas persistées dans `AppSettings`, la source de vérité pour la sérialisation/restauration des paramètres.

**Correction :** Ajouter les 8 champs à l'interface `AppSettings` dans `useSettings.ts` avec leurs types et valeurs par défaut dans `defaultAppSettings`.

```typescript
// useSettings.ts — à ajouter dans AppSettings et defaultAppSettings
commitMessageLang: string      // default: 'en'
aiEnabled: boolean             // default: false
aiProvider: string             // default: 'claude'
aiApiKey: string               // default: ''
aiApiEndpoint: string          // default: ''
aiModel: string                // default: ''
aiOllamaUrl: string            // default: ''
aiOllamaModel: string          // default: ''
```

---

## Résumé des actions

| ID | Priorité | Effort | Action |
|---|---|---|---|
| V1 | 🔴 Haute | Faible | Ajouter 8 champs AI/i18n à `AppSettings` dans `useSettings.ts` et `defaultAppSettings` |
