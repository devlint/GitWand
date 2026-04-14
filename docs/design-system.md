# GitWand Design System

Version 1.0 — 2026-04-13
Inspiration : dashboard MindPath (hiérarchie typographique forte, cards contrastées, formes pilules) appliquée à l'identité violette existante de GitWand.

## 1. Principes

1. **Identité conservée.** Accent violet `#8b5cf6` reste la signature produit. On emprunte à MindPath la *grammaire visuelle*, pas la palette.
2. **Parité light/dark.** Les deux thèmes sont de première classe. Chaque token a une variante light et dark cohérente.
3. **Contraste de hiérarchie.** Les surfaces clés (hero, panneau actif) peuvent inverser la relation claire/sombre pour créer du relief — comme la card "Stress Level" de MindPath.
4. **Pilules plutôt que rectangles.** Boutons, badges, inputs de filtre → radius élevés (≥ lg). Cards → radius xl à 2xl.
5. **Échelle 4/8 px.** Toutes les mesures (espacement, radius) sont des multiples de 4, pivot à 8.
6. **Tokens en CSS custom properties.** Aucune couleur/taille/ombre hardcodée dans les composants. Toute nouvelle valeur passe par un token.

## 2. Couleurs

### 2.1 Tokens sémantiques

| Token | Rôle |
|---|---|
| `--color-bg` | Fond d'application principal |
| `--color-bg-secondary` | Fond panneaux / cards standard |
| `--color-bg-tertiary` | Fond éléments interactifs au repos, hover subtil |
| `--color-surface-inverse` | Card "hero" contrastée (dark dans thème light, light dans thème dark) |
| `--color-surface-inverse-text` | Texte sur surface inverse |
| `--color-border` | Séparateurs, bordures cards |
| `--color-border-strong` | Séparateurs plus marqués (modals) |
| `--color-text` | Texte principal |
| `--color-text-muted` | Texte secondaire / labels |
| `--color-text-subtle` | Texte tertiaire (timestamps, hints) |
| `--color-accent` | Action primaire, états sélectionnés |
| `--color-accent-hover` | Hover accent |
| `--color-accent-soft` | Tint accent pour badges, pills actifs |
| `--color-accent-text` | Texte sur fond accent (toujours blanc) |
| `--color-success` / `--color-success-soft` | Vert — stagé, résolu |
| `--color-warning` / `--color-warning-soft` | Ambre — modifié |
| `--color-danger` / `--color-danger-soft` | Rouge — conflit, delete |
| `--color-info` / `--color-info-soft` | Bleu — info, untracked |
| `--color-ours` / `--color-ours-bg` | Côté "ours" (merge) |
| `--color-theirs` / `--color-theirs-bg` | Côté "theirs" (merge) |
| `--color-focus-ring` | Anneau focus clavier |

### 2.2 Palette light

Off-white d'ambiance, cards blanches pures, bordure ultra-discrète. Accent conservé en `#7c3aed` (mêmes valeurs qu'actuelles).

- `--color-bg: #f4f4f8`
- `--color-bg-secondary: #ffffff`
- `--color-bg-tertiary: #eceef4`
- `--color-surface-inverse: #15151f` (card hero sombre, comme MindPath Stress Level)
- `--color-surface-inverse-text: #f4f4f8`
- `--color-border: #e4e4ed`
- `--color-border-strong: #cccfda`
- `--color-text: #15151f`
- `--color-text-muted: #5b5b78`
- `--color-text-subtle: #9a9ab0`

### 2.3 Palette dark

Révisée : fonds plus neutres (moins bleutés), accent légèrement adouci.

- `--color-bg: #0d0d13`
- `--color-bg-secondary: #15151f`
- `--color-bg-tertiary: #1f1f2d`
- `--color-surface-inverse: #f4f4f8` (inverse en dark : card claire sur fond sombre)
- `--color-surface-inverse-text: #15151f`
- `--color-border: #262638`
- `--color-border-strong: #353550`
- `--color-text: #ebebf5`
- `--color-text-muted: #8a8aa8`
- `--color-text-subtle: #5d5d78`

## 3. Typographie

Échelle T-shirt, basée sur 1.125 (ratio modeste, dense pour app desktop).

| Token | Taille | Line-height | Usage |
|---|---|---|---|
| `--font-size-xs` | 10px | 1.4 | micro labels, tags |
| `--font-size-sm` | 11px | 1.45 | meta, timestamps |
| `--font-size-base` | 12px | 1.5 | corps UI par défaut |
| `--font-size-md` | 13px | 1.5 | boutons, nav, branch name |
| `--font-size-lg` | 14px | 1.5 | titres de section |
| `--font-size-xl` | 16px | 1.4 | titres de panneaux |
| `--font-size-2xl` | 20px | 1.3 | headings modals |
| `--font-size-3xl` | 26px | 1.2 | hero (EmptyState, stats large) |

Poids : `--font-weight-regular: 400`, `--font-weight-medium: 500`, `--font-weight-semibold: 600`, `--font-weight-bold: 700`.
Letter-spacing titres : `-0.01em`. Labels majuscules : `+0.05em`.

## 4. Espacement

Base 4 px. Tous padding/margin/gap doivent s'ancrer ici.

