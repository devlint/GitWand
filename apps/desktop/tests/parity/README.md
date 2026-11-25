# Parity tests — Rust ↔ Node

Ces tests valident que **le backend Rust** (`src-tauri/src/lib.rs`) et
**le dev-server Node** (`dev-server.mjs`) produisent **la même sortie** pour
une commande Git donnée sur un repo déterministe.

Pourquoi : GitWand maintient **deux implémentations** de chaque commande
(Rust pour Tauri, Node pour le mode dev/web). Toute dérive entre les deux
se manifeste tôt ou tard en un bug frontend — « marche en dev, pas en app ».
Ces tests détectent ces dérives mécaniquement, avant le merge.

## Prérequis

Compiler le binaire `parity-probe` (une seule fois, puis après chaque
modif de `lib.rs`) :

```sh
cd apps/desktop/src-tauri
cargo build --example parity-probe
```

Le binaire sort à `apps/desktop/src-tauri/target/debug/examples/parity-probe`.

> **Pourquoi un `[[example]]` et pas un `[[bin]]` ?** tauri-bundler
> auto-découvre toutes les entrées `[[bin]]` d'un package et tente de les
> embarquer comme binaires externes — même celles protégées par
> `required-features`. Un `[[example]]` est invisible pour tauri-bundler
> tout en restant un vrai binaire exécutable (cf. v1.5.1 release failure).

Alternative : pointer sur un binaire pré-build via l'env var `PARITY_PROBE` :

```sh
PARITY_PROBE=/path/to/parity-probe pnpm --filter @gitwand/desktop test:parity
```

Hook de test : `GITWAND_COMBINED_BUDGET_BYTES` remplace le budget de 16 MB du
diff combiné, lu par le probe et par `dev-server.mjs` seulement (jamais par
l'app livrée : la commande Tauri n'a pas de paramètre de budget). La suite
`git-combined-diff` le passe via `startDevServer({ env })` et
`assertParity(..., { probeEnv })`.

## Exécution

```sh
# Depuis la racine du monorepo
pnpm --filter @gitwand/desktop test:parity
```

Les tests ne sont **pas** lancés par `pnpm test` par défaut : ils ont leur
propre config (`vitest.config.parity.ts`) et leur propre script, car ils
dépendent d'un binaire Rust à builder et lancent des sous-process.

## Ajouter un test pour une nouvelle commande

Recette à trois étapes :

### 1. Exposer la fonction Rust

**Attention** : `#[tauri::command]` génère un helper `pub struct __cmd__<fn>`
qui entre en conflit avec un `pub fn` de même nom (E0255 au build). On
garde donc la commande Tauri **privée** et on ajoute un wrapper public.

Dans `src-tauri/src/lib.rs`, au bloc *Parity probe re-exports* (en bas du
fichier, juste avant `pub fn run()`), ajouter :

```rust
pub fn git_foo_parity(cwd: String, ...) -> Result<FooOutput, String> {
    git_foo(cwd, ...)
}
```

Laisser la fn `git_foo` elle-même telle quelle (privée + `#[tauri::command]`).

### 2. Brancher le probe

Dans `src-tauri/examples/parity_probe.rs`, ajouter une branche au `match` :

```rust
"git-foo" => {
    let input: FooInput = serde_json::from_str(&stdin_json)?;
    to_json(git_foo_parity(input.cwd, ...))
}
```

Où `FooInput` est un struct local au probe (pas besoin de pub) qui décrit
les args JSON. Recompiler (`cargo build --example parity-probe`).

### 3. Écrire le test

Dupliquer `git-status.test.mjs` → `git-foo.test.mjs`, adapter :

```js
await assertParity(dev, {
  command: "git-foo",
  args: { cwd, /* args Rust */ },
  httpPath: `/api/git-foo?cwd=${encodeURIComponent(cwd)}&...`,
});
```

Si la commande a des champs **volatils** (timestamps, paths absolus qui
incluent le tmpdir système, etc.), les déclarer dans `normalize.mjs` en
ajoutant un `case "git-foo":` qui appelle `blankVolatile(camel, [...])`.

Si la commande **écrit** (POST), fournir `method: "POST"` + `body`.

## Architecture interne

