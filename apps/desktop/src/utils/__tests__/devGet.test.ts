import { describe, it, expect, vi, afterEach } from "vitest";
import { devGet } from "../backend-core";

afterEach(() => vi.unstubAllGlobals());

describe("devGet", () => {
  it("throws on a 200 whose body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })));
    await expect(devGet("/api/x", {}, "x")).rejects.toThrow();
  });
  it("throws the server's error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Missing cwd" }) })));
    await expect(devGet("/api/x", {}, "x")).rejects.toThrow("Missing cwd");
  });
  it("returns the parsed answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [1, 2] })));
    await expect(devGet("/api/x", {}, "x")).resolves.toEqual([1, 2]);
  });
});