| Token | Valeur |
|---|---|
| `--space-1` | 2px |
| `--space-2` | 4px |
| `--space-3` | 6px |
| `--space-4` | 8px |
| `--space-5` | 12px |
| `--space-6` | 16px |
| `--space-7` | 20px |
| `--space-8` | 24px |
| `--space-9` | 32px |
| `--space-10` | 40px |
| `--space-11` | 48px |
| `--space-12` | 64px |

Règle : usage privilégié de 4, 8, 12, 16, 24. Les 2/6/20/32 pour ajustements fins.

## 5. Radius

Pilules partout où c'est pertinent.

| Token | Valeur | Usage |
|---|---|---|
| `--radius-xs` | 3px | word-diff highlights, très petits tags |
| `--radius-sm` | 6px | inputs, petits boutons icon-only |
| `--radius-md` | 8px | boutons standard, file items |
| `--radius-lg` | 10px | popovers, dropdowns |
| `--radius-xl` | 14px | cards secondaires |
| `--radius-2xl` | 20px | cards hero, panneaux majeurs |
| `--radius-pill` | 9999px | badges, segments, pills |

## 6. Élévations (shadows)

Ombres adoucies, rgb pré-composé par thème pour lisibilité.

| Token | Usage |
|---|---|
| `--shadow-xs` | subtil — cards internes |
| `--shadow-sm` | hover légers |
| `--shadow-md` | popovers, dropdowns |
| `--shadow-lg` | modals |
| `--shadow-xl` | dialogs de confirmation |

Light : `0 1px 2px rgba(20,20,35,.04)` → `0 24px 48px rgba(20,20,35,.18)`
Dark : `0 1px 2px rgba(0,0,0,.35)` → `0 24px 48px rgba(0,0,0,.6)`

## 7. Transitions

| Token | Valeur | Usage |
|---|---|---|
| `--transition-fast` | 100ms cubic-bezier(.2,.8,.2,1) | hovers micro |
| `--transition-base` | 160ms cubic-bezier(.2,.8,.2,1) | défaut UI |
| `--transition-slow` | 240ms cubic-bezier(.2,.8,.2,1) | popovers, modals |

## 8. Composants primitifs (classes utilitaires)

Déclarés dans `main.css`, ré-utilisables depuis tout composant.

### 8.1 Buttons

- `.btn` — base (inline-flex, gap, radius md, transition base, font medium)
- `.btn--primary` — fond accent, texte blanc
- `.btn--secondary` — fond bg-tertiary, texte standard
- `.btn--ghost` — transparent, hover bg-tertiary
- `.btn--danger` — fond danger, texte blanc
- `.btn--pill` — radius pill, padding horizontal généreux (inspiration MindPath)
- `.btn--icon` — carré 28×28, radius md
- `.btn--sm` — padding 4/10, font-size md
- `.btn--lg` — padding 10/20, font-size lg

### 8.2 Inputs

- `.input` — base (padding 4 8, radius sm, border 1, focus-ring accent)
- `.input--pill` — radius pill, padding horizontal 12

### 8.3 Surfaces

- `.card` — bg secondary, border 1, radius xl, shadow xs
- `.card--hero` — inverse (dark on light, light on dark), radius 2xl
- `.popover` — bg secondary, border, radius lg, shadow md, animation slide

### 8.4 Badges / Pills

- `.badge` — radius pill, padding 2/8, font xs/semibold, tabular-nums
- `.badge--success`, `.badge--warning`, `.badge--danger`, `.badge--info`, `.badge--accent` — versions teintées (fond soft + texte fort)
- `.stat-dot` — 6×6 rond, coloré par couleur sémantique

### 8.5 Segments / tabs

- `.segmented` — group container, bg tertiary, radius pill, padding 2
- `.segmented__item` — radius pill, transition fast ; actif = bg secondary + shadow xs

## 9. Plan d'application

### Phase 1 — Tokens (cette livraison)
Mise à jour `main.css` avec l'ensemble des tokens ci-dessus et primitives `.btn/.input/.card/.badge`. Compatibilité descendante : les anciens noms (`--color-bg`, etc.) restent valides.

### Phase 2 — Pilote (cette livraison)
Refonte `AppHeader.vue` et `RepoTabBar.vue` sur les nouveaux tokens et primitives. Objectif : zéro valeur magique, hauteur header `56px`, tabs en pilules.

### Phase 3 — Surfaces principales
`RepoSidebar.vue`, `EmptyState.vue`, `FolderPicker.vue`, `SettingsPanel.vue`. Introduction de la `.card--hero` sur l'EmptyState.

### Phase 4 — Surfaces PR / diff
`PrInlineDiff.vue`, `PrIntelligencePanel.vue`, `MergePreviewPanel.vue` : suppression des `#a6e3a1 / #89b4fa / #f38ba8` → tokens de severity, remappage des couleurs syntaxiques sur les tokens.

### Phase 5 — Composants spécialisés
`MergeEditor.vue`, `DiffViewer.vue`, `CommitGraph.vue` — modulaires, modification minimale (seulement les tokens).

## 10. Ne pas faire

- Pas de mesures en `em` hors typo ; `px` uniquement pour espace/radius.
- Pas de shadow hardcodée dans un composant.
- Pas de `color: #fff` ; utiliser `--color-accent-text` ou `--color-surface-inverse-text`.
- Pas de nouvelle variante de bouton sans passer par le système (si besoin → on ajoute un modifier documenté ici).
