/**
 * Lance/arrête un `dev-server.mjs` isolé pour chaque suite de tests de parité.
 *
 * On préfère lancer un process dédié (plutôt que d'importer le module) pour
 * deux raisons :
 *  1. Le serveur bind un port réel — on reste au plus près du comportement
 *     observable depuis le frontend (CORS, JSON wire format, codes HTTP).
 *  2. Éviter d'introduire du state global dans vitest (dev-server met en
 *     cache des tokens, config git, etc.).
 *
 * Le port est demandé à l'OS (port 0) plutôt que fixé : on évite les
 * collisions si plusieurs suites tournent en parallèle ou si un autre
 * process utilise déjà le port par défaut du dev-server.
 *
 * Note : le dev-server n'a pas nativement de log "ready" — on le considère
 * prêt dès qu'il accepte une connexion TCP sur son port d'écoute. On sonde
 * avec un petit retry pour laisser le temps au `listen()` de se poser.
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** `apps/desktop/dev-server.mjs` — résolu depuis ce fichier. */
const DEV_SERVER = join(here, "..", "..", "dev-server.mjs");

const READY_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

/** Petite boucle d'attente passive jusqu'à ce qu'un port TCP accepte une connexion. */
async function waitForPort(port, deadline) {
  while (Date.now() < deadline) {
    try {
      await new Promise((res, rej) => {
        const s = createConnection({ port, host: "127.0.0.1" });
        s.once("connect", () => { s.destroy(); res(); });
        s.once("error", (e) => { s.destroy(); rej(e); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  throw new Error(`dev-server did not open port ${port} within ${READY_TIMEOUT_MS}ms`);
}

/**
 * Démarre le dev-server. Retourne un handle `{ port, fetch, stop }` où :
 *  - `port`  : port d'écoute alloué (utile pour le debug)
 *  - `fetch(pathAndQuery, init?)` : wrapper qui préfixe l'URL avec
 *    `http://127.0.0.1:<port>` ; retourne la Response native.
 *  - `stop()` : coupe le process et attend sa fin.
 */
export async function startDevServer() {
  // On demande l'allocation d'un port libre via un listener éphémère, qu'on
  // ferme immédiatement après avoir récupéré son port. Ce n'est pas 100 %
  // race-free (un autre process pourrait réclamer ce port entre-temps) mais
  // en pratique c'est fiable pour des tests locaux.
  const port = await new Promise((resolve, reject) => {
    const net = createConnection;
    // Plutôt qu'une connect, on écoute sur 0 pour obtenir un port libre.
    // On utilise net.createServer (importation dynamique légère).
    import("node:net").then(({ createServer }) => {
      const srv = createServer();
      srv.unref();
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address()?.port;
        srv.close(() => (p ? resolve(p) : reject(new Error("no port"))));
      });
      srv.on("error", reject);
    }).catch(reject);
    void net;
  });

  const child = spawn("node", [DEV_SERVER, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  // Collecte les logs pour diagnostic si le process meurt avant d'être prêt.
  const logBuf = [];
  child.stdout.on("data", (d) => logBuf.push(d.toString()));
  child.stderr.on("data", (d) => logBuf.push(d.toString()));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  try {
    await waitForPort(port, deadline);
  } catch (e) {
    child.kill("SIGKILL");
    throw new Error(`${e.message}\ndev-server output:\n${logBuf.join("")}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    /**
     * `Connection: close` on every request, deliberately.
     *
     * Node's global fetch (undici) pools keep-alive sockets, and the
     * dev-server keeps Node's default `keepAliveTimeout` of 5 s. A suite whose
     * gap between two requests exceeds that gets handed a socket the server
     * has already closed, and the next request fails with ECONNRESET rather
     * than with anything about the route under test.
     *
     * That is easy to miss because it depends on wall-clock timing: it only
     * showed up once a suite doing real rebases on two clones per test made
     * the gap long enough, and then only under full-suite load. Opting out of
     * connection reuse costs a negligible handshake per request and removes
     * the whole class of failure for every parity suite, not just the slow one.
     */
    async fetch(pathAndQuery, init) {
      return fetch(`${baseUrl}${pathAndQuery}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), connection: "close" },
      });
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      // Attente courte : le dev-server répond bien à SIGTERM.
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 500);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
