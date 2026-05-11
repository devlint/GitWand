@../../CLAUDE.md

# packages/mcp — @gitwand/mcp

Serveur MCP (Model Context Protocol) exposant les capacités GitWand aux agents AI (Claude Code, Cursor, Windsurf). Thin wrapper autour de `@gitwand/core` — toute logique de résolution reste dans `core`.

## Architecture

```
src/
├── server.ts       # Setup MCP (transport stdio)
├── tools/          # Outils MCP (actions)
└── resources/      # Ressources MCP (données lisibles)
```

**Transport :** stdio (standard MCP)

**3 catégories d'exposition :**
- **Tools** — Actions déclenchables par l'agent
- **Resources** — Données lisibles en temps réel
- **Prompts** — Templates de contexte

## Tools disponibles

| Outil | Description |
|-------|-------------|
| `gitwand_status` | Lister les fichiers en conflit avec confidence scores |
| `gitwand_preview_merge` | Simuler un merge sans l'appliquer |
| `gitwand_resolve_conflicts` | Résoudre les conflits d'un fichier ou de tout le repo |
| `gitwand_explain_hunk` | DecisionTrace complet pour un hunk précis |
| `gitwand_apply_resolution` | Appliquer une résolution fournie par l'agent à un hunk |
| `gitwand_resolve_hunk` | v2.5 — inverser la boucle : GitWand demande à l'agent connecté de proposer la résolution (retourne un prompt structuré, l'agent répond `{resolution, reasoning}`) |
| `gitwand_resolve_hunk_llm` | v2.5 — valider + appliquer une résolution proposée par un LLM (markers résiduels, syntaxe JSON/YAML, score) |

## Resources disponibles

| Resource | Description |
|----------|-------------|
| `repo://info` | Informations sur le repo courant |
| `repo://conflicts` | État des conflits en temps réel |

## Règles de développement

- Tout nouvel outil va dans `tools/` — un fichier par outil
- Enregistrer chaque outil dans `server.ts`
- Les descriptions d'outils sont lues par les agents AI — soigner le wording pour la clarté et la précision
- Les paramètres doivent être JSON Schema valide
- Toujours retourner des erreurs structurées — pas de `throw` nu exposé à l'agent

## Build & test

```bash
pnpm build           # TypeScript → dist/
pnpm test            # Tests unitaires
node dist/server.js  # Lancer le serveur MCP (stdio)
```

## Setup dans Claude Code

Ajouter dans `.claude/settings.json` ou `~/.claude.json` :

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["@gitwand/mcp"]
    }
  }
}
```

## Publication

- Publié sur npm via `.github/workflows/publish.yml`
- Version synchronisée avec `packages/core` et `packages/cli`
- Toujours utiliser `./scripts/bump-version.sh X.Y.Z` depuis la racine — jamais éditer les versions à la main
