# Audit — packages/mcp

**Date :** 2026-04-28
**Scope :** `packages/mcp/src/` — serveur MCP `@gitwand/mcp`
**Checks :** 6 axes · ✅ 5 conformes · ⚠️ 1 avertissement · ❌ 0 violations

---

## ✅ Points conformes

### Axe 1 — Thin wrapper autour de `@gitwand/core`
Aucune logique de résolution réimplémentée. Tous les handlers appellent `resolve()` importé depuis `@gitwand/core` (`tools/index.ts:14`, `resources/index.ts:12`). Les appels se trouvent aux lignes 270, 323, 370, 427, 489.

### Axe 2 — Transport stdio
Transport configuré exclusivement en stdio :
- `server.ts:15` — import de `StdioServerTransport`
- `server.ts:71` — `new StdioServerTransport()`
- `server.json` — `"transport": {"type": "stdio"}`

Aucun transport HTTP ou SSE.

### Axe 3 — Tous les outils ont `name`, `description` et `inputSchema`
Les 5 outils MCP sont déclarés avec les 3 champs requis dans `registerTools()` (lignes 32–129) :

| Outil | Propriétés inputSchema |
|---|---|
| `gitwand_status` | `cwd` |
| `gitwand_resolve_conflicts` | `cwd`, `files`, `dry_run`, `policy` |
| `gitwand_preview_merge` | `cwd` |
| `gitwand_explain_hunk` | `cwd`, `file` (required), `line` (required) |
| `gitwand_apply_resolution` | `cwd`, `file` (required), `line` (required), `content` (required) |

2 resources déclarées avec `name`, `description`, `mimeType` : `gitwand://repo/conflicts`, `gitwand://repo/policy`.

### Axe 4 — Gestion d'erreurs dans les handlers
Tous les handlers encapsulent leurs opérations fichier dans des `try/catch` et retournent des réponses MCP structurées (`{isError: true}` ou `{path, error: ...}`). Le handler de dispatch principal (`handleToolCall`, lignes 230–251) retourne `{isError: true}` pour les outils inconnus.

### Axe 5 — Aucun secret dans les logs ou réponses
`server.ts` ne logue que des messages de diagnostic neutres (`"[gitwand-mcp] Server started on stdio"`, `"[gitwand-mcp] Fatal error: ..."`). Aucun token, clé API ou identifiant dans les réponses ou logs. Grep sur `API`, `KEY`, `TOKEN`, `SECRET`, `password`, `credential` : aucun résultat.

---

## ⚠️ Avertissement (non bloquant)

### [A1] `server.json` ne liste pas les outils ni les resources

**Fichier :** `packages/mcp/server.json`

Le manifest ne contient pas de section `tools` ni `resources` pour déclarer les 5 outils et 2 ressources. Le fichier se limite aux métadonnées du package (`name`, `description`, `version`, `packages`, `transport`).

**Impact :** La découverte dynamique (via `ListToolsRequest` / `ListResourcesRequest`) fonctionne correctement à runtime. L'absence de déclaration statique dans le manifest empêche uniquement les registres MCP ou outils de catalogue de lire les capacités sans lancer le serveur.

**Action recommandée :** Ajouter une section `tools` et `resources` à `server.json` avec les noms et descriptions des outils, pour garder le manifest en sync avec le code.

---

## Résumé des actions

| ID | Priorité | Effort | Action |
|---|---|---|---|
| A1 | 🟢 Basse | Faible | Ajouter `tools` et `resources` dans `server.json` pour documenter les capacités statiquement |
