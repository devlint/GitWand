#!/usr/bin/env node
// node-pty's `spawn-helper` (macOS) perd son bit +x en passant par le store
// content-addressable de pnpm : les hardlinks ne préservent pas les permissions
// d'exécution. On le restaure après install.
//
// Pur Node : pas de sous-processus `find`, pas de dépendance au PATH/dialecte de
// `find`, intrinsèquement cross-platform. Sur Linux/Windows les dossiers
// `darwin-*` n'existent pas, donc le script est un no-op silencieux.
import { readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

const store = "node_modules/.pnpm";

let pkgs;
try {
  pkgs = readdirSync(store);
} catch {
  process.exit(0); // store absent (install partiel) — rien à faire
}

for (const pkg of pkgs) {
  if (!pkg.startsWith("node-pty@")) continue;
  const prebuilds = join(store, pkg, "node_modules/node-pty/prebuilds");
  for (const arch of ["darwin-x64", "darwin-arm64"]) {
    try {
      chmodSync(join(prebuilds, arch, "spawn-helper"), 0o755);
    } catch {
      // Cet arch n'est pas présent sur cette plateforme — sans gravité.
    }
  }
}
