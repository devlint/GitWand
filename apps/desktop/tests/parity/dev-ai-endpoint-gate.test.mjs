/**
 * The dev-server's stand-in for the app's open-endpoint gate
 * (`check_open_endpoint_with` in commands/ai_http.rs). The app passes
 * loopback and the known providers and asks about any other origin; the dev
 * server cannot ask, so it refuses such an origin unless
 * GITWAND_DEV_AI_ORIGINS lists it. Before, `pnpm dev:web` sent AI requests
 * to any origin unasked.
 *
 * Dev-server only (the probe's gate is loopback-only, see
 * ai-http-request.test.mjs); it lives here for the runner.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createServer } from "node:http";
import { startDevServer } from "./dev-server-runner.mjs";
import { isolatedEnv } from "./probe.mjs";

async function aiRequest(dev, url) {
  const res = await dev.fetch("/api/ai-http-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "GET", url, auth: "none", timeoutSecs: 3 }),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

describe("dev-server: AI endpoint gate", { timeout: 15_000 }, () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let devAllowing;
  /** @type {import("node:http").Server} */
  let upstream;
  let base = "";
  const NO_PROXY = { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${upstream.address().port}`;
    dev = await startDevServer({ env: isolatedEnv(NO_PROXY), inherit: false });
    // `.invalid` never resolves: an allowed origin fails on DNS, after the gate.
    devAllowing = await startDevServer({
      env: isolatedEnv({ ...NO_PROXY, GITWAND_DEV_AI_ORIGINS: "https://llm.example.invalid/, https://other.invalid" }),
      inherit: false,
    });
  }, 30_000);

  afterAll(async () => {
    await dev?.stop();
    await devAllowing?.stop();
    await new Promise((r) => upstream?.close(r));
  });

  it("refuses an origin that is neither loopback nor a known provider", async () => {
    const { status, data } = await aiRequest(dev, "https://llm.example.invalid/v1/models");
    expect(status).toBe(403);
    expect(data.error).toContain("https://llm.example.invalid");
    expect(data.error).toContain("GITWAND_DEV_AI_ORIGINS");
  });

  it("lets loopback through", async () => {
    const { status, data } = await aiRequest(dev, `${base}/v1/models`);
    expect(status).toBe(200);
    expect(data).toEqual({ status: 200, body: '{"ok":true}' });
  });

  it("lets an origin listed in GITWAND_DEV_AI_ORIGINS through", async () => {
    const { status, data } = await aiRequest(devAllowing, "https://llm.example.invalid/v1/models");
    // Past the gate: the request itself fails (the name does not resolve).
    expect(status).toBe(502);
    expect(data.error).toMatch(/^AI request failed/);
  });

  it("lists the allowed origins, and a revoked one is refused again", async () => {
    const list = async () => (await (await devAllowing.fetch("/api/ai-allowed-endpoints")).json()).origins;
    expect(await list()).toEqual(["https://llm.example.invalid", "https://other.invalid"]);
    const res = await devAllowing.fetch("/api/ai-revoke-endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Any endpoint of the origin revokes it.
      body: JSON.stringify({ origin: "https://other.invalid/v1/models" }),
    });
    expect(res.status).toBe(200);
    expect(await list()).toEqual(["https://llm.example.invalid"]);
    expect((await aiRequest(devAllowing, "https://other.invalid/v1/models")).status).toBe(403);
  });

  it("does not let a listed origin's other port or scheme through", async () => {
    const { status } = await aiRequest(devAllowing, "http://llm.example.invalid/v1/models");
    expect(status).toBe(403);
    const other = await aiRequest(devAllowing, "https://llm.example.invalid:8443/v1/models");
    expect(other.status).toBe(403);
  });
});
