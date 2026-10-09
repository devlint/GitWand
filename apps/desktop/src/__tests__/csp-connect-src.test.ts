/**
 * The CSP `connect-src` is a fixed list of hosts: every URL the webview
 * fetches itself must be on it, or the request fails silently (the beta
 * update check did, until devlint.github.io was listed). AI providers are not
 * here: those requests go through the backend (`ai_http_request`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

function connectSrc(): string[] {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  const csp: string = conf.app.security.csp;
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  return directive!.split(/\s+/).slice(1);
}

/** The value of `const NAME = "…"` in `file`. */
function constUrl(file: string, name: string): string {
  const m = new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`).exec(read(file));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1];
}

describe("CSP connect-src", () => {
  const fetched: [string, string][] = [
    ["src/utils/backend.ts", "BETA_MANIFEST_URL"],
    ["src/composables/useNetworkStatus.ts", "PROBE_URL"],
  ];

  for (const [file, name] of fetched) {
    it(`allows ${name} (${file})`, () => {
      const origin = new URL(constUrl(file, name)).origin;
      expect(connectSrc()).toContain(origin);
    });
  }

  it("does not reopen arbitrary hosts", () => {
    const src = connectSrc();
    for (const wide of ["http:", "https:", "*", "https://*"]) expect(src).not.toContain(wide);
  });
});
