# GitWand desktop — Performance benches (P6.1)

Bench suite pour détecter les régressions sur les hot paths critiques.
Pensée pour tourner :
- en local pendant le développement (`pnpm bench`),
- en CI sur chaque PR (workflow `.github/workflows/perf.yml`),
- comme baseline reproductible avant un chantier d'optim (la valeur de référence à battre).

## Hot paths benchés

| Commande | Cible | Pourquoi |
|---|---|---|
| `git_status` (libgit2) | < 5 ms median, < 15 ms p95 | Polled toutes les 2 s — le coût se voit |
| `git_status` (CLI fallback) | < 25 ms median, < 60 ms p95 | Référence de robustesse |
| `git_log` 50 commits | < 30 ms median, < 80 ms p95 | Boot d'écran historique |
| `git_branches` | < 10 ms median | Palette de recherche |

Les cibles sont indicatives — la vérité est "pas de régression > 15 % vs. baseline". Les chiffres absolus dépendent de la machine.

## Méthodologie

1. **Fixture** : un repo Git temporaire généré déterministiquement avec
   un nombre connu de commits, branches, fichiers modifiés. Évite la
   variance d'un repo réel qui change.
2. **Probe** : on appelle le binaire `parity-probe` (déjà utilisé pour les
   tests de parité) avec timing haute précision (`process.hrtime.bigint()`).
   Pas d'overhead JS supplémentaire — le binaire fait exactement ce que
   ferait l'app à runtime.
3. **Échantillonnage** : N=50 itérations par commande, après 5 itérations de
   warmup (ignorées). On rapporte median + p95 + écart-type.
4. **Comparaison** : si `baseline.json` existe, on émet un avertissement
   quand une métrique régresse > 15 %, et le script sort en code 1 pour
   faire échouer la CI.

## Commandes

```bash
# Build le probe sur le profil `ci` (thin LTO, 16 codegen-units — voir
# [profile.ci] dans Cargo.toml). Les médianes mesurées (31-46 ms) sont
# dominées par le spawn de `git`, donc le LTO fat de `release` n'apportait
# rien ici, juste du temps de compil en plus.
cd apps/desktop/src-tauri && cargo build --example parity-probe --profile ci

# Run le bench (génère fixture + boucle + dump JSON) — depuis apps/desktop
cd apps/desktop && node perf/bench.mjs

# Comparer contre baseline (sortie non-zéro si régression > 15%)
node perf/bench.mjs --check-against perf/baseline.json

# Mettre à jour la baseline après une optim validée
node perf/bench.mjs --write-baseline perf/baseline.json
```

Ou, via les scripts npm équivalents (`pnpm bench`, `pnpm bench:check`,
`pnpm bench:write-baseline` dans `apps/desktop/package.json`), qui buildent
le probe sur `--profile ci` puis lancent `perf/bench.mjs` avec les bons
chemins.

## Format des résultats

```jsonc
{
  "timestamp": "2026-05-07T20:30:00Z",
  "commit":    "abc1234",
  "machine":   { "platform": "darwin", "arch": "arm64", "cpus": 8 },
  "results": {
    "git_status": {
      "samples":   50,
      "median_ms": 4.2,
      "p95_ms":    8.9,
      "stddev_ms": 1.1,
      "min_ms":    3.1,
      "max_ms":    12.4
    }
    // ...
  }
}
```

## Quand mettre à jour la baseline

Mettre à jour **uniquement** :
- Après un chantier d'optim validé (les chiffres descendent — c'est le but).
- Après un changement de machine de référence en CI (les chiffres montent
  pour cause de hardware différent — pas une vraie régression).

**Ne pas** rafraîchir la baseline pour cacher une régression. Si la PR
fait monter un metric > 15 %, il faut comprendre pourquoi avant de lock
les nouveaux chiffres.

## Limitations connues

- Le bench n'évalue **pas** le frontend (Vue mount, parsing diff JSON,
  Vite bundle size). Voir `apps/desktop/perf/bundle-check.mjs` pour la
  partie taille de bundle (à venir).
- Le bench ne mesure pas l'IPC Tauri (frontend ↔ Rust roundtrip), juste
  le coût Rust pur. Pour mesurer le full stack, profile manuel via
  DevTools dans une build avec `tauri = { features = ["devtools"] }`.
- Le fixture est synthétique. Pour un repo réel pathologique (gros mono-
  repo, énormes fichiers binaires), prévoir un bench séparé avec un
  chemin de repo passé en argument.
