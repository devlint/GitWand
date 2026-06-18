# Plan d'implémentation — Launchpad = écran d'accueil (v3)

> Issu du brainstorm IA de juin 2026. Cible : refondre la navigation autour d'un
> **axe de triage unique à deux niveaux de zoom**. Grosse PR → probable **v3.0.0**.
> Pré-requis déjà mergé : PR #63 (Launchpad hub — inbox « À traiter », nav interne
> PR/Issue, IssueDetailView).

---

## 1. Vision cible

GitWand a **trois altitudes** de « où suis-je », et l'IA doit les rendre évidentes
au lieu d'en mélanger deux :

1. **Tous mes repos ouverts** — « qu'est-ce qui m'attend ? » → **Launchpad (accueil)**
2. **Ce repo** — son état → *absorbé* par le Launchpad scopé sur 1 repo
3. **Ce changement / branche / PR / issue** — le travail → Git Tree / Changements / PrDetailView / IssueDetailView

**Un seul axe de triage, deux niveaux de zoom** : le Launchpad est l'accueil ;
son **scope** va de « Tous » à « un repo » et **le filtre EST le zoom**.
Matin = zoom out (tous les onglets). Après avoir bossé = zoom sur le repo touché.

Boucle de l'utilisateur : **Launchpad (triage) ⇄ Travail** (Tree/Changements, ou
détail PR/Issue). On trie, on plonge, on revient — scopé sur le repo qu'on vient
de toucher.

---

## 2. Décisions verrouillées

