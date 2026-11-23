// Binary resolution shared by dev-server.mjs and the dev-*-service modules,
// so every module spawns the same git (and gh) the dev-server does.

import { existsSync } from "node:fs";

/** Resolve the full path to a CLI binary, checking Homebrew paths on macOS. */
export function resolveBin(name) {
  // Try common macOS Homebrew locations first
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name, // fallback: rely on PATH
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return name;
}
