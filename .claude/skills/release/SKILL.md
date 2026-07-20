---
name: release
description: "Guide a clean GitWand release end-to-end: bump version, update CHANGELOG, commit, tag, and push. Trigger on: make a release, bump version, publish to npm, ship a new version, create a git tag, update CHANGELOG, release desktop, release CLI, release packages."
---

# Release — Guide étape par étape

## Étape 0 — Identifier le scope

Demander à l'utilisateur quel scope releaser (sauf si le contexte est évident) :

| Scope | Ce qui est publié | Tag git |
|---|---|---|
| **monorepo** (défaut) | Tout : desktop + npm packages | `vX.Y.Z` |
| **vscode** | Extension VS Code uniquement | Versioning indépendant |

> Si l'utilisateur dit "je veux bumper la version", "nouvelle release", "publier le CLI", etc. → scope **monorepo** par défaut.

---

## Étape 1 — Vérifications pré-release

Exécuter dans l'ordre, stopper si l'une échoue :

```bash
# 1. Pas de changements non commités
git status

# 2. Sur main (ou branche de release)
git branch --show-current

# 3. À jour avec le remote
git fetch origin && git log origin/main..HEAD --oneline

# 4. Tests passent
pnpm test

# 5. Build réussit
pnpm build
```

**Bloquer et signaler** si une vérification échoue avant de continuer.

---

## Étape 2 — Mettre à jour CHANGELOG.md (racine)

Ouvrir `CHANGELOG.md` (racine du repo) et :

1. Renommer `## [Unreleased]` en `## [X.Y.Z] - YYYY-MM-DD`
2. Ajouter une nouvelle section `## [Unreleased]` vide au-dessus
3. Vérifier que toutes les features/fixes depuis la dernière release sont documentés
4. Ajouter le lien de comparaison en bas du fichier :
   `[X.Y.Z]: https://github.com/devlint/GitWand/releases/tag/vX.Y.Z`

Format attendu (Keep a Changelog) :

```markdown
## [Unreleased]

## [2.4.0] - 2026-04-28
### Added
- Support for .prisma resolver
### Fixed
- Context line detection bug in diff parser
```

---

## Étape 2b — Mettre à jour roadmap.md

Ouvrir `roadmap.md` et :

1. Déplacer les items livrés dans cette release depuis leur section actuelle
   (In Progress / Planned) vers le bloc **Shipped** correspondant à la version.
2. Si des follow-ups ou limitations ont été identifiés pendant le dev, les ajouter
   dans la section planifiée appropriée.

---

## Étape 2c — Mettre à jour website/changelog.md

`website/changelog.md` est le miroir éditorial public — format narratif (prose
et sections thématiques), pas le format Keep a Changelog. Il doit couvrir **tout
l'historique** depuis v0.0.1.

1. Ajouter une nouvelle section `## vX.Y.Z — <Mois> <Année>` en tête (après le
   frontmatter), dans le style éditorial déjà en place.
2. Rédiger le contenu en prose narrative — titres de features, paragraphes
   courts. Pas de listes à puces brutes reprises telles quelles du CHANGELOG.
3. Vérifier que toutes les versions précédentes sont toujours présentes.

> **Ne jamais inventer de versions** absentes du `CHANGELOG.md` racine.

---

## Étape 2d — Mettre à jour le hero announcement (HomeLanding.vue)

`website/.vitepress/theme/HomeLanding.vue` contient un pill d'annonce sur la
hero section (`.hero-announce`, `<a class="hero-announce" href="/changelog">`)
dont le texte vient de la clé i18n **`heroAnnounce`**, dupliquée dans les 5
blocs de locale (`fr:`, `en:`, `es:`, `'pt-BR':`, `'zh-CN':`).

