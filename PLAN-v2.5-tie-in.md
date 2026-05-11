# GitWand — Plan v2.5 LLM fallback tie-in

> Le core `@gitwand/core@2.5.0` est livré (`83c0712 feat(core): v2.5 — LLM fallback opt-in via injected endpoint`, `926ef88 refactor: SHA-256 → FNV-1a`).
> Les tie-ins consommateurs manquent : desktop, CLI, MCP. Tant qu'ils ne sont pas livrés, le pattern `llm_proposed` ne peut être activé par personne — le ✅ ROADMAP est bloqué.
>
> Date initiale : 2026-05-11. Cible : v2.6 desktop (vague de release qui aligne desktop/cli/mcp avec le core).

---

## Statut des chantiers

| § | Chantier | Effort | Statut | Date |
|---|---|---|---|---|
| 1.0 | Persistance `.gitwandrc` côté desktop (write path) | S | ✅ Appliqué | 2026-05-12 |
| 1.1 | Settings → section "AI fallback" (toggle + provider + seuils) | M | ✅ Appliqué | 2026-05-12 |
| 1.2 | i18n des nouvelles clés × 5 locales | S | ✅ Appliqué | 2026-05-12 |
| 2.1 | `useGitWand.ts` → injecter `LlmEndpoint` dans `resolveOptions` | M | ✅ Appliqué | 2026-05-12 |
| 2.2 | `useAIProvider` → exposer un adapter `toLlmEndpoint()` | S | ✅ Appliqué | 2026-05-12 |
| 3.1 | Composant `LlmTracePanel.vue` (audit trail + bouton Reject) | M | ✅ Appliqué | 2026-05-12 |
| 3.2 | Intégration dans `MergeEditor.vue` quand `selectedType === "llm_proposed"` | S | ✅ Appliqué | 2026-05-12 |
| 4.1 | CLI : flag `--llm-fallback` + endpoint Node | M | ✅ Appliqué | 2026-05-12 |
| 4.2 | CLI : passage à `resolveAsync` (avec garde rétro-compat) | S | ✅ Appliqué | 2026-05-12 |
| 5.1 | MCP : tool `gitwand_resolve_hunk` exposé par `@gitwand/mcp` | M | ✅ Appliqué | 2026-05-12 |
| 5.2 | MCP : provider `endpoint: "mcp"` câblé desktop → `@gitwand/mcp` | S | 🟡 Phase 2 — différé | — |
| 6.1 | Docs website : page "LLM fallback" (config, sécurité, coût) | S | ✅ Appliqué | 2026-05-12 |
| 6.2 | Article de blog v2.5 (plan éditorial CORE-V2-ROADMAP) | S | ✅ Appliqué | 2026-05-12 |
| 7.1 | Bench régression : `ConGra-mini` avec endpoint mocké déterministe | S | ✅ Appliqué — **15/15 = 100 %** (cible ≥80 %) | 2026-05-12 |
| 7.2 | Test d'intégration desktop → core via endpoint stub | S | ✅ Appliqué — 4 scénarios | 2026-05-12 |
| 8.1 | Roadmap : ajouter ✅ à v2.5.0 dans ROADMAP.md + CORE-V2-ROADMAP.md | XS | ✅ Appliqué | 2026-05-12 |

**Effort total estimé** : ~3 semaines (1.5 sem desktop, 0.5 sem CLI, 0.5 sem MCP, 0.5 sem doc/bench).
**Effort réel** : 1 session (4 agents parallèles Wave 1 + 1 agent Wave 2 + 1 agent Wave 3 + clôture in-line).

## Notes post-livraison (2026-05-12)

### Divergences mineures avec la spec d'origine

- **Hash prompt** : la spec disait FNV-1a, l'impl core garde le nom `sha256Hex` mais utilise FNV-1a 64-bit en interne (cf. commit `926ef88`). Le champ exposé reste `LlmTrace.promptHash`. La doc et la page guide ont été calibrées sur le comportement réel.
- **`LlmTrace` field names** : `calledAt` (pas `timestamp`), `rawResponseTruncated` (pas `rawResponse`). `LlmTracePanel.vue` lit les noms réels.
- **Naming MCP tool** : `gitwand_resolve_hunk` (préfixe `gitwand_*` cohérent avec les 5 tools pré-existants), pas `resolve_hunk` brut.
- **`AIProvider` desktop** : la valeur `mcp` a été ajoutée au type union mais `toLlmEndpoint()` retourne `null` pour cette valeur — le câblage MCP self-hosted attend §5.2 (différé Phase 2 pour shipper plus vite).

