# Audit — packages/cli

**Date :** 2026-04-28
**Scope :** `packages/cli/src/` — CLI Node.js `@gitwand/cli`
**Checks :** 6 axes · ✅ 6 conformes · ⚠️ 0 avertissements · ❌ 0 violations

---

## ✅ Points conformes

### Axe 1 — Thin wrapper autour de `@gitwand/core`
Aucune logique de résolution de conflits réimplémentée. Le CLI délègue intégralement à `@gitwand/core` :
- `commands/resolve.ts:22` — `import { resolve, MergeResult } from "@gitwand/core"`
- `commands/status.ts:15` — même pattern
- `reporting.ts:13` — import du type `MergeResult`

Le seul parsing de marqueurs git se trouve dans `partial-content.ts` pour reconstruire les fichiers partiellement résolus quand `mergedContent` est `null` — logique de collage légitime, pas une réimplémentation du moteur.

### Axe 2 — Exit codes (0 = succès, 1 = erreur connue, 2 = erreur fatale)
Les exit codes sont correctement ségrégués :
- **0 (succès) :** `resolve.ts:49` (aucun conflit), `resolve.ts:157` (tout résolu), `status.ts:36–39`
- **1 (erreur connue) :** `resolve.ts:155` (conflits résiduels après auto-résolution)
- **1 (usage) :** `cli.ts:90` (commande inconnue)
- **2 (fatal) :** `index.ts:34` (exception non capturée dans `main()`)

### Axe 3 — stdout / stderr
Toutes les erreurs vont vers `console.error` (stderr) : `index.ts:33`, `cli.ts:88`. Tout le contenu fonctionnel (statut, résultats, JSON CI) va vers `console.log` (stdout).

### Axe 4 — `process.exit()` uniquement à la frontière CLI
Aucun appel à `process.exit()` dans des helpers internes. Tous les appels se trouvent dans les handlers de commande ou le dispatcher top-level (`index.ts`, `cli.ts`, `resolve.ts`, `status.ts`).

### Axe 5 — Toutes les commandes enregistrées dans le dispatcher
Les 2 commandes (`cmdResolve`, `cmdStatus`) sont exportées depuis leur module respectif et explicitement importées et routées dans `cli.ts:77–92`. Aucune fonction orpheline.

### Axe 6 — Zéro import Node.js dans `@gitwand/core`
Les modules Node natifs (`node:fs/promises`, `node:path`, `node:child_process`) sont exclusivement utilisés dans la couche CLI. `@gitwand/core` ne reçoit que des types et structures agnostiques à la plateforme.

---

## Observations complémentaires

- Documentation en français dans tous les modules (commentaires explicatifs du rôle de chaque fichier).
- Pool de concurrence déterministe via `concurrency.ts` (ordre stable de sortie).
- Mode CI : output JSON avec versioning de schéma dans `reporting.ts`.
- Gestion d'erreur gracieuse : `git.ts` retourne une liste vide en cas d'échec plutôt que de crasher.

---

## Résumé des actions

| ID | Priorité | Action |
|---|---|---|
| — | — | Aucune correction requise. Le CLI est conforme sur tous les axes. |
