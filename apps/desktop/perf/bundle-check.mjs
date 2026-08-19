#!/usr/bin/env node
/**
 * Bundle size budget check (P6.1 / P4.1).
 *
 * Runs after `pnpm build` to validate that the Vite output respects the
 * size budgets we set. Fails (exit 1) if any chunk blows past its limit.
 *
 * Why: §1.2 (lazy panels) and §4.3 (lazy highlight.js languages) are
 * easy to undo by accident in a hurry — someone re-imports a panel
 * eagerly to fix a bug, or registers a new highlight.js language at
 * the top of the file. This check catches the regression before merge.
 *
 * Usage:
 *   pnpm build
 *   node perf/bundle-check.mjs
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = join(__dirname, "..", "dist");
const DIST = join(DIST_ROOT, "assets");
const MANIFEST = join(DIST_ROOT, ".vite", "manifest.json");

// Budgets are in raw KB (un-gzipped). Vite emits raw + brotli/gzip in
// modern setups; we measure raw because it's what the parser+JIT have
// to chew through at boot. Targets sized to leave some headroom.
const BUDGETS = {
  // Main bundle budget history:
  //   v2.8.2  §1.2 lazy panels  → ~600 KB  (budget set to 700)
  //   v2.9.0  Launchpad         → ~900 KB  (+300 KB composables + workspace commands)
  //   v2.10.0 Forge integrations → ~1140 KB  (+240 KB GitLab/Bitbucket providers)
  //   v2.10.0 fix (this PR)     → ~1140 KB  providers now lazy chunks (1.89 KB + 2.05 KB)
  //
  // v3.6.6 note (docs/superpowers/specs/2026-08-18-dev-loop-ci-build-times-
  // plan.md §0.3 item 11): the comment that used to live here claimed
  // `backend.ts` "cannot be moved out of the main chunk" and planned a split
  // into per-domain modules (backend-git, backend-pr, backend-ai…) as a
  // "v2.11 perf task". That diagnosis was wrong and the split was never
  // scheduled. Measured on this tree: `backend.ts` + all `backend-*.ts`
  // together are 82.44 KB raw / 17.92 KB gzip of the main chunk, and
  // `backend.ts` has no module-level side effects beyond three plain
  // top-level declarations (`let _browserFolderPicker`, `const
  // BETA_MANIFEST_URL`, `let _pendingUpdate`) — Rollup already tree-shakes
  // unused wrappers out. Splitting it would not shrink the main chunk.
  // See §5.4 of the plan: explicitly decided NOT to do this refactor.
  //
  // v3.6.6 (plan §5.3 / PR8, perf/lazy-core-engine): `@gitwand/core`'s heavy
  // exports (`resolve`, `resolveAsync`, `parseConflictMarkers` — everything
  // that touches `classifier.ts` + the full `patterns/` registry) are now
  // loaded via a memoized `import("@gitwand/core")` in
  // `useGitWand.ts` + `useMergePreview.ts` (see `src/utils/coreEngine.ts`),
  // instead of a static top-level import. `parseGitwandrc` (config.ts, zero
  // deps) and `summarizeTiers` (stats/tiers.ts, zero deps) stay static —
  // they're genuinely light and don't pull the classifier in.
  //
  // Measured on this tree, real build (not the plan's manualChunks probe,
  // whose ~244 KB figure over-counted what Rollup's own tree-shaking can
  // already exclude): main chunk 1033.89 KB → 848.64 KB raw (−185 KB,
  // −52.5 KB gzip: 324.77 → 272.30 KB), and a new dynamic chunk
  // (`../../packages/core/src/index.ts` in the Vite manifest, ~193 KB raw
  // — comfortably under `any_chunk_max_kb`) appears in `dist/assets/`,
  // loaded only on the first real conflict resolution or merge-preview call.
  //
  // Budget lowered to 900 (measured 829 KB rounded by this script, ~70 KB
  // headroom) to lock the gain in. If a future change pushes this back up,
  // look for a new *eager* (non-lazy) static import of `resolve`,
  // `resolveAsync`, or `parseConflictMarkers` from "@gitwand/core" — the
  // prior regression vector was `useMergePreview.ts`, reachable eagerly via
  // `AppHeader.vue` → `BranchSelector.vue` (always-mounted header), not just
  // `useGitWand.ts`.
  main_max_kb: 900,

  // Largest chunk other than main — usually a panel or vendor chunk.
  // If > 500 KB, time to investigate (typically means a vendor lib leaked
  // into a feature chunk).
  any_chunk_max_kb: 500,

  // Total assets — a sanity bound. If > 5 MB raw something is very wrong
  // (e.g. monaco/wasm bundled by accident).
  //
  // Measured on this tree (2026-08-18, this script's own byte-accurate sum,
  // NOT `du -ch` which over-counts via block-size rounding): 4287 KB, i.e.
  // ~86% of this budget. Kept at 5000 (leaves ~700 KB of headroom, enough
  // for a locale addition or a CodeMirror language pack without being so
  // loose the check stops meaning anything).
  total_max_kb: 5_000,
};

if (!safeStatDir(DIST)) {
  console.error(`No dist/assets/ at ${DIST}. Run \`pnpm build\` first.`);
  process.exit(2);
}

const files = readdirSync(DIST)
  .filter((f) => f.endsWith(".js"))
  .map((f) => {
    const full = join(DIST, f);
    const sz = statSync(full).size;
    return { name: f, size: sz, kb: Math.round(sz / 1024) };
  })
  .sort((a, b) => b.size - a.size);

console.log("\nVite chunks (largest first):\n");
console.log("  Size      File");
for (const f of files) {
  console.log(`  ${String(f.kb).padStart(6)} KB  ${f.name}`);
}

const total = files.reduce((acc, f) => acc + f.kb, 0);
const mainFileName = findMainChunkFileName();
const main = files.find((f) => f.name === mainFileName) || files[0];
const otherMax = files.filter((f) => f !== main).reduce((max, f) => Math.max(max, f.kb), 0);

console.log(`\nTotal:    ${total} KB`);
console.log(`Main:     ${main?.name || "?"} = ${main?.kb || 0} KB (budget ${BUDGETS.main_max_kb} KB)`);
console.log(`Largest other chunk: ${otherMax} KB (budget ${BUDGETS.any_chunk_max_kb} KB)`);

let failed = false;
if (main && main.kb > BUDGETS.main_max_kb) {
  console.error(`\nFAIL: main bundle ${main.kb} KB exceeds budget ${BUDGETS.main_max_kb} KB.`);
  console.error(`Likely cause: a panel/modal that should be lazy-loaded was imported eagerly.`);
  console.error(`Check apps/desktop/src/App.vue — look for new \`import X from "./components/...vue"\` lines.`);
  failed = true;
}
if (otherMax > BUDGETS.any_chunk_max_kb) {
  console.error(`\nFAIL: a non-main chunk reached ${otherMax} KB, exceeds ${BUDGETS.any_chunk_max_kb} KB.`);
  console.error(`Likely cause: a vendor lib (lucide, monaco, shiki…) leaked into a feature chunk.`);
  failed = true;
}
if (total > BUDGETS.total_max_kb) {
  console.error(`\nFAIL: total assets ${total} KB exceeds ${BUDGETS.total_max_kb} KB.`);
  failed = true;
}

if (failed) process.exit(1);

console.log("\nAll budgets OK ✓");

function safeStatDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Identify the real entry chunk via Vite's build manifest instead of
// guessing from the file name + a size sort. The build emits ~12 chunks
// named `index-<hash>.js` (CodeMirror language packs also get that name
// pattern), and today's main chunk happens to also be the largest file —
// but that's an accident of what currently lives in it, not a guarantee.
// If a vendor chunk ever outgrew the main chunk, the old
// `/^index-[a-z0-9_-]+\.js$/i` + size-sort heuristic would silently measure
// the wrong file (see docs/superpowers/specs/
// 2026-08-18-dev-loop-ci-build-times-plan.md §0.3 item 13). The manifest's
// `index.html` entry always points at the true entry chunk, regardless of
// its name or size.
function findMainChunkFileName() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  } catch (err) {
    console.error(`\nCannot read Vite manifest at ${MANIFEST}: ${err.message}`);
    console.error(`Ensure \`build.manifest: true\` is set in vite.config.ts and re-run \`pnpm build\`.`);
    process.exit(2);
  }

  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  if (!entry || !entry.file) {
    console.error(`\nNo entry chunk (isEntry: true) found in ${MANIFEST}.`);
    process.exit(2);
  }

  return basename(entry.file);
}
