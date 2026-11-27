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
import { existsSync } from "node:fs";
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
    const child = spawn(bin, ["ai-http-request"], { stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", (e) => resolve({ ok: false, error: `spawn failed: ${e.message}`, exitCode: null }));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return resolve({ ok: false, error: err || out, exitCode: code });
      }
      if (code === 0) resolve({ ok: true, value: parsed, exitCode: code });
      else resolve({ ok: false, error: parsed.error ?? err, exitCode: code });
    });
    child.stdin.end(JSON.stringify(args));
  });
}

describe("parity: ai-http-request", () => {
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
  });

  it("a GET answers the same status and body", async () => {
    const { rust, node } = await both(dev, { method: "GET", url: `${base}/v1/models`, auth: "none", timeoutSecs: 10 });
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
      timeoutSecs: 10,
    });
    expect(node.ok, node.error).toBe(true);
    expect(rust).toMatchObject({ ok: true, value: node.value });
    expect(JSON.parse(node.value.body)).toMatchObject({ contentType: "application/json", body: payload });
  });

  it("an upstream error status is answered, not thrown", async () => {
    const { rust, node } = await both(dev, { method: "GET", url: `${base}/missing`, auth: "none", timeoutSecs: 10 });
    expect(node).toEqual({ ok: true, value: { status: 404, body: JSON.stringify({ error: "not found" }) } });
    expect(rust).toMatchObject({ ok: true, value: node.value });
  });

  it("a redirect is not followed", async () => {
    const { rust, node } = await both(dev, { method: "GET", url: `${base}/redirect`, auth: "none", timeoutSecs: 10 });
    expect(node).toEqual({ ok: true, value: { status: 302, body: "" } });
    expect(rust).toMatchObject({ ok: true, value: node.value });
  });

  it.each([
    ["a non-http scheme", { method: "GET", url: "file:///etc/passwd" }],
    ["a URL with credentials", { method: "GET", url: "http://user:pw@127.0.0.1:9/" }],
    ["a URL with whitespace", { method: "GET", url: "http://127.0.0.1:9/a b" }],
    ["an unsupported method", { method: "DELETE", url: "http://127.0.0.1:9/" }],
  ])("%s is refused with the same message", async (_label, args) => {
    const { rust, node } = await both(dev, { ...args, auth: "none", timeoutSecs: 10 });
    expect(node.ok).toBe(false);
    expect(rust.ok).toBe(false);
    expect(rust.error).toBe(node.error);
  });
});
