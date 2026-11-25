/**
 * Harness de parité — compare les sorties Rust et Node pour une commande.
 *
 * Usage typique depuis un test :
 *
 *     const dev = await startDevServer();
 *     try {
 *       const cwd = fixtureClean();
 *       await assertParity(dev, {
 *         command: "git-status",
 *         args: { cwd },
 *         httpPath: `/api/git-status?cwd=${encodeURIComponent(cwd)}`,
 *       });
 *     } finally {
 *       await dev.stop();
 *     }
 *
 * Le harness :
 *   1. Invoque le probe Rust avec `command` + `args`.
 *   2. Fait un GET sur `httpPath` du dev-server.
 *   3. Normalise les deux réponses (camelCase + gommage volatils).
 *   4. Les compare via `assert.deepStrictEqual` — en cas de divergence,
 *      lève avec un diff lisible (Node/Vitest le rend bien).
 */

import { deepStrictEqual } from "node:assert/strict";
import { runProbe } from "./probe.mjs";
import { normalize } from "./normalize.mjs";

/**
 * @param {object} dev       handle retourné par startDevServer()
 * @param {object} opts
 * @param {string} opts.command    nom de la commande (ex: "git-status")
 * @param {object} opts.args       args JSON à passer au probe Rust
 * @param {string} opts.httpPath   path+querystring à appeler sur le dev-server
 * @param {"GET"|"POST"} [opts.method="GET"]
 * @param {object} [opts.body]     corps JSON pour POST
 * @param {object} [opts.probeEnv] variables d'env en plus pour le probe Rust
 * @returns {Promise<{rust: any, node: any}>}  les payloads normalisés (utile pour asserts additionnels)
 */
export async function assertParity(dev, { command, args, httpPath, method = "GET", body, probeEnv }) {
  // ── Rust ──────────────────────────────────────────────────
  const probeResult = runProbe(command, args, probeEnv);
  if (!probeResult.ok) {
    throw new Error(
      `parity-probe failed for "${command}": ${probeResult.error}\nargs: ${JSON.stringify(args)}`,
    );
  }
  const rust = normalize(command, probeResult.value);

  // ── Node (dev-server) ─────────────────────────────────────
  const init = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await dev.fetch(httpPath, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`dev-server ${method} ${httpPath} → HTTP ${res.status}: ${text}`);
  }
  const nodeRaw = await res.json();
  const node = normalize(command, nodeRaw);

  // ── Diff ──────────────────────────────────────────────────
  // `deepStrictEqual` lève avec un diff structuré — c'est ce qu'on veut.
  // On annote l'erreur avec le nom de la commande pour que le test rapporte
  // clairement le site de la divergence.
  try {
    deepStrictEqual(rust, node);
  } catch (err) {
    err.message = `parity mismatch on "${command}"\n${err.message}`;
    throw err;
  }

  return { rust, node };
}
