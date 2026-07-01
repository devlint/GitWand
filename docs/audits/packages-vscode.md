# Audit — packages/vscode

**Date :** 2026-04-28
**Scope :** `packages/vscode/src/` — extension VS Code `gitwand-vscode`
**Checks :** 6 axes · ✅ 5 conformes · ⚠️ 0 avertissements · ❌ 1 violation

---

## ✅ Points conformes

### Axe 1 — Thin wrapper autour de `@gitwand/core`
Toute la résolution de conflits est déléguée à `@gitwand/core`. L'extension importe `resolve`, `parseConflictMarkers`, `classifyConflict` (`extension.ts:17`). Aucune logique de résolution réimplémentée.

### Axe 2 — Versioning indépendant (non géré par bump-version.sh)
`packages/vscode` est explicitement absent du script `scripts/bump-version.sh`. La version `1.2.0` dans `package.json` est gérée manuellement et publiée via `vsce`. ✅ Conforme à la règle AGENTS.md.

### Axe 3 — Configuration VS Code (`activationEvents`, `contributes.commands`, `engines`)
`package.json` déclare :
- `"engines.vscode": "^1.85.0"` ✅
- `"activationEvents": ["onLanguage:*"]` ✅
- 3 commandes dans `contributes.commands` : `gitwand.resolveFile`, `gitwand.resolveAll`, `gitwand.status` ✅

### Axe 5 — Aucune API Node.js interdite dans l'extension host
Aucun usage de `child_process.fork`, `spawn`, `execFile` dans le code de l'extension. Les APIs Node problématiques sur l'extension host VS Code ne sont pas utilisées.

### Axe 6 — Toutes les commandes `contributes.commands` ont un handler dans `activate()`
Les 3 commandes déclarées dans `package.json` ont toutes un `registerCommand` correspondant dans `activate()` :
- `gitwand.resolveFile` → `extension.ts:457`
- `gitwand.resolveAll` → `extension.ts:458`
- `gitwand.status` → `extension.ts:459`

Aucune commande orpheline.

---

## ❌ Violation à corriger

### [V1] Build via `tsc` brut au lieu de `vsce` — Axe 4

**Fichier :** `packages/vscode/package.json`, section `scripts`

```json
"scripts": {
  "build": "tsc",
  "clean": "rm -rf dist"
}
```

Le script de build utilise `tsc` directement. La publication d'une extension VS Code nécessite `vsce` (ou `@vscode/vsce`) pour :
- Produire un `.vsix` packagé correctement
- Valider la structure du manifest `package.json`
- Exclure les fichiers inutiles du bundle

De plus, `@vscode/vsce` n'est pas présent dans les `devDependencies`.

**Correction proposée :**

```bash
# Ajouter vsce
pnpm --filter gitwand-vscode add -D @vscode/vsce
```

```json
// package.json — scripts
"scripts": {
  "build": "tsc",
  "package": "vsce package",
  "publish": "vsce publish",
  "clean": "rm -rf dist"
}
```

La compilation TypeScript (`tsc`) reste valide pour le développement. Le packaging et la publication doivent passer par `vsce package` / `vsce publish`.

---

## Résumé des actions

| ID | Priorité | Effort | Action |
|---|---|---|---|
| V1 | 🟡 Moyenne | Faible | Ajouter `@vscode/vsce` aux devDependencies et les scripts `package` / `publish` |