### Bump version

**Non bumpé en §8.** Le tableau de versions actuel (cf. CLAUDE.md) montre `@gitwand/core@2.5.0` partout — bumper à 2.6.0 télescope avec `@gitwand/core@2.6.0` (refactoring-aware merge) déjà tagué via `workflow_dispatch`. Décision à prendre : (a) publier un `@gitwand/core@2.5.1` avec patch note "tie-in only" et bumper desktop/cli/mcp à `2.7.0` pour aligner, ou (b) attendre la prochaine release desktop pour aligner sur la version en cours. À débattre avant le prochain `./scripts/bump-version.sh`.

### Tests finaux

- `cd packages/core && pnpm test` → **901/901**
- `cd apps/desktop && pnpm test` → **76/76**
- `cd packages/cli && pnpm test` → 13/13 (nouveau)
- `cd packages/mcp && pnpm build` → clean (pas de runner test côté MCP)
- `cd website && pnpm build` → clean (HTML généré pour les 2 nouvelles pages, sidebar OK)
- `vue-tsc --noEmit` côté desktop → 0 erreur

---

## Pré-requis & invariants

- **Browser-safe contract** : `@gitwand/core` reste pur (pas de `fetch` direct, pas de Node natif). Tous les appels HTTP/IPC sortent des consommateurs (desktop / cli / mcp).
- **Opt-in strict** : `llmFallback.enabled` défaut `false` partout. Aucune télémétrie. Aucun envoi de code sans consentement explicite.
- **Rétro-compat** : `resolve()` synchrone continue de fonctionner. `resolveAsync()` est la seule porte d'entrée du LLM fallback (déjà utilisée pour le structurel v2.3).
- **Audit trail** : chaque résolution `llm_proposed` produit une `LlmTrace` (modèle, latence, hash FNV-1a du prompt, score validation). UI doit la rendre intégralement.
- **Policy gate** : `prefer-safety` et `strict` skippent le LLM fallback côté core. Pas de bypass côté UI — si l'utilisateur veut le LLM, il doit relâcher la policy.

---

## §1 — Persistance & UI Settings (desktop)

### 1.0 Write path `.gitwandrc`

État actuel : `dev-server.mjs` expose `POST /api/read-gitwandrc` (ligne ~3001) mais pas de `write-gitwandrc`. Les settings desktop sont persistés dans le store local Pinia, pas dans le fichier `.gitwandrc`.

À faire :

- **Rust** (`apps/desktop/src-tauri/src/commands/files.rs`) : commande `write_gitwandrc(cwd: String, content: String)`. Écrit `.gitwandrc` ou `.gitwandrc.json` selon le format détecté à la lecture (default `.gitwandrc` JSONC si fichier absent).
- **Dev-server** (`dev-server.mjs`) : endpoint miroir `POST /api/write-gitwandrc { cwd, content }`.
- **TS wrapper** (`apps/desktop/src/utils/backend.ts`) : `writeGitwandrc(cwd: string, config: object): Promise<void>` qui sérialise en JSONC commenté (préserver les commentaires existants si parseur disponible — sinon JSON pur, à documenter dans la doc).

**Choix de design** : `endpoint` (de type `LlmEndpoint`) **n'est jamais écrit dans `.gitwandrc`** (non-sérialisable). Le fichier ne stocke que `enabled`, `model`, `maxTokens`, `temperature`, `contextLines`, `minPostMergeScore`, `minMode`. L'endpoint est injecté programmatiquement par `useGitWand.ts` au moment de l'appel.

### 1.1 Section Settings "AI fallback"

`apps/desktop/src/components/SettingsPanel.vue` — nouvelle section sous "AI providers" :

- Toggle **"Enable LLM fallback for unresolved conflicts"** (default OFF) — bind sur `llmFallback.enabled`
- Disclaimer rouge sous le toggle : "Your code will be sent to the configured AI provider. Review carefully before commit."
- Provider picker (radio group ou dropdown) : `claude` / `claude-code-cli` / `codex-cli` / `openai-compat` / `ollama` / `mcp` — réutilise `AIProvider` de `useAIProvider.ts` + nouvelle valeur `mcp` (cf. §5.2)
- Champ `minPostMergeScore` (slider 50–100, défaut 80) avec libellé "Reject LLM resolutions scoring below"
- Champ `contextLines` (input number 10–200, défaut 50)
- Sélecteur `minMode` (`off` / `balanced` / `strict`) — par défaut `strict`, warning si l'utilisateur descend en dessous
- Bouton **"Save"** persiste via §1.0 dans `.gitwandrc` du repo courant
- État de chargement : disabled si aucun repo ouvert (le fichier `.gitwandrc` est per-repo)

