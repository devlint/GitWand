# Audit — packages/core

**Date :** 2026-04-28
**Scope :** `packages/core/src/` — moteur de résolution de conflits
**Checks :** 16 · ✅ 9 conformes · ⚠️ 3 avertissements · ❌ 3 violations

---

## ✅ Points conformes

### Axe 1 — Architecture PatternPlugin
- Les 9 patterns exportent un default `PatternPlugin` avec les 8 champs requis (`type`, `priority`, `requires`, `detect`, `confidence`, `explanation`, `passReason`, `failReason`).
- Les 9 valeurs de `priority` sont uniques. `complex` a la priorité 999 — il est toujours évalué en dernier.
- Les 9 patterns sont importés et enregistrés dans `classifier.ts`.
- Les 9 types de pattern sont présents dans l'union `ConflictType` de `types.ts`.

### Axe 2 — Resolvers & dispatcher
- Les 12 resolvers vérifient les 4 points du dispatcher : fonction de détection, import, route dans `tryFormatAwareResolve()`, nom dans l'union `resolverUsed`.
- L'ordre de spécificité est respecté : `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.toml` sont routés avant les extensions génériques `*.json` et `*.yaml`.
- Aucun resolver ne propage d'exception sur erreur de parsing — tous retournent `lines: null` dans un `try/catch`.

