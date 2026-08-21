/**
 * Fixture builders pour les tests de parité Rust↔Node (P2.3).
 *
 * Chaque fonction crée un repo Git temporaire deterministe dont la forme
 * est connue, pour que les deux backends (Rust via `parity-probe` et Node
 * via `dev-server.mjs`) puissent être appelés dessus et que leurs sorties
 * soient comparables.
 *
 * Déterminisme : on fixe l'identité auteur ET les dates (auteur + committer)
 * à des valeurs constantes via des variables d'environnement Git. Sans ça,
 * les hashes de commit varient entre runs et rendent les tests de parité
 * inopérants.
 *
 * Tous les chemins sont retournés normalisés (realpath) — sur macOS notamment,
 * `/var/folders/...` résout vers `/private/var/folders/...` et le dev-server
 * vs parity-probe pourraient en produire des versions divergentes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Identité stable pour tous les commits de fixtures. */
const FIXTURE_AUTHOR_NAME = "GitWand Parity";
const FIXTURE_AUTHOR_EMAIL = "parity@gitwand.test";
/** Date ancrée (2024-01-01T00:00:00Z) — hashes de commit reproductibles. */
const FIXTURE_DATE = "2024-01-01T00:00:00+0000";

/**
 * Environnement à passer à `git` pour obtenir des commits déterministes :
 * auteur + committer + dates alignés. La date est incrémentée par commit
 * appelant pour éviter d'avoir plusieurs commits avec le même timestamp
 * (git n'aime pas, mais accepte — mieux vaut les séparer).
 */