Pattern miroir de la section AI providers existante. Réutiliser les design tokens (`var(--color-surface)`, `BaseModal`, etc.) — pas de styles ad hoc.

### 1.2 i18n (5 locales)

Nouvelles clés à ajouter dans `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` :

- `settings.ai.fallback.title`
- `settings.ai.fallback.enable.label` / `.help`
- `settings.ai.fallback.warning` (le disclaimer)
- `settings.ai.fallback.provider.label`
- `settings.ai.fallback.minScore.label` / `.help`
- `settings.ai.fallback.contextLines.label`
- `settings.ai.fallback.minMode.label`
- `settings.ai.fallback.save.button`
- `settings.ai.fallback.noRepo.message`
- `mergeEditor.llmResolution.title` / `.reject` / `.accept` / `.details` (anticipation §3.1)

**~12 clés × 5 locales = 60 entrées**. Suivre le pattern type-safe existant (les clés sont validées par TypeScript via `useI18n`).

---

## §2 — Wiring core → desktop

### 2.1 `useGitWand.ts` — injection de l'endpoint

`apps/desktop/src/composables/useGitWand.ts` ligne 246, l'appel actuel :

```ts
result: await resolveAsync(content, filePath, resolveOptions.value, structuralOpts),
```

À étendre :

```ts
const resolveOptionsWithLlm = {
  ...resolveOptions.value,
  llmFallback: llmFallbackConfig.value?.enabled
    ? {
        ...llmFallbackConfig.value,
        endpoint: aiProvider.toLlmEndpoint(),  // cf. §2.2
      }
    : undefined,
};
result: await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts),
```