> ⚠️ **`./scripts/bump-version.sh` NE met PAS à jour ce texte.** Le script ne
> touche ce fichier que pour la constante `LATEST` (numéro de version brut) —
> `heroAnnounce` est un texte éditorial qui décrit la feature phare de la
> release, donc il ne peut pas être généré automatiquement. C'est l'oubli le
> plus fréquent de ce skill : si la hero section du site affiche encore
> "Nouveau dans la vX.Y" d'une release précédente, c'est que cette étape a été
> sautée.

1. Repérer les 5 occurrences de `heroAnnounce:` (une par bloc de locale).
2. Réécrire chacune pour refléter la feature la plus marquante de **cette**
   release (même angle éditorial que le titre choisi pour `website/changelog.md`
   à l'étape 2c) — traduire dans les 5 langues, pas juste copier l'anglais.
3. Format observé : `"Nouveau dans la vX.Y — <feature phare, court>"` (fr),
   `"New in vX.Y — <...>"` (en), etc. — garder ce gabarit `vX.Y` (pas `vX.Y.Z`).

---

## Étape 3 — Bumper la version

**Ne jamais éditer les fichiers de version directement.**

Le script met à jour en une seule passe :
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`
- `packages/core/package.json`
- `packages/cli/package.json`
- `packages/mcp/package.json`
- `packages/mcp/server.json` + `packages/mcp/src/server.ts`
- `website/package.json`, `README.md`, `website/.vitepress/theme/HomeLanding.vue`
  (uniquement la constante `LATEST` — **pas** `heroAnnounce`, voir Étape 2d)

```bash
# Depuis la racine du repo
./scripts/bump-version.sh X.Y.Z
```

Après le script, vérifier visuellement :

```bash
git diff --stat
```

---

## Étape 4 — Commit + Tag + Push

```bash
# Commit le bump de version + CHANGELOG + roadmap + website changelog
git add -A
git commit -m "chore: bump version to X.Y.Z"

# Tag (déclenche release.yml et publish.yml)
git tag vX.Y.Z

# Push avec le tag
git push origin main --tags
```

---

## Étape 5 — Surveiller le CI

Rappeler à l'utilisateur de vérifier sur GitHub Actions :

| Workflow | Déclencheur | Durée estimée |
|---|---|---|
| `release.yml` | tag `v*.*.*` | ~15-20 min (3 plateformes) |
| `publish.yml` | tag `v*.*.*` | ~2-3 min |
| `deploy-website.yml` | push sur main | ~3-5 min |

> Pour le desktop : macOS nécessite un Apple Developer ID configuré (code signing + notarisation). Si le workflow échoue sur la step "sign", vérifier les secrets GitHub (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).

---

## Cas particulier — Extension VS Code

Le versioning VS Code est **indépendant** du reste du monorepo (exception à la règle — vsce gère ça) :

```bash
# 1. Éditer manuellement la version
#    packages/vscode/package.json → "version": "X.Y.Z"

# 2. Packager l'extension
cd packages/vscode && pnpm package
# → génère gitwand-vscode-X.Y.Z.vsix

# 3. Publier
vsce publish
# ou upload manuel sur le VS Code Marketplace
```

---

## Erreurs classiques à éviter

- **Bump manuel** — toujours passer par `./scripts/bump-version.sh`, jamais éditer `package.json`, `Cargo.toml` ou `tauri.conf.json` à la main.
- **Tag manquant** — sans le tag `vX.Y.Z`, `release.yml` et `publish.yml` ne se déclenchent pas.
- **CHANGELOG oublié** — mettre à jour avant le commit de bump, pas après.
- **roadmap.md oublié** — déplacer les shipped items dans le même commit de bump.
- **website/changelog.md oublié** — doit être mis à jour dans le même commit.
- **`heroAnnounce` oublié (HomeLanding.vue)** — `bump-version.sh` ne le touche pas (voir Étape 2d) ; la hero section du site reste bloquée sur l'annonce de la release précédente si on ne l'édite pas à la main dans les 5 locales.
- **Push sans `--tags`** — `git push origin main` ne pousse pas les tags. Toujours `git push origin main --tags`.
- **Tests non passés** — vérifier `pnpm test` avant de bumper, pas après.
