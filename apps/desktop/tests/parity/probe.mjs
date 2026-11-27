/**
 * Wrapper autour du binaire Rust `parity-probe`.
 *
 * Le binaire est compilé comme `[[example]]` via :
 *     cargo build --example parity-probe
 *
 * Par défaut on cherche le binaire à
 * `src-tauri/target/debug/examples/parity-probe`, relatif à ce fichier.
 * L'env var `PARITY_PROBE` permet de surcharger le chemin (utile pour pointer
 * sur `target/ci/examples/...` — le profil léger utilisé par `perf.yml` — ou
 * un binaire pré-build en CI).
 *
 * Le probe lit son JSON d'entrée sur stdin et écrit le résultat sur stdout.
 * On parse stdout en JSON — s'il contient une clé `error`, c'est que la
 * commande a échoué (exit 1 côté Rust). Le harness peut choisir de traiter
 * ce cas comme une égalité si le dev-server renvoie aussi une erreur.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROBE_PATH = join(
  here,
  "..",
  "..",
  "src-tauri",
  "target",
  "debug",
  "examples",
  "parity-probe",
);

/** Résout le chemin effectif du binaire probe (env override > default). */
export function probePath() {
  return process.env.PARITY_PROBE || DEFAULT_PROBE_PATH;
}

/**
 * A minimal environment for a child of a parity test: what the probe, the
 * dev-server, git and curl need to run, plus `extra`. Nothing else from the
 * runner's environment, so no token or API key reaches the child (AGENTS.md)
 * and no proxy variable changes a request. Pass it with `inherit: false`.
 */
export function isolatedEnv(extra = {}) {
  const env = {};
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return { ...env, ...extra };
}

/**
 * Lance le probe avec un `command` + des arguments JSON.
 * Retourne un objet `{ ok, value, error, exitCode }`.
 *
 * `value` est le JSON décodé (ou undefined si erreur), `error` est la chaîne
 * d'erreur telle qu'émise par le probe (champ `error` du JSON, ou stderr en
 * cas d'échec d'invocation du binaire). `env` s'ajoute à l'environnement
 * hérité (ex. `GITWAND_COMBINED_BUDGET_BYTES`, hook de test) ; avec
 * `{ inherit: false }`, il le remplace (voir `isolatedEnv`).
 */
export function runProbe(command, args, env, { inherit = true } = {}) {
  const bin = probePath();
  if (!existsSync(bin)) {
    throw new Error(
      `parity-probe binary not found at ${bin}\n` +
        "Build it first with: cargo build --example parity-probe\n" +
        "Or set PARITY_PROBE=<path> to an already-built binary.",
    );
  }

  const result = spawnSync(bin, [command], {
    input: JSON.stringify(args || {}),
    ...(env ? { env: inherit ? { ...process.env, ...env } : env } : {}),
    encoding: "utf-8",
    timeout: 10_000,
    // A combined diff over thousands of files answers several MB of JSON
    // (spawnSync's default cap is 1 MB).
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, error: result.error.message, exitCode: -1 };
  }

  const stdout = result.stdout?.trim() || "";
  let parsed;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch (e) {
    return {
      ok: false,
      error: `probe returned non-JSON stdout: ${stdout}\nstderr: ${result.stderr}`,
      exitCode: result.status ?? -1,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      error: parsed?.error ?? result.stderr?.trim() ?? "probe failed",
      exitCode: result.status ?? -1,
      value: parsed,
    };
  }

  return { ok: true, value: parsed, exitCode: 0 };
}
