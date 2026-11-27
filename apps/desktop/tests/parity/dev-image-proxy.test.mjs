/**
 * The dev-server's `/api/image-proxy`, dev:web's stand-in for the app's
 * `gwimg:` scheme (commands/image_proxy.rs, whose own tests cover the Rust
 * side): an image is served with its type, anything else is a 502, and only
 * http(s) URLs without credentials are fetched.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createServer } from "node:http";
import { startDevServer } from "./dev-server-runner.mjs";
import { isolatedEnv } from "./probe.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

describe("dev-server: image proxy", { timeout: 15_000 }, () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  /** @type {import("node:http").Server} */
  let upstream;
  let base = "";

  const get = (u) => dev.fetch(`/api/image-proxy?u=${encodeURIComponent(u)}`);

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === "/a.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(PNG);
      }
      if (req.url === "/stream.png") {
        // Chunked, no Content-Length, past 5 MiB.
        res.writeHead(200, { "Content-Type": "image/png" });
        const chunk = Buffer.alloc(256 * 1024);
        let sent = 0;
        const push = () => {
          while (sent <= 6 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once("drain", push);
          }
          res.end();
        };
        return push();
      }
      const hop = /^\/hop(\d+)$/.exec(req.url ?? "");
      if (hop) {
        const n = Number(hop[1]);
        res.writeHead(302, { Location: n === 0 ? "/a.png" : `/hop${n - 1}` });
        return res.end();
      }
      if (req.url === "/page") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<script>alert(1)</script>");
      }
      res.writeHead(404, { "Content-Type": "image/png" });
      res.end();
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${upstream.address().port}`;
    dev = await startDevServer({
      env: isolatedEnv({ NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }),
      inherit: false,
    });
  }, 30_000);

  afterAll(async () => {
    await dev?.stop();
    await new Promise((r) => upstream?.close(r));
  });

  it("serves an image with its type", async () => {
    const res = await get(`${base}/a.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("lets no foreign page read it", async () => {
    const res = await dev.fetch(`/api/image-proxy?u=${encodeURIComponent(`${base}/a.png`)}`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses an answer that is not an image, and an error status", async () => {
    expect((await get(`${base}/page`)).status).toBe(502);
    expect((await get(`${base}/missing.png`)).status).toBe(502);
  });

  it("follows 3 redirects, not 4", async () => {
    expect((await get(`${base}/hop2`)).status).toBe(200); // hop2 → hop1 → hop0 → a.png
    expect((await get(`${base}/hop3`)).status).toBe(502);
  });

  it("refuses a request a cross-site page made", async () => {
    const res = await dev.fetch(`/api/image-proxy?u=${encodeURIComponent(`${base}/a.png`)}`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("stops a streamed answer past 5 MiB", async () => {
    const res = await get(`${base}/stream.png`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("larger than 5 MiB");
  });

  it("refuses what is not an http(s) URL without credentials", async () => {
    for (const u of ["file:///etc/passwd", "https://user:pw@example.invalid/a.png", "not a url", ""]) {
      expect((await get(u)).status, u).toBe(502);
    }
  });
});
