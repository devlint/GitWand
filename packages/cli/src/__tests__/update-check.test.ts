/**
 * `checkForUpdate` must never slow down or break a command: gated on TTY,
 * cached for 24h, and silent on any I/O/network failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkForUpdate, isNewer } from "../update-check.js";

describe("isNewer", () => {
  it("detects a newer patch, minor, and major", () => {
    expect(isNewer("3.9.1", "3.9.0")).toBe(true);
    expect(isNewer("3.10.0", "3.9.9")).toBe(true);
    expect(isNewer("4.0.0", "3.9.9")).toBe(true);
  });

  it("returns false for equal or older versions", () => {
    expect(isNewer("3.9.0", "3.9.0")).toBe(false);
    expect(isNewer("3.8.0", "3.9.0")).toBe(false);
    expect(isNewer("3.9.0", "3.9.1")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalIsTTY: boolean | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gitwand-update-check-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  it("does nothing when stdout is not a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    await checkForUpdate("3.9.0");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fetches and prints a notice when no cache exists and a newer version is published", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "3.10.0" }),
    });

    await checkForUpdate("3.9.0");

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("3.9.0");
    expect(errorSpy.mock.calls[0][0]).toContain("3.10.0");

    const cached = JSON.parse(readFileSync(join(home, ".gitwand", "update-check.json"), "utf-8"));
    expect(cached.latestVersion).toBe("3.10.0");
    expect(typeof cached.lastChecked).toBe("number");
  });

  it("prints nothing when already on the latest version", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "3.9.0" }),
    });

    await checkForUpdate("3.9.0");

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reuses a fresh cache instead of hitting the network again", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "3.10.0" }),
    });

    await checkForUpdate("3.9.0");
    expect(fetchSpy).toHaveBeenCalledOnce();
    errorSpy.mockClear();

    await checkForUpdate("3.9.0");

    expect(fetchSpy).toHaveBeenCalledOnce(); // still just the one call from the first run
    expect(errorSpy).toHaveBeenCalledOnce(); // notice still prints from the cached value
  });

  it("stays silent when the registry fetch fails", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));

    await expect(checkForUpdate("3.9.0")).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("stays silent when the registry responds with a non-OK status", async () => {
    fetchSpy.mockResolvedValue({ ok: false, json: async () => ({}) });

    await expect(checkForUpdate("3.9.0")).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ignores a malformed cache file instead of throwing", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".gitwand"), { recursive: true });
    writeFileSync(join(home, ".gitwand", "update-check.json"), "not json", "utf-8");
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "3.10.0" }),
    });

    await expect(checkForUpdate("3.9.0")).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