```
tests/parity/
├── fixtures.mjs           ── Repos Git déterministes (hashes reproductibles)
├── probe.mjs              ── Wrapper stdin/stdout autour du binaire Rust
├── dev-server-runner.mjs  ── Lance dev-server.mjs sur un port éphémère
├── normalize.mjs          ── snake→camel + gomme champs volatils
├── harness.mjs            ── assertParity(dev, { command, args, httpPath })
└── git-*.test.mjs         ── Tests par commande
```

Chaque suite lance son propre dev-server (`beforeAll`/`afterAll`) pour éviter
tout state partagé entre fichiers de test.

## Déterminisme des fixtures

Toutes les fixtures fixent via env var Git :

- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` — identité stable
- `GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE` — date ancrée en 2024-01-01 UTC,
  incrémentée de 1 seconde par commit
- `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null` — isoler
  des configs personnelles (`user.signingkey`, `commit.gpgsign`, etc.)

Conséquence : les **hashes de commit sont reproductibles** d'une machine
à l'autre. Si un test échoue parce qu'un hash diffère, c'est une vraie
divergence Rust/Node, pas du bruit environnemental.

## Le probe et le trousseau macOS (keychain)

Les commandes de forge (`gh-enable-auto-merge`, `gh-disable-auto-merge`, et
toute future commande passant par `github_api::settings_github_token()`) lisent
le trousseau macOS pour savoir si un token GitHub est configuré. C'est un
comportement correct et voulu : c'est ce qui permet à un utilisateur avec
token de passer par le chemin GraphQL plutôt que par le CLI `gh`.

Le binaire `parity-probe` n'est pas signé. Sur macOS, le **premier** accès au
trousseau par un binaire fraîchement compilé (après tout `cargo build
--example parity-probe`) bloque sur une décision d'autorisation OS, qui peut
prendre plusieurs minutes avant que macOS ne réponde. `runProbe` (`probe.mjs`)
tue le process au bout de 10 s, et le résultat (`exitCode: -1`,
`error` contenant `"ETIMEDOUT"`) ressemble à s'y méprendre à un vrai échec de
la commande testée.

Relancer la suite ne résout PAS ce blocage : le timeout de 10 s de la suite
est plus court que le délai d'autorisation OS, donc chaque run de la suite
tue le probe avant que macOS ait fini de répondre, et la décision n'est
jamais mémorisée. `tests/parity/auto-merge-refusal.test.mjs` détecte cette
forme de timeout (`looksLikeProbeTimeout`) et lève une erreur explicite
plutôt que de laisser le test échouer avec un message qui ressemble à une
divergence Rust/Node ordinaire.

Le vrai remède : lancer le probe UNE FOIS, directement, sans timeout, et
laisser macOS répondre jusqu'au bout, ce qui peut prendre plusieurs minutes
(mesuré : 235 s sur un run, plus de 600 s sur un autre). Ne pas tuer la
commande en pensant qu'elle est bloquée, sinon la décision reste incomplète
et le prochain run retombe dans le même blocage. Exemple :

```bash
echo '{"cwd":"/tmp/anyrepo","number":1,"method":"squash"}' \
  | src-tauri/target/debug/examples/parity-probe gh-enable-auto-merge
```

Une fois cet appel direct terminé, la suite `pnpm test:parity` passe
normalement (la décision est mémorisée pour ce binaire).

CI n'est pas affecté : il n'y a ni trousseau ni token configuré sur les
runners, donc `settings_github_token()` retourne toujours `None` et les deux
commandes suivent systématiquement le chemin CLI `gh` (le premier `if let
Some(tok) = ...` échoue silencieusement), sans jamais toucher au trousseau.

## Pourquoi pas juste `fetch` côté Rust aussi ?

On pourrait lancer un second serveur HTTP en Rust et `fetch` des deux
côtés. On a préféré le modèle « probe stdio » parce que :

1. Pas de port à gérer côté Rust (moins de flakiness parallèle).
2. Chaque invocation est une exécution propre — pas de state inter-tests.
3. Le binaire probe est un `[[example]]` — jamais construit ni embarqué
   par le bundle Tauri livré, contrairement à un serveur qui pollue `lib.rs`.