function commitEnv(index = 0) {
  const iso = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
  // Git attend un format "YYYY-MM-DD HH:MM:SS +ZZZZ" ou ISO. On utilise l'ISO.
  return {
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR_EMAIL,
    GIT_COMMITTER_DATE: iso,
    // On désactive toute config utilisateur globale qui pourrait se glisser.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

/** Crée un tmpdir vide + initialise un repo git dedans. Retourne le realpath. */
export function mkTempRepo(label = "gw-parity-") {
  const raw = mkdtempSync(join(tmpdir(), label));
  const cwd = realpathSync(raw); // normaliser sur /private/var/... (macOS)
  execFileSync("git", ["init", "--initial-branch=main", "--quiet", cwd], {
    env: { ...process.env, ...commitEnv() },
  });
  execFileSync("git", ["-C", cwd, "config", "user.name", FIXTURE_AUTHOR_NAME]);
  execFileSync("git", ["-C", cwd, "config", "user.email", FIXTURE_AUTHOR_EMAIL]);
  return cwd;
}

/**
 * Crée un fichier, stage et commit le. `index` incrémente la date du commit
 * pour garder un ordre causal explicite.
 */
export function commitFile(cwd, relPath, content, message, index) {
  const abs = join(cwd, relPath);
  const parent = join(cwd, "..");
  // Créer le parent du fichier (permet les chemins imbriqués).
  const fileDir = join(abs, "..");
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(abs, content, "utf-8");
  execFileSync("git", ["-C", cwd, "add", "--", relPath]);
  execFileSync("git", ["-C", cwd, "commit", "-m", message, "--quiet"], {
    env: { ...process.env, ...commitEnv(index) },
  });
  void parent; // suppress unused var
}

/**
 * Fixture « clean » : 3 commits sur `main`, arbre propre.
 *
 * Couvre le cas nominal de git_status (clean) et git_log (linéaire).
 */
export function fixtureClean() {
  const cwd = mkTempRepo("gw-clean-");
  commitFile(cwd, "README.md", "# Parity Fixture\n", "initial commit", 0);
  commitFile(cwd, "a.txt", "alpha\n", "add a.txt", 1);
  commitFile(cwd, "b.txt", "beta\n", "add b.txt", 2);
  return cwd;
}

/**
 * Fixture « remote Cursor Origin » : un commit, plus un remote `origin`
 * pointant sur le host git d'Origin (`origin.cursor.com`).
 *
 * Aucun accès réseau : `git remote add` n'effectue aucune connexion, et
 * `git remote -v` — la seule commande que `git_remote_info` exécute — lit
 * uniquement `.git/config`.
 */
export function fixtureCursorOriginRemote() {
  const cwd = mkTempRepo("gw-cursor-remote-");
  commitFile(cwd, "README.md", "# Parity Fixture\n", "initial commit", 0);
  execFileSync("git", [
    "-C", cwd, "remote", "add", "origin",
    "https://origin.cursor.com/acme/checkout.git",
  ]);
  return cwd;
}

/**
 * Fixture « dirty » : 3 commits, un fichier modifié non stagé, un nouveau
 * fichier untracked, un fichier stagé.
 *
 * Couvre les sections `unstaged`, `staged`, `untracked` de git_status.
 */
export function fixtureDirty() {
  const cwd = mkTempRepo("gw-dirty-");
  commitFile(cwd, "README.md", "# Parity Fixture\n", "initial commit", 0);
  commitFile(cwd, "a.txt", "alpha\n", "add a.txt", 1);
  commitFile(cwd, "b.txt", "beta\n", "add b.txt", 2);

  // a.txt modifié (unstaged)
  writeFileSync(join(cwd, "a.txt"), "alpha MODIFIED\n", "utf-8");
  // c.txt nouveau fichier stagé
  writeFileSync(join(cwd, "c.txt"), "gamma\n", "utf-8");
  execFileSync("git", ["-C", cwd, "add", "--", "c.txt"]);
  // d.txt untracked
  writeFileSync(join(cwd, "d.txt"), "delta\n", "utf-8");

  return cwd;
}

/**
 * Fixture « branches » : main + 2 branches locales divergentes.
 *
 * Couvre git_branches (enum + ahead/behind) et garantit qu'au moins une
 * branche non-courante est présente.
 */
export function fixtureBranches() {
  const cwd = mkTempRepo("gw-branches-");
  commitFile(cwd, "README.md", "# Parity\n", "initial commit", 0);
  commitFile(cwd, "a.txt", "alpha\n", "add a.txt", 1);

  // Branche feature/alpha, 1 commit de plus
  execFileSync("git", ["-C", cwd, "checkout", "-b", "feature/alpha", "--quiet"]);
  commitFile(cwd, "alpha.txt", "on alpha\n", "alpha: add alpha.txt", 2);

  // Retour main + autre branche feature/beta
  execFileSync("git", ["-C", cwd, "checkout", "main", "--quiet"]);
  execFileSync("git", ["-C", cwd, "checkout", "-b", "feature/beta", "--quiet"]);
  commitFile(cwd, "beta.txt", "on beta\n", "beta: add beta.txt", 3);

  // On revient sur main pour que ce soit le HEAD courant.
  execFileSync("git", ["-C", cwd, "checkout", "main", "--quiet"]);

  return cwd;
}

/**
 * Fixture « stash » : 2 commits + 2 stashes.
 *
 * Couvre git_stash_list.
 */
export function fixtureStash() {
  const cwd = mkTempRepo("gw-stash-");
  commitFile(cwd, "README.md", "# Parity Fixture\n", "initial commit", 0);
  commitFile(cwd, "a.txt", "alpha\n", "add a.txt", 1);

  // Premier stash : modif de a.txt
  writeFileSync(join(cwd, "a.txt"), "alpha STASH 1\n", "utf-8");
  execFileSync("git", ["-C", cwd, "stash", "push", "-m", "first stash", "--quiet"], {
    env: { ...process.env, ...commitEnv(2) },
  });

  // Second stash : nouveau fichier (untracked → --include-untracked requis,
  // sinon `git stash push` l'ignore silencieusement et ne crée aucun stash).
  writeFileSync(join(cwd, "b.txt"), "beta STASH 2\n", "utf-8");
  execFileSync(
    "git",
    ["-C", cwd, "stash", "push", "--include-untracked", "-m", "second stash", "--quiet"],
    {
      env: { ...process.env, ...commitEnv(3) },
    },
  );

  return cwd;
}

/**
 * Fixture « submodule » : un dépôt parent qui embarque un submodule `libs/inner`.
 *
 * Couvre `git_submodule_branches` (les branches du sous-dépôt) et
 * `git_commit_submodule_changes` (le commit du parent qui pose le gitlink).
 * La parité ne dépend pas du déterminisme des SHAs : Rust et Node lisent le
 * MÊME repo sur disque, donc leurs sorties doivent coïncider quoi qu'il arrive.
 *
 * @returns {{ cwd: string, subPath: string }} chemin du parent + chemin relatif du submodule
 */
export function fixtureSubmodule() {
  // 1. Sous-dépôt autonome avec un commit.
  const subRepo = mkTempRepo("gw-sub-inner-");
  commitFile(subRepo, "lib.txt", "lib v1\n", "sub: initial", 0);

  // 2. Dépôt parent.
  const cwd = mkTempRepo("gw-sub-parent-");
  commitFile(cwd, "README.md", "# Parent\n", "initial commit", 0);

  // 3. Ajout du submodule. `protocol.file.allow=always` est requis depuis les
  //    versions récentes de git pour cloner via un chemin local (file://).
  const env = { ...process.env, ...commitEnv(1) };
  execFileSync(
    "git",
    ["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "add", subRepo, "libs/inner"],
    { env },
  );
  execFileSync("git", ["-C", cwd, "commit", "-m", "add submodule libs/inner", "--quiet"], { env });

  return { cwd, subPath: "libs/inner" };
}