- **Launchpad = écran d'accueil** au boot (quand au moins un repo est ouvert).
- **Source des repos = onglets ouverts** (`useRepoTabs`), plus un fichier workspace.
- **Espace de travail (panneau) supprimé** — voir §5 pour le périmètre exact
  (⚠️ le fichier `.gitwand-workspace.json` n'est PAS supprimé : Monorepo Scope en dépend).
- **Tableau de bord supprimé** — on sauve `nextAction` (→ cards), le rendu README
  (→ futur viewer de fichiers), on abandonne l'analytics (ou vue « Insights » optionnelle, parkée).
- **Sidebar masquée** en vue Launchpad.
- **Filtre de scope mémorisé** (défaut : tous les onglets ouverts).
- **Inbox-journal** : `nextAction` dé-plafonné (cards d'état local) + buckets PR/Issue existants, fusionnés en un flux priorisé cross-repo.
- **Lentilles contextuelles** : à l'échelle d'un repo, WIP se fond dans « À traiter » et Team devient muet (ou collègues du repo).

---

## 3. Lots (ordonnés, chacun reviewable)

### Lot 0 — Décrochage : Launchpad alimenté par les onglets
**But** : couper la dépendance au workspace sans rien casser.
- `launchpadRepos` calculé depuis `repoTabs` (`useRepoTabs`) au lieu de `workspaceRead`.
- `handleLaunchpadShortcut` : retirer le gating « no workspace » (toast + ouverture modale).
- `resolveNotifyRepos` (poller notifications) : lire les onglets, pas `gitwand-workspace-dir`.

**Fichiers** : `App.vue`.
**Risque** : faible. Net positif (supprime la friction cold-start).

---

### Lot 1 — Launchpad = accueil + sidebar masquée
**But** : l'app ouvre sur le triage.
- `viewMode` initial = `launchpad` quand des onglets existent (sinon EmptyState).
- Sidebar : `v-if` exclut `viewMode === 'launchpad'`.
- Header : pill Launchpad active au boot.

**Fichiers** : `App.vue` (viewMode initial, `<aside>` v-if), `useGitRepo` (défaut).
**Risque** : **perf de boot** — le Launchpad fetch PR/Issues sur N repos au démarrage.
Mitigation : ne fetch que le scope actif ; Team reste lazy ; réutiliser le SWR cache PR.

---

### Lot 2 — Filtre de scope (first-class, mémorisé)
**But** : « Tous » ↔ sous-ensemble ↔ « un repo », instantané et persistant.
- Sélecteur de scope dans le header du Launchpad (multi-select des onglets ouverts + « Tous »).
- `launchpadScope` persisté dans `AppSettings` (`string[]` de paths, ou `"all"`).
- Toutes les composables Launchpad fetchent uniquement les repos sélectionnés.
- Repo ouvert/fermé → apparaît/disparaît du filtre ; sélection invalide nettoyée au chargement.

**Fichiers** : `LaunchpadView.vue`, `useSettings.ts` (champ + défaut), nouveau `useLaunchpadScope.ts`, les `refresh()` des composables.
**Risque** : `AppSettings` — ajouter le champ + défaut (pas besoin de `SettingsPanel`, réglage non-exposé). Cf. piège « duplicate settings interfaces ».

---

### Lot 3 — Inbox-journal : cards d'action (généraliser `nextAction`)
**But** : « le journal du matin avec le café ».
- Extraire la logique `nextAction` de `DashboardView` dans une composable réutilisable (`useRepoActionCards`).
- Générer un **flux de cards priorisé** cross-repo :
  - état local (par repo, via `workspaceWipAll`) : conflits → commiter → push → publish → sync
  - + buckets PR existants (à reviewer / changes / CI / approuvées)
  - + buckets Issues (assigned / mentioned / created)
- Chaque card a un CTA → navigation interne (Changements / PrDetailView / IssueDetailView / action push-sync).

**Fichiers** : nouveau `useRepoActionCards.ts` (lift de `nextAction`), `useLaunchpadInbox.ts` étendu, panneau « À traiter » de `LaunchpadView.vue`.
**Risque** : moyen. Données déjà dispo (`workspaceWipAll` = staged/unstaged/ahead/behind/conflicted par repo ; buckets codés). Surtout du câblage + priorisation + UX des cards.

---

### Lot 4 — Suppression du Tableau de bord
**But** : retirer la surface, sauver ce qui compte.
- Retirer `dashboard` des `viewMode` + l'onglet sidebar « Tableau de bord ».
- **Sauvegardes** :
  - branches épinglées → Tree/sidebar (ne pas perdre cet affordance).
  - rendu README → garder accessible dans le contexte repo (graine du futur viewer de fichiers, §7).
  - générateur de release notes AI → reloger dans le contexte history/tags.
  - analytics (heatmap, health, contributeurs, types de commit, charts) → **abandon** (ou vue « Insights » optionnelle, parkée).
- `viewMode` par défaut n'est plus `dashboard`.

**Fichiers** : `App.vue`, `RepoSidebar.vue` (view-tabs), suppression `DashboardView.vue` (~2100 lignes), relogement pinned-branches + release-notes.
**Risque** : **le plus engageant / dur à annuler**. Ne pas perdre pinned-branches ni release-notes. Valider par dogfood avant de supprimer définitivement.

---

### Lot 5 — Suppression de l'Espace de travail (panneau)
**But** : retirer le panneau et le couplage, **garder l'infra partagée**.
- Supprimer : `WorkspacePanel.vue`, le pill Workspace du header, le plumbing `showWorkspace`/`openWorkspace`, l'usage de `gitwand-workspace-dir` pour le Launchpad.
- **GARDER** : le type `WorkspaceRepo`, les helpers `workspacePrsAll`/`workspaceIssuesAll`/`workspaceWipAll` (moteur du Launchpad), et **`workspaceRead`/`workspaceWrite`** — voir risque ci-dessous.

**Fichiers** : `AppHeader.vue` (pill + emit), `App.vue` (showWorkspace), suppression `WorkspacePanel.vue`.
**Risque** : ⚠️ **`.gitwand-workspace.json` est de l'infra partagée**, pas seulement le panneau :
- **Monorepo Scope (v2.21)** persiste son `scope` dans ce fichier (`useWorkspaceScope`).
- **Stacked Branches (roadmap v2.25)** prévoit d'y stocker ses métadonnées.
→ Donc on supprime le **panneau** et le **regroupement multi-dépôts**, PAS `workspaceRead/Write`. Le nettoyage des commandes Rust `workspace_read/write` n'est PAS dans ce chantier.

---

### Lot 6 — Lentilles contextuelles selon le scope
**But** : éviter les doublons en zoom-repo.
- Scope = 1 repo → WIP se fond dans « À traiter » (sinon = Changements en double) ; onglet Team muet (ou réduit aux collègues du repo).
- Scope = N repos → jeu de lentilles complet.

**Fichiers** : `LaunchpadView.vue` (visibilité d'onglets selon scope).
**Risque** : faible, surtout de la logique d'affichage.

---

### Lot 7 — Tests, i18n, vérif, bump
- Tests : `useRepoActionCards`, `useLaunchpadScope`, maj `LaunchpadView`/Dashboard-removal.
- i18n 5 locales (scope, cards, libellés).
- `vue-tsc --noEmit` + `vitest` verts ; `cargo build` ; test manuel macOS + Linux AppImage.
- **Bump** via `./scripts/bump-version.sh 3.0.0` (jamais à la main). CHANGELOG + ROADMAP.

---

## 4. Risques transverses

- **`.gitwand-workspace.json` partagé** (Monorepo Scope, futur Stacked) — ne pas casser en supprimant le panneau. (Lot 5)
- **Perf de boot** — Launchpad en accueil = fetch cross-repo au démarrage ; scoper + lazy Team + SWR. (Lot 1)
- **Perte d'affordances** au retrait du Dashboard (pinned-branches, release-notes). (Lot 4)
- **Hypothèse inbox-first** (§6) — à valider par dogfood, n=1 aujourd'hui (Laurent).

---

## 5. Stratégie de livraison

Deux options :
- **(a) Branche v3 unique** — tous les lots, une grosse PR. Cohérent pour un changement d'IA, mais review lourde et risque de long-running branch.
- **(b) Incrémental derrière le Launchpad actuel** — Lots 0→3 d'abord (Launchpad accueil + scope + cards) en gardant le Dashboard accessible, puis Lots 4→5 (suppressions) une fois le dogfood concluant.

**Recommandation** : (b). On dogfoode « Launchpad = accueil » avec le Dashboard encore là comme filet, on valide l'hypothèse inbox-first, **puis** on coupe le Dashboard et le Workspace. Le tag v3.0.0 marque la coupe finale.

---

## 6. Hypothèse la plus risquée (à valider)

> L'utilisateur ouvre GitWand pour **trier cross-repo**, pas pour reprendre une branche.

Validation gratuite : dogfood une semaine (Laurent). Si on tend la main vers la
branche directe plutôt que le triage → reconsidérer l'accueil par défaut
(ex. accueil = dernier repo actif, Launchpad à un raccourci).

---

## 7. Parké (pas dans ce chantier)

- **Viewer de fichiers ref-aware** — kill-feature potentielle (ouvrir n'importe quel
  fichier à n'importe quel ref, sans checkout). Graine = rendu README du Dashboard.
  Chantier dédié, à valider via dogfood de la boucle « lire dans GW / éditer via IA ».
- **Vue « Insights » optionnelle** — recyclage de l'analytics du Dashboard, si regret.
- **Nettoyage Rust** `workspace_read/write` — seulement si Monorepo Scope/Stacked migrent ailleurs.
