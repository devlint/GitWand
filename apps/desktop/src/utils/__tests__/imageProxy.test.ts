import { describe, it, expect, vi, afterEach } from "vitest";

let tauri = false;
vi.mock("../backend-core", () => ({
  isTauri: () => tauri,
  DEV_SERVER: "http://localhost:3001",
}));

import { proxyImageUrl, originalImageUrl } from "../imageProxy";

const REMOTE = "https://gitlab.example.org/uploads/-/system/user/avatar/7/a.png?width=48&x=1";

afterEach(() => {
  tauri = false;
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("proxyImageUrl", () => {
  it("routes a remote image through the dev server under dev:web", () => {
    expect(proxyImageUrl(REMOTE)).toBe(
      `http://localhost:3001/api/image-proxy?u=${encodeURIComponent(REMOTE)}`,
    );
  });

  it("routes it through the gwimg scheme in the app, as Tauri builds its URL", () => {
    tauri = true;
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`,
    };
    expect(proxyImageUrl(REMOTE)).toBe(`http://gwimg.localhost/?u=${encodeURIComponent(REMOTE)}`);
  });

  it("falls back to gwimg://localhost when Tauri's helper is missing", () => {
    tauri = true;
    expect(proxyImageUrl(REMOTE)).toBe(`gwimg://localhost/?u=${encodeURIComponent(REMOTE)}`);
  });

  it("leaves what is not a remote http(s) URL alone", () => {
    for (const url of ["data:image/png;base64,AA==", "blob:abc", "/assets/x.svg", "img/a.png", ""]) {
      expect(proxyImageUrl(url)).toBe(url);
    }
    expect(proxyImageUrl(null)).toBeNull();
  });

  it("does not proxy twice", () => {
    const once = proxyImageUrl(REMOTE);
    expect(proxyImageUrl(once)).toBe(once);
    tauri = true;
    const app = proxyImageUrl(REMOTE);
    expect(proxyImageUrl(app)).toBe(app);
  });
});

describe("originalImageUrl", () => {
  it("gives back the remote URL behind a proxied one, in either form", () => {
    expect(originalImageUrl(proxyImageUrl(REMOTE))).toBe(REMOTE);
    tauri = true;
    expect(originalImageUrl(proxyImageUrl(REMOTE))).toBe(REMOTE);
  });

  it("returns any other URL as is", () => {
    expect(originalImageUrl(REMOTE)).toBe(REMOTE);
    expect(originalImageUrl("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
  });
});