### Axe 4 — Diff parser
- Aucune occurrence de `!line.startsWith('\\')` pour détecter des context lines. Le parser utilise des regex dédiées pour les marqueurs de conflit (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`).

---

## ❌ Violations à corriger

### [V1] Import Node.js dans `packages/core` — Axe 3

**Fichier :** `structural/parsers/adapters/node.ts`

**Lignes :** 9–12

```typescript
import { readFile } from "node:fs/promises";   // ligne 9
import { createRequire } from "node:module";    // ligne 10
import { dirname, resolve } from "node:path";   // ligne 11
import { fileURLToPath } from "node:url";       // ligne 12
```

**Contexte :** L'adaptateur est chargé dynamiquement et conditionnellement (uniquement en environnement Node via `detectEnvironment()` dans `loader.ts`). Il ne sera pas inclus dans un bundle browser si le code-splitting est correct. Mais la présence du fichier dans `packages/core/src/` viole la règle documentée dans `CLAUDE.md` : *"aucune dépendance Node.js dans packages/core"*.

**Correction proposée :** Soit déplacer `structural/parsers/adapters/node.ts` hors de `packages/core/src/` (vers `packages/cli` ou un package `@gitwand/node-adapter`), soit l'exclure explicitement du bundle browser via `sideEffects`, une condition `exports` dans `package.json`, ou un alias Vite. Documenter la décision dans `packages/core/CLAUDE.md`.

---

### [V2] Tests unitaires manquants — Patterns — Axe 5

**Répertoire attendu :** `packages/core/src/__tests__/patterns/`

7 patterns sur 9 n'ont **pas** de fichier de test unitaire dédié :

| Pattern | Fichier manquant |
|---|---|
| `same-change` | `same-change.test.ts` |
| `delete-no-change` | `delete-no-change.test.ts` |
| `one-side-change` | `one-side-change.test.ts` |
| `non-overlapping` | `non-overlapping.test.ts` |
| `whitespace-only` | `whitespace-only.test.ts` |
| `value-only-change` | `value-only-change.test.ts` |
| `complex` | `complex.test.ts` |

Présents : `reorder-only.test.ts` ✅, `insertion-at-boundary.test.ts` ✅

**Contexte :** Ces patterns sont couverts indirectement par `corpus.test.ts`, `resolver.test.ts`, et `confidence-v14.test.ts`. La couverture de cas limites unitaires (5 "should detect" + 5 "should not detect" par pattern) est absente.

**Correction proposée :** Créer un fichier de test par pattern manquant, avec minimum 10 cas : 5 où `detect()` renvoie `true` + 5 où il renvoie `false`, incluant au moins un cas avec chaînes vides et un cas edge.

---

### [V3] Tests unitaires manquants — Resolvers — Axe 5

**Répertoire attendu :** `packages/core/src/__tests__/resolvers/`

9 resolvers sur 12 n'ont **pas** de fichier de test dédié :

| Resolver | Fichier manquant | Couverture indirecte |
|---|---|---|
| `json` | `json.test.ts` | `format-resolvers.test.ts`, `format-profiles/` |
| `yaml` | `yaml.test.ts` | `format-resolvers.test.ts` |
| `css` | `css.test.ts` | — |
| `markdown` | `markdown.test.ts` | — |
| `imports` | `imports.test.ts` | `imports-extended.test.ts` (racine `__tests__/`) |
| `vue` | `vue.test.ts` | — |
| `lockfile-npm` | `lockfile-npm.test.ts` | `lockfile-resolvers.test.ts` (racine `__tests__/`) |
| `lockfile-pnpm` | `lockfile-pnpm.test.ts` | `lockfile-resolvers.test.ts` (racine `__tests__/`) |
| `lockfile-yarn` | `lockfile-yarn.test.ts` | `lockfile-resolvers.test.ts` (racine `__tests__/`) |

Présents : `cargo.test.ts` ✅, `dotenv.test.ts` ✅, `dockerfile.test.ts` ✅

**Correction proposée :** Créer un fichier de test par resolver manquant, avec minimum 5 cas : 1 conflit simple résolvable, 1 conflit complexe non résolvable, 1 structure vide/minimale, 2 scénarios réels représentatifs du format.

---

## ⚠️ Avertissements (non bloquants)

### [A1] `generated_file` dans `ConflictType` sans PatternPlugin — Axe 1

**Fichier :** `src/types.ts`

`generated_file` est présent dans l'union `ConflictType` mais aucun `PatternPlugin` ne porte ce type. Il est géré via `structural/generated-detection.ts`, hors du registre de patterns `classifier.ts`.

**Action recommandée :** Documenter dans `packages/core/CLAUDE.md` que `generated_file` est un type spécial traité hors registre, pour éviter toute confusion lors de l'ajout de nouveaux patterns.

---

### [A2] `process.env` / `process.versions` dans le code core — Axe 3

| Fichier | Ligne | Accès |
|---|---|---|
| `diff/index.ts` | 35–36 | `process.env?.GITWAND_DIFF === "lcs"` |
| `structural/parsers/loader.ts` | 66 | `process.versions?.node` |

Les deux accès sont gardés par `typeof process === "undefined"` — ils sont safe en browser (retournent `undefined`/`false`). Pas une violation, mais une dépendance implicite au runtime Node.

**Action recommandée :** Remplacer par des variables d'environnement injectées au build (`import.meta.env.VITE_GITWAND_DIFF`) pour une approche plus propre et explicitement browser-compatible.

---

### [A3] `"structural"` dans l'union `resolverUsed` sans route dans le dispatcher — Axe 2

**Fichier :** `resolvers/dispatcher.ts`, ligne 122

La valeur `"structural"` est présente dans l'union `resolverUsed` de `FormatResolveResult` mais n'est pas routée dans `tryFormatAwareResolve()`. Elle provient d'un point d'injection externe (`resolver/format-dispatch.ts` ou équivalent).

**Action recommandée :** Ajouter un commentaire dans `dispatcher.ts` expliquant que `"structural"` est injecté depuis l'orchestrateur externe, pas depuis le dispatcher de format — pour éviter toute confusion lors de maintenances futures.

---

## Résumé des actions

| ID | Priorité | Effort | Action |
|---|---|---|---|
| V1 | 🔴 Haute | Moyen | Exclure `adapters/node.ts` du bundle browser ou déplacer hors de `packages/core` |
| V2 | 🟡 Moyenne | Élevé | Créer 7 fichiers de test unitaires pour les patterns manquants |
| V3 | 🟡 Moyenne | Élevé | Créer 9 fichiers de test unitaires pour les resolvers manquants |
| A1 | 🟢 Basse | Faible | Documenter `generated_file` dans `packages/core/CLAUDE.md` |
| A2 | 🟢 Basse | Faible | Remplacer `process.env` par `import.meta.env` pour browser-compat explicite |
| A3 | 🟢 Basse | Faible | Ajouter un commentaire sur `"structural"` dans `dispatcher.ts` |
