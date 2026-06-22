@../CLAUDE.md

# Frontend Vue 3 — apps/desktop/src/

## Structure

```
src/
├── components/         # 30+ composants Vue (MergeEditor, DiffViewer, PrDetailView, etc.)
├── composables/        # 31 composables (useGitWand, useMergePreview, useAIProvider, etc.)
├── utils/              # Utilitaires (backend.ts, diffMode, highlight, patchBuilder, dagLayout…)
├── locales/            # i18n (en.ts, fr.ts, es.ts, pt-br.ts, zh-cn.ts)
├── assets/             # Images, styles globaux
├── App.vue             # Composant racine
└── main.ts             # Entry point
```

## UI — Forme des boutons

Ne **jamais** créer de bouton totalement arrondi (pilule / `border-radius: var(--radius-pill)` / `border-radius: 9999px`). Tous les boutons doivent être des carrés arrondis : utiliser `--radius-sm`, `--radius-md` ou `--radius-lg`.

## Architecture — Composables vs Composants

Séparation stricte :

- **Composables** (`composables/`) — logique métier : appels IPC, état git, IA, persistence
- **Composants** (`components/`) — rendu et interactions UI uniquement, pas de logique métier

Pas de Pinia/Vuex. Les stores sont des composables avec `ref`/`reactive` au niveau module.

## Règle `<script setup>`

Tout nouveau composant DOIT utiliser la Composition API avec `<script setup>`. L'Options API est interdite pour les nouveaux composants.

## IPC Bridge — utils/backend.ts

`utils/backend.ts` est le **point d'entrée unique** pour toutes les communications avec le backend Rust.

```typescript
// ✅ Toujours importer depuis backend.ts
import { gitStatus, readFile, writeFile } from '@/utils/backend'

// ❌ Jamais invoker Tauri directement dans les composants/composables
import { invoke } from '@tauri-apps/api/core' // INTERDIT dans src/
```

Quand une nouvelle commande Rust est ajoutée, sa déclaration typée doit être ajoutée dans `backend.ts` dans la même PR.

## Sécurité — DOMPurify

Tout contenu HTML user-generated DOIT passer par `useSafeHtml.ts` (wrapper DOMPurify) avant d'être injecté via `v-html`.

Cas concernés : descriptions de PR, corps de commits avec markdown, contenu venant de l'API GitHub.

```typescript
// ✅ Correct
const { safeHtml } = useSafeHtml(rawMarkdown)
// <div v-html="safeHtml" />

// ❌ JAMAIS
// <div v-html="rawMarkdown" />
```

## Settings — Synchronisation des interfaces

L'application a **deux interfaces Settings qui doivent rester synchronisées** :

1. `useSettings.ts` — interface `AppSettings` (source de vérité persistence)
2. `SettingsPanel.vue` — interface `Settings` (type local du composant)

Quand on ajoute un nouveau champ de settings, il DOIT être ajouté dans les **deux** fichiers. Oublier l'un des deux provoque un bug silencieux.

## i18n

5 langues supportées : EN (défaut), FR, ES, PT-BR, ZH-CN.

- Toute string user-visible doit avoir une clé dans **tous** les fichiers `src/locales/`
- Ne jamais hardcoder du texte directement dans les templates
- Utiliser le composable `useI18n.ts` :

```typescript
const { t } = useI18n()
// <span>{{ t('key') }}</span>
```

## Highlight.js et Tree-sitter

- Syntax highlighting via `highlight.js` (30+ langages) — `utils/highlight.ts` + `utils/diffHighlight.ts`
- Parsing structurel via `web-tree-sitter` (grammaires WASM dans `public/`)
- Les grammaires WASM sont lazy-loadées — ne pas les importer directement, utiliser les helpers existants

## Composables principaux

| Composable | Rôle |
|---|---|
| `useGitWand.ts` | Orchestration résolution conflits |
| `useMergePreview.ts` | Simulation merge avant commit |
| `useMergeRisk.ts` | Prédiction risque de conflit |
| `useAIProvider.ts` | Config provider IA (Claude/OpenAI/Ollama) |
| `useSettings.ts` | Persistence paramètres utilisateur |
| `useRepoTabs.ts` | Multi-repo tabs |
| `useInteractiveRebase.ts` | Rebase interactif |
| `useSplitCommit.ts` | Split commit par hunks |

## Tests Vitest

- Environnement : `jsdom`
- Les composables ont leurs tests dans `composables/__tests__/`
- Préférer les tests de composables aux tests de composants avec mocks lourds

## Diff — gotcha critique

Dans tout code qui parse des diffs git :

```typescript
// ✅ Correct — détecte les lignes de contexte
if (line.startsWith(' ')) { /* context line */ }

// ❌ Bug subtil — les chaînes vides passent ce test
if (!line.startsWith('\\')) { /* FAUX context line */ }
```

Les chaînes vides (`''`) ne commencent pas par `\\`, donc `!startsWith('\\')` les classe à tort comme lignes de contexte. Toujours utiliser `startsWith(' ')`.
