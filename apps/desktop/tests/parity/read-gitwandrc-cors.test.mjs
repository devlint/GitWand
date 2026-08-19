/**
 * v3.7.0 review-round fix (finding #4): `/api/read-gitwandrc`'s four
 * success-path responses were missing `...corsHeaders(req)`, so the browser
 * blocked the fetch entirely: `.gitwandrc`'s per-repo `commitReview`/`secrets`
 * overrides were untestable via `pnpm dev:web`, this repo's own sanctioned
 * manual-QA path (the route's own error path and its sibling
 * `/api/write-gitwandrc` already went through `jsonResponse()`, which always
 * applies `corsHeaders`, so only the four success writes were affected).
 *
 * This suite uses ONLY `startDevServer()` + `dev.fetch(...)`, it never calls
 * `runProbe`, so it needs no Rust binary (the runner spawns a real HTTP
 * server on an OS-assigned port precisely so CORS is observable: see that
 * file's header comment). It therefore runs under `pnpm test:parity`
 * (`vitest.config.parity.ts`, `tests/parity/**\/*.test.mjs`, node
 * environment), NOT under `pnpm test` (`vite.config.ts` only includes
 * `src/**\/*.test.ts`).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { mkTempRepo } from "./fixtures.mjs";

const ORIGIN = "http://localhost:1420";

describe("parity: read-gitwandrc CORS", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("repo with a .gitwandrc: 200, body is the file text, CORS header echoes the allowed origin", async () => {
    const cwd = mkTempRepo("gw-rc-cors-");
    const rcText = '{\n  // a comment, JSONC-friendly\n  "commitReview": { "enabled": false }\n}\n';
    writeFileSync(join(cwd, ".gitwandrc"), rcText, "utf-8");

    const res = await dev.fetch("/api/read-gitwandrc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ cwd }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(rcText);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("repo with only .gitwandrc.json: 200, CORS header present", async () => {
    const cwd = mkTempRepo("gw-rc-cors-json-");
    const rcText = '{ "secrets": { "enabled": true } }';
    writeFileSync(join(cwd, ".gitwandrc.json"), rcText, "utf-8");

    const res = await dev.fetch("/api/read-gitwandrc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ cwd }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(rcText);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("repo with only package.json#gitwand: 200, CORS header present", async () => {
    const cwd = mkTempRepo("gw-rc-cors-pkg-");
    const gitwandBlock = { commitReview: { enabled: true } };
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "fixture", gitwand: gitwandBlock }),
      "utf-8",
    );

    const res = await dev.fetch("/api/read-gitwandrc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ cwd }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual(gitwandBlock);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("repo with none of the three: 200, empty body, CORS header present", async () => {
    const cwd = mkTempRepo("gw-rc-cors-none-");

    const res = await dev.fetch("/api/read-gitwandrc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ cwd }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("an origin not in ALLOWED_ORIGINS gets no access-control-allow-origin header (proves the fix reuses corsHeaders, not a hardcoded *)", async () => {
    const cwd = mkTempRepo("gw-rc-cors-disallowed-");
    writeFileSync(join(cwd, ".gitwandrc"), "{}", "utf-8");

    const res = await dev.fetch("/api/read-gitwandrc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ cwd }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
