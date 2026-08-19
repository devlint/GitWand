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
 * Lance le probe avec un `command` + des arguments JSON.
 * Retourne un objet `{ ok, value, error, exitCode }`.
 *
 * `value` est le JSON décodé (ou undefined si erreur), `error` est la chaîne
 * d'erreur telle qu'émise par le probe (champ `error` du JSON, ou stderr en
 * cas d'échec d'invocation du binaire).
 */
export function runProbe(command, args) {
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
    encoding: "utf-8",
    timeout: 10_000,
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
