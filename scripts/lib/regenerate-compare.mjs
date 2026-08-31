/**
 * regenerate-compare.mjs — structural comparison for `scripts/replay-regenerate.mjs`.
 *
 * Byte-exact comparison of a regenerated lockfile against the one a team
 * actually committed almost never holds (dependency resolvers vary resolved
 * URLs, hashes, and ordering run-to-run even given the same inputs — see the
 * task-4 brief's "Measurement" section). So "did regeneration reproduce the
 * commit" is answered structurally instead: for each of the v1 registry's five
 * lockfile formats, extract the set of resolved `name@version` package
 * identities and compare those sets, ignoring integrity hashes, resolved
 * URLs, timestamps and key ordering.
 *
 * Design choice (documented per the brief): format-aware parsing (`yaml`,
 * `smol-toml`, `JSON.parse` — the same libraries `packages/cli`'s
 * `regenerate-runner.ts` already uses for these exact formats) is the primary
 * path, because "same dependency graph" is a stronger and more meaningful
 * claim than "same text after stripping some volatile-looking substrings".
 * `stripVolatileValues` (`@gitwand/core`, exported for this purpose per the
 * brief) is kept as the FALLBACK when a lockfile fails to parse in its
 * expected format (corrupt output, an unexpected variant) — a text-normalised
 * compare is better than crashing the measurement run.
 */

import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { stripVolatileValues } from "../../packages/core/dist/index.js";

/**
 * npm package-lock.json — supports both the modern "packages" map
 * (lockfileVersion 2/3, keyed by node_modules path) and the legacy nested
 * "dependencies" tree (lockfileVersion 1).
 */
function extractNpmIdentities(content) {
  const parsed = JSON.parse(content);
  const identities = new Set();

  if (parsed.packages && typeof parsed.packages === "object") {
    for (const [pkgPath, meta] of Object.entries(parsed.packages)) {
      if (pkgPath === "" || !meta || typeof meta.version !== "string") continue;
      const idx = pkgPath.lastIndexOf("node_modules/");
      const name = idx === -1 ? pkgPath : pkgPath.slice(idx + "node_modules/".length);
      identities.add(`${name}@${meta.version}`);
    }
    return identities;
  }

  const walk = (deps) => {
    if (!deps || typeof deps !== "object") return;
    for (const [name, meta] of Object.entries(deps)) {
      if (!meta || typeof meta.version !== "string") continue;
      identities.add(`${name}@${meta.version}`);
      if (meta.dependencies) walk(meta.dependencies);
    }
  };
  walk(parsed.dependencies);
  return identities;
}

/** composer.lock — "packages" + "packages-dev" arrays of {name, version}. */
function extractComposerIdentities(content) {
  const parsed = JSON.parse(content);
  const identities = new Set();
  for (const key of ["packages", "packages-dev"]) {
    for (const pkg of parsed[key] ?? []) {
      if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
        identities.add(`${pkg.name}@${pkg.version}`);
      }
    }
  }
  return identities;
}

/**
 * pnpm-lock.yaml — the top-level "packages" map's keys already embed
 * `name@version` (e.g. `/lodash@4.17.21` or `lodash@4.17.21` depending on
 * lockfileVersion); the "resolution"/"integrity" subfields are volatile and
 * deliberately not part of the identity.
 */
function extractPnpmIdentities(content) {
  const parsed = parseYaml(content);
  const identities = new Set();
  const packages = parsed?.packages ?? {};
  for (const key of Object.keys(packages)) {
    identities.add(key.replace(/^\//, ""));
  }
  return identities;
}

/**
 * yarn.lock (berry) — top-level keys are comma-separated locator lists
 * (`"foo@npm:^1.0.0, foo@npm:^1.2.0":`); each block's `version` field is the
 * resolved version. `__metadata` is not a package entry.
 */
function extractYarnIdentities(content) {
  const parsed = parseYaml(content);
  const identities = new Set();
  for (const [key, meta] of Object.entries(parsed ?? {})) {
    if (key === "__metadata" || !meta || typeof meta.version !== "string") continue;
    const firstLocator = key.split(",")[0].trim().replace(/^"|"$/g, "");
    const atNpm = firstLocator.lastIndexOf("@npm:");
    const name = atNpm === -1 ? firstLocator.replace(/@[^@]*$/, "") : firstLocator.slice(0, atNpm);
    identities.add(`${name}@${meta.version}`);
  }
  return identities;
}

/** Cargo.lock — array of `[[package]]` tables with name/version. */
function extractCargoIdentities(content) {
  const parsed = parseToml(content);
  const identities = new Set();
  for (const pkg of parsed.package ?? []) {
    if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
      identities.add(`${pkg.name}@${pkg.version}`);
    }
  }
  return identities;
}

const EXTRACTORS = {
  npm: extractNpmIdentities,
  composer: extractComposerIdentities,
  pnpm: extractPnpmIdentities,
  "yarn-berry": extractYarnIdentities,
  cargo: extractCargoIdentities,
};

/**
 * Format-aware extraction of the `name@version` identity set for a lockfile.
 * Returns `null` (not a thrown error) when `ecosystemId` is unknown, so
 * callers can fall back cleanly.
 */
export function extractPackageIdentities(ecosystemId, content) {
  const extractor = EXTRACTORS[ecosystemId];
  if (!extractor) return null;
  return extractor(content);
}

/**
 * Structural comparison between an expected (actually-committed) lockfile and
 * an actual (regenerated) one. See module doc for the two-tier strategy.
 */
export function structuralMatch(ecosystemId, expectedContent, actualContent) {
  try {
    const expected = extractPackageIdentities(ecosystemId, expectedContent);
    const actual = extractPackageIdentities(ecosystemId, actualContent);
    if (expected && actual) {
      const onlyInExpected = [...expected].filter((id) => !actual.has(id));
      const onlyInActual = [...actual].filter((id) => !expected.has(id));
      const match = onlyInExpected.length === 0 && onlyInActual.length === 0;
      return {
        match,
        comparable: true,
        method: "structural",
        expectedCount: expected.size,
        actualCount: actual.size,
        onlyInExpected,
        onlyInActual,
      };
    }
  } catch {
    // Fall through to the text fallback below — a parse failure (corrupt
    // regenerated output, an unexpected format variant) must not crash the
    // whole replay run.
  }

  // Fallback: format-aware parsing didn't apply or failed — normalise both
  // sides with stripVolatileValues and compare as text.
  const a = stripVolatileValues(expectedContent.split(/\r?\n/));
  const b = stripVolatileValues(actualContent.split(/\r?\n/));
  return { match: a === b, comparable: true, method: "text-fallback" };
}