- `llmFallbackConfig` : ref lue depuis le `.gitwandrc` au mount + après chaque save Settings
- Garde-fou : si `llmFallback.enabled === true` mais `aiProvider.toLlmEndpoint()` renvoie `null` (provider non configuré, API key manquante), afficher un toast d'erreur et skipper le LLM — pas de crash silencieux
- Logger l'usage LLM dans l'onglet Logs (Quick Fix v2.5 — réserve d'emplacement) avec l'horodatage, le fichier, le score validation

### 2.2 `useAIProvider.toLlmEndpoint()`

Nouvel export dans `apps/desktop/src/composables/useAIProvider.ts` :

```ts
export function toLlmEndpoint(): LlmEndpoint | null {
  if (!aiEnabled.value || aiProvider.value === "none") return null;
  return {
    async call(prompt: string): Promise<string> {
      // Dispatch sur le provider sélectionné (Claude / Codex / OpenAI / Ollama)
      // Réutilise la même fonction `rawPrompt()` que les suggestions IA existantes
      return await rawPrompt(prompt);
    },
  };
}
```

`rawPrompt()` existe déjà côté Claude CLI / Codex CLI (cf. v2.0.0 "AI providers — Codex CLI"). Pour Claude API directe / OpenAI / Ollama, vérifier que le dispatcher couvre les 3 — sinon compléter.

**Cas `provider === "mcp"`** : voir §5.2, l'endpoint pointe sur `@gitwand/mcp` self-hosted (différé tant que §5 pas livré).

---

## §3 — UI DecisionTrace pour `llm_proposed`

### 3.1 Composant `LlmTracePanel.vue`

Nouveau composant `apps/desktop/src/components/LlmTracePanel.vue`. Affiche le `LlmTrace` (cf. `packages/core/src/types.ts:221`) :

- **Header** : icône ✨ + "Resolved by LLM (experimental)" + chip avec le nom du modèle
- **Score de validation** : barre de progression colorée (rouge < 60, jaune 60–80, vert ≥ 80) + valeur numérique
- **Audit** : timestamp, latence (ms), hash FNV-1a du prompt (tronqué 8 caractères, click-to-copy)
- **Raw response** : `<details>` collapsable avec la `rawResponse` LLM tronquée à 2 KB (affichée en `<pre>` syntax-highlighted via `highlight.ts`)
- **Boutons** : `[ Accept ]` (default si score ≥ minPostMergeScore) / `[ Reject → manual ]` (revient au pattern `complex`, ouvre le merge editor 3-way classique)

Réutiliser les design tokens et le pattern `BaseModal` foundations livrés en v1.8.0.

### 3.2 Intégration `MergeEditor.vue`

Dans `apps/desktop/src/components/MergeEditor.vue`, quand un hunk a `decision.type === "llm_proposed"` :

- Au-dessus du diff 3-way standard, monter `<LlmTracePanel :trace="hunk.llmTrace" @reject="onLlmReject(hunkId)" />`
- `onLlmReject` : downgrade la résolution sélectionnée vers `complex`, force l'affichage du merge editor manuel pour ce hunk uniquement (les autres hunks `llm_proposed` du même fichier restent acceptés)

**Edge case** : si tous les hunks d'un fichier sont `llm_proposed` et que l'utilisateur reject tous, le bouton "Resolve auto" du fichier doit redevenir grisé (cohérent avec le comportement existant pour les hunks `complex` purs).

---

## §4 — CLI tie-in

### 4.1 Flag `--llm-fallback`

`packages/cli/src/commands/resolve.ts` (et équivalents `--ci` / `--json`) — nouveau flag yargs :

```ts
.option("llm-fallback", {
  type: "boolean",
  default: false,
  description: "Enable LLM fallback for unresolved conflicts (opt-in, experimental)"
})
.option("llm-provider", {
  type: "string",
  choices: ["claude", "openai", "ollama"],
  default: "claude",
  description: "LLM provider (requires API key in env: ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_URL)"
})
```

Quand `--llm-fallback` est présent :
1. Bascule de `resolve()` vers `resolveAsync()`
2. Construit un `LlmEndpoint` Node qui wrap l'API du provider sélectionné via `fetch` (Node 20+ a `fetch` natif — pas besoin de dep externe)
3. Lit les paramètres complémentaires depuis `.gitwandrc.llmFallback` du repo courant
4. Sortie `--json` : ajouter `llmTrace` dans chaque hunk résolu par `llm_proposed`

### 4.2 Garde rétro-compat

Le défaut reste `resolve()` synchrone. `--llm-fallback` est strictement opt-in via flag CLI ou `.gitwandrc.llmFallback.enabled: true`. Exit codes inchangés. Tests CLI existants ne doivent pas régresser.

---

## §5 — MCP tie-in

### 5.1 Tool `resolve_hunk` côté `@gitwand/mcp`

`packages/mcp/src/tools/resolve_hunk.ts` (nouveau). Expose un tool MCP qui :

- Input : `{ base: string, ours: string, theirs: string, filePath: string, context: string }`
- Sortie : `{ resolution: string, reasoning: string }` (texte brut, lignes de code)
- Implémentation : prompt structuré que le LLM connecté côté Claude Code / Cursor / Windsurf complète

C'est l'inversion de boucle : ce ne sont plus desktop/cli qui appellent un LLM, c'est l'agent (Claude / Cursor) qui *est* le LLM et qui se voit demander de résoudre. GitWand reste agnostique du provider.

### 5.2 Provider `endpoint: "mcp"` côté desktop

Quand l'utilisateur sélectionne `mcp` dans le picker (§1.1) :

- L'endpoint construit côté desktop pointe sur `@gitwand/mcp` local (stdio transport) — détection automatique via la même logique que le panel "MCP" v2.10
- Le prompt envoyé à `mcp` est routé vers le tool `resolve_hunk` (cf. §5.1) du serveur MCP
- L'avantage utilisateur : pas d'API key à fournir, le LLM est celui de l'agent connecté

**Différable** si la priorité est de livrer le tie-in API directe avant le tie-in MCP. Marquer §5.2 comme "Phase 2" si on veut shipper v2.5 plus vite.

---

## §6 — Documentation & communication

### 6.1 Page docs website

Nouvelle page `website/docs/features/llm-fallback.md` :

- Pourquoi opt-in (sécurité, confidentialité, coût, non-déterminisme)
- Comment activer (Settings UI + flag CLI + `.gitwandrc`)
- Quels providers supportés + matrice
- Politique de validation (`minPostMergeScore`, `minMode: "strict"`)
- Audit trail (`LlmTrace` : ce qui est loggé, où, comment l'inspecter)
- Comment révoquer une résolution LLM (bouton Reject UI, fallback `complex` CLI)
- FAQ : "Mon code part-il chez Anthropic / OpenAI ?", "Combien ça coûte ?", "Puis-je revoir avant commit ?"

### 6.2 Article de blog v2.5

Sujet pré-acquis dans le plan éditorial CORE-V2-ROADMAP : "Le LLM comme dernier recours bien-encadré — pourquoi le ConGra-mini change la donne".

- Référence à ConGra (arXiv:2409.14121) et Project Harmony pour le contexte académique
- Comparaison frontale : auto-resolve déterministe v2.4 (faux-négatifs zéro) vs LLM v2.5 (gain quantitatif, faux-positifs traçables)
- Architecture du pattern `llm_proposed` priorité 998 avec injection endpoint (le core ne fait pas de fetch — pourquoi)
- Démo vidéo : conflit complexe TS, LLM propose, score validation 92, accepté → commit propre
- Cas de rejet : LLM propose, score 65, refusé → bascule manuel — pourquoi c'est *par design*

---

## §7 — Validation & tests

### 7.1 Bench régression ConGra-mini

Critère "done" de v2.5 dans CORE-V2-ROADMAP : "résout au moins 80 % des hunks `complex` du ConGra-mini sans régression sur le reste".

- Construire un dataset `packages/core/src/__tests__/fixtures/congra-mini/` (10-20 conflits représentatifs)
- Test `congra-mini.bench.ts` avec endpoint mocké déterministe (réponses pré-enregistrées)
- CI : seuil minimal 80 % résolus, sinon build rouge

### 7.2 Test d'intégration desktop → core

`apps/desktop/src/__tests__/llm-fallback.test.ts` :

- Stub `useAIProvider.toLlmEndpoint()` qui retourne un endpoint mock déterministe
- Active `llmFallback.enabled` via config
- Vérifie que `resolveAsync` est bien appelé avec l'endpoint, que la `LlmTrace` est présente dans le résultat, que `LlmTracePanel.vue` la rend correctement
- Vérifie le path de rejet : `onLlmReject` downgrade vers `complex` et ouvre le merge editor manuel

---

## §8 — Clôture

### 8.1 Mise à jour roadmap

Une fois §1 → §7 livrés :

- ROADMAP.md : ajouter `✅` au titre de v2.5.0 dans la section "Core engine — v2 sequence", étoffer la sous-section avec les fichiers réellement touchés (miroir du pattern utilisé pour v2.1, v2.2, v2.3, v2.4.1, v2.6.0)
- CORE-V2-ROADMAP.md : ajouter `✅` au titre §v2.5.0, mettre à jour le "Critère de done" avec les chiffres réels du ConGra-mini
- CHANGELOG.md : entrée détaillée
- Bump versions via `./scripts/bump-version.sh 2.6.0` (toutes les packages alignées, pattern v2.5 mais cette fois on a un vrai tie-in à shipper)

---

## Risques & décisions à prendre

1. **`endpoint: "mcp"` Phase 1 ou Phase 2 ?** — Phase 1 = ship tout en une release v2.6 (plus long). Phase 2 = ship desktop+CLI d'abord, MCP en v2.7 (plus rapide, mais moins propre).
2. **Quel modèle par défaut ?** — `claude-sonnet-4-6` est le defaut spec'é. Vérifier que c'est cohérent avec les recommandations Settings AI existantes (qui peut pointer sur `claude-opus-4-6` ou autre).
3. **Coût utilisateur** — un conflit complex avec 50 lignes de contexte = ~2-5 K tokens prompt + ~500 réponse. À 3 $/MTok input (Sonnet), ~0.015 $ par hunk. Documenter le calcul dans la FAQ §6.1.
4. **Politique `prefer-safety` skipping** — déjà câblé côté core (`resolver/policy.ts`). Vérifier UX desktop : le toggle Settings ne doit pas mentir si la policy active rend le LLM inopérant. Idée : afficher un warning sous le toggle quand `policy ∈ {prefer-safety, strict}`.
5. **TDZ Vue** — le pattern documenté en mémoire (`watch immediate` avant declarations) doit être respecté dans `LlmTracePanel.vue` et `SettingsPanel.vue` extensions.

---

## Ordre de livraison recommandé

1. §1.0 + §1.1 + §1.2 (Settings UI + persistance) — feature toggle visible, même sans wiring
2. §2.1 + §2.2 (wiring `useGitWand` ↔ `useAIProvider`) — première résolution LLM end-to-end
3. §3.1 + §3.2 (UI DecisionTrace) — UX complète
4. §7.2 (test d'intégration) — verrouille avant CLI/MCP
5. §4 (CLI) — agentic workflows hors desktop
6. §5 (MCP) — facultatif si on coupe en deux phases
7. §6.1 + §6.2 (docs + blog) — communication
8. §7.1 (bench régression) — valide le critère de done
9. §8.1 (clôture roadmap + bump version)
