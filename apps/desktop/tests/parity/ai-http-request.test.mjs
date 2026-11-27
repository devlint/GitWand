/**
 * Parity tests: `ai_http_request` (Rust, through curl) vs `/api/ai-http-request`
 * (Node dev-server, through fetch).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Only `auth: "none"` requests (an Ollama-style server without a key), sent
 * to a loopback server this file starts: the probe never reads the user's
 * stored key, and refuses any other auth. The open-endpoint question the app
 * may ask before a request is not compared: the dev-server has no native
 * dialog to mirror it (see the route's comment), and loopback is let through
 * without asking anyway.
 *
 * The server echoes what reached it (method, path, the headers both sides
 * set, the body), so a header or body one transport adds and the other does
 * not shows up as a difference.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startDevServer } from "./dev-server-runner.mjs";
import { probePath } from "./probe.mjs";

/** POST /api/ai-http-request, in the same {ok, value, error} shape as runProbe. */
async function nodeAiRequest(dev, args) {
  const res = await dev.fetch("/api/ai-http-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

/** An empty HOME / CURL_HOME for the probe, so no curlrc is read. */
const curlHome = mkdtempSync(join(tmpdir(), "gw-parity-curl-home-"));

/** Each request's own curl/fetch timeout, and the probe's hard stop after it. */
const REQUEST_TIMEOUT_SECS = 3;
const PROBE_KILL_MS = 5_000;
/** Above both requests of a case, run one after the other. */
const CASE_TIMEOUT_MS = 15_000;

/** Run one request through both backends. */
async function both(dev, args) {
  const rust = await runProbeAsync(args);
  const node = await nodeAiRequest(dev, args);
  return { rust, node };
}

/**
 * `runProbe` spawns synchronously, which would block this process and with
 * it the fixture server the probe is talking to: spawn it asynchronously.
 */
function runProbeAsync(args) {
  const bin = probePath();
  if (!existsSync(bin)) {
    throw new Error(
      `parity-probe binary not found at ${bin}\n` +
        "Build it first with: cargo build --example parity-probe\n" +
        "Or set PARITY_PROBE=<path> to an already-built binary.",
    );
  }
  return new Promise((resolve) => {
    // curl honours the proxy variables and fetch does not: without them both
    // reach the loopback fixture directly.
    const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[k];
    // Nor the user's curlrc (CURL_HOME, XDG_CONFIG_HOME, HOME, APPDATA,
    // USERPROFILE: a
    // `location` or `proxy` line would change
    // curl's answer): `run_curl` does not pass `-q` yet (ROADMAP, lot C).
    env.HOME = curlHome;
    env.CURL_HOME = curlHome;
    env.XDG_CONFIG_HOME = curlHome;
    env.APPDATA = curlHome;
    env.USERPROFILE = curlHome;
    const child = spawn(bin, ["ai-http-request"], { stdio: ["pipe", "pipe", "pipe"], env });
    // Never outlive the test: a hung probe would hold the fixture's socket.
    const killer = setTimeout(() => child.kill("SIGKILL"), PROBE_KILL_MS);
    child.on("error", (e) => resolve({ ok: false, error: `spawn failed: ${e.message}`, exitCode: null }));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return resolve({ ok: false, error: err || out, exitCode: code });
      }
      if (code === 0) resolve({ ok: true, value: parsed, exitCode: code });
      else resolve({ ok: false, error: parsed.error ?? err, exitCode: code });
    });
    // A probe that exits before reading (an older binary without this
    // command) closes stdin: the EPIPE is answered by its exit, not thrown.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(args));
  });
}

describe("parity: ai-http-request", { timeout: CASE_TIMEOUT_MS }, () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  /** @type {import("node:http").Server} */
  let upstream;
  let base = "";

  beforeAll(async () => {
    dev = await startDevServer();
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/v1/models" });
          return res.end();
        }
        if (req.url === "/missing") {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "not found" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            path: req.url,
            accept: req.headers.accept ?? null,
            contentType: req.headers["content-type"] ?? null,
            authorization: req.headers.authorization ?? null,
            apiKey: req.headers["x-api-key"] ?? null,
            body,
          }),
        );
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${upstream.address().port}`;
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
    await new Promise((r) => upstream?.close(r));
    rmSync(curlHome, { recursive: true, force: true });
  });

  it("a GET answers the same status and body", async () => {
    const { rust, node } = await both(dev, { method: "GET", url: `${base}/v1/models`, auth: "none", timeoutSecs: REQUEST_TIMEOUT_SECS });
    expect(node.ok, node.error).toBe(true);
    expect(rust).toMatchObject({ ok: true, value: node.value });
    expect(JSON.parse(node.value.body)).toEqual({
      method: "GET",
      path: "/v1/models",
      accept: "application/json",
      contentType: null,
      authorization: null,
      apiKey: null,
      body: "",
    });
  });

  it("a POST sends the same body and content type", async () => {
    const payload = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a \"quoted\"\nline" }] });
    const { rust, node } = await both(dev, {
      method: "POST",
      url: `${base}/v1/chat/completions`,
      body: payload,
      auth: "none",
      timeoutSecs: REQUEST_TIMEOUT_SECS,
    });
    expect(node.ok, node.error).toBe(true);
    expect(rust).toMatchObject({ ok: true, value: node.value });
    expect(JSON.parse(node.value.body)).toMatchObject({ contentType: "application/json", body: payload });
  });

  it("an upstream error status is answered, not thrown", async () => {
    const { rust, node } = await both(dev, { method: "GET", url: `${base}/missing`, auth: "none", timeoutSecs: REQUEST_TIMEOUT_SECS });
    expect(node).toEqual({ ok: true, value: { status: 404, body: JSON.stringify({ error: "not found" }) } });
    expect(rust).toMatchObject({ ok: true, value: node.value });
  });

  it("a redirect is not followed", async () => {
    const { rust, node } = await both(dev, { method: "GET", url: `${base}/redirect`, auth: "none", timeoutSecs: REQUEST_TIMEOUT_SECS });
    expect(node).toEqual({ ok: true, value: { status: 302, body: "" } });
    expect(rust).toMatchObject({ ok: true, value: node.value });
  });

  it.each([
    ["a non-http scheme", { method: "GET", url: "file:///etc/passwd" }],
    ["a URL with credentials", { method: "GET", url: "http://user:pw@127.0.0.1:9/" }],
    ["a URL with whitespace", { method: "GET", url: "http://127.0.0.1:9/a b" }],
    ["an unsupported method", { method: "DELETE", url: "http://127.0.0.1:9/" }],
  ])("%s is refused with the same message", async (_label, args) => {
    const { rust, node } = await both(dev, { ...args, auth: "none", timeoutSecs: REQUEST_TIMEOUT_SECS });
    expect(node.ok).toBe(false);
    expect(rust.ok).toBe(false);
    expect(rust.error).toBe(node.error);
  });
});
