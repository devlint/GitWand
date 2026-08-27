/**
 * Fixture-based tests for regenerate-compare.mjs — fast, no network, no real
 * installs. Run with: node --test scripts/lib/regenerate-compare.test.mjs
 * (see root package.json's "test:regenerate-compare" script).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { structuralMatch, extractPackageIdentities } from "./regenerate-compare.mjs";

// ─── npm (package-lock.json, lockfileVersion 3 "packages" map) ─────────────

const npmA = JSON.stringify({
  name: "demo",
  lockfileVersion: 3,
  packages: {
    "": { name: "demo", version: "1.0.0" },
    "node_modules/lodash": {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-abc123==",
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-def456==",
    },
  },
});

// Same dependency graph, different volatile fields (mirrors resolved-URL /
// integrity-hash drift a real re-resolve can produce even for an unchanged graph).
const npmAVolatileDrift = JSON.stringify({
  name: "demo",
  lockfileVersion: 3,
  packages: {
    "": { name: "demo", version: "1.0.0" },
    "node_modules/lodash": {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-ZZZZZZ==",
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-YYYYYY==",
    },
  },
});

const npmB = JSON.stringify({
  name: "demo",
  lockfileVersion: 3,
  packages: {
    "": { name: "demo", version: "1.0.0" },
    "node_modules/lodash": {
      version: "4.17.20", // genuinely different resolved version
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      integrity: "sha512-abc123==",
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-def456==",
    },
  },
});

test("npm: identical modulo volatile hashes/resolved URLs -> match", () => {
  const result = structuralMatch("npm", npmA, npmAVolatileDrift);
  assert.equal(result.match, true);
  assert.equal(result.method, "structural");
});

test("npm: genuinely different resolved version -> no match", () => {
  const result = structuralMatch("npm", npmA, npmB);
  assert.equal(result.match, false);
  assert.deepEqual(result.onlyInExpected, ["lodash@4.17.21"]);
  assert.deepEqual(result.onlyInActual, ["lodash@4.17.20"]);
});

test("npm: legacy lockfileVersion 1 nested 'dependencies' tree is supported", () => {
  const legacy = JSON.stringify({
    name: "demo",
    lockfileVersion: 1,
    dependencies: {
      lodash: { version: "4.17.21" },
      wrap: { version: "1.0.0", dependencies: { inner: { version: "2.0.0" } } },
    },
  });
  const ids = extractPackageIdentities("npm", legacy);
  assert.ok(ids.has("lodash@4.17.21"));
  assert.ok(ids.has("wrap@1.0.0"));
  assert.ok(ids.has("inner@2.0.0"));
});

// ─── composer (composer.lock) ───────────────────────────────────────────────

const composerA = JSON.stringify({
  _readme: ["This file locks..."],
  "content-hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  packages: [
    { name: "laravel/framework", version: "v10.0.0", dist: { reference: "abc111" } },
    { name: "symfony/console", version: "v6.3.0", dist: { reference: "abc222" } },
  ],
  "packages-dev": [{ name: "phpunit/phpunit", version: "10.0.0", dist: { reference: "abc333" } }],
});

const composerAVolatileDrift = JSON.stringify({
  _readme: ["This file locks..."],
  "content-hash": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // volatile: recomputed hash
  packages: [
    { name: "laravel/framework", version: "v10.0.0", dist: { reference: "def999" } }, // volatile: dist ref
    { name: "symfony/console", version: "v6.3.0", dist: { reference: "def888" } },
  ],
  "packages-dev": [{ name: "phpunit/phpunit", version: "10.0.0", dist: { reference: "def777" } }],
});

const composerB = JSON.stringify({
  _readme: ["This file locks..."],
  "content-hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  packages: [
    { name: "laravel/framework", version: "v10.1.0", dist: { reference: "abc111" } }, // genuinely different version
    { name: "symfony/console", version: "v6.3.0", dist: { reference: "abc222" } },
  ],
  "packages-dev": [{ name: "phpunit/phpunit", version: "10.0.0", dist: { reference: "abc333" } }],
});

test("composer: identical modulo content-hash/dist.reference -> match", () => {
  const result = structuralMatch("composer", composerA, composerAVolatileDrift);
  assert.equal(result.match, true);
});

test("composer: genuinely different dependency graph -> no match", () => {
  const result = structuralMatch("composer", composerA, composerB);
  assert.equal(result.match, false);
  assert.deepEqual(result.onlyInExpected, ["laravel/framework@v10.0.0"]);
  assert.deepEqual(result.onlyInActual, ["laravel/framework@v10.1.0"]);
});

// ─── pnpm (pnpm-lock.yaml) ───────────────────────────────────────────────────

const pnpmA = `lockfileVersion: '9.0'
packages:
  lodash@4.17.21:
    resolution: {integrity: sha512-abc123==}
  left-pad@1.3.0:
    resolution: {integrity: sha512-def456==}
`;

const pnpmAVolatileDrift = `lockfileVersion: '9.0'
packages:
  lodash@4.17.21:
    resolution: {integrity: sha512-ZZZZZZ==}
  left-pad@1.3.0:
    resolution: {integrity: sha512-YYYYYY==}
`;

const pnpmB = `lockfileVersion: '9.0'
packages:
  lodash@4.17.20:
    resolution: {integrity: sha512-abc123==}
  left-pad@1.3.0:
    resolution: {integrity: sha512-def456==}
`;

test("pnpm: identical modulo integrity hash -> match", () => {
  const result = structuralMatch("pnpm", pnpmA, pnpmAVolatileDrift);
  assert.equal(result.match, true);
});

test("pnpm: genuinely different resolved version -> no match", () => {
  const result = structuralMatch("pnpm", pnpmA, pnpmB);
  assert.equal(result.match, false);
});

// ─── yarn-berry (yarn.lock) ──────────────────────────────────────────────────

const yarnA = `__metadata:
  version: 6

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  languageName: node
  linkType: hard
`;

const yarnAVolatileDrift = `__metadata:
  version: 6

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  languageName: node
  linkType: hard
`;

const yarnB = `__metadata:
  version: 6

"lodash@npm:^4.17.21":
  version: 4.17.20
  resolution: "lodash@npm:4.17.20"
  checksum: 10c0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  languageName: node
  linkType: hard
`;

test("yarn-berry: identical modulo checksum -> match", () => {
  const result = structuralMatch("yarn-berry", yarnA, yarnAVolatileDrift);
  assert.equal(result.match, true);
});

test("yarn-berry: genuinely different resolved version -> no match", () => {
  const result = structuralMatch("yarn-berry", yarnA, yarnB);
  assert.equal(result.match, false);
});

// ─── cargo (Cargo.lock) ───────────────────────────────────────────────────────

const cargoA = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "serde"
version = "1.0.190"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[[package]]
name = "libc"
version = "0.2.150"
checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`;

const cargoAVolatileDrift = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "serde"
version = "1.0.190"
checksum = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

[[package]]
name = "libc"
version = "0.2.150"
checksum = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
`;

const cargoB = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "serde"
version = "1.0.195"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[[package]]
name = "libc"
version = "0.2.150"
checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`;

test("cargo: identical modulo checksum -> match", () => {
  const result = structuralMatch("cargo", cargoA, cargoAVolatileDrift);
  assert.equal(result.match, true);
});

test("cargo: genuinely different resolved version -> no match", () => {
  const result = structuralMatch("cargo", cargoA, cargoB);
  assert.equal(result.match, false);
});

// ─── fallback path (unparseable in the expected format) ─────────────────────

test("fallback: unknown ecosystem id falls back to stripVolatileValues text compare", () => {
  const a = 'hash: "sha512-abcdef1234567890abcdef1234567890abcdef12"';
  const b = 'hash: "sha512-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"';
  const result = structuralMatch("unknown-ecosystem", a, b);
  assert.equal(result.method, "text-fallback");
  assert.equal(result.match, true); // both strip to the same "<hash>" placeholder
});

test("fallback: malformed JSON for a known ecosystem still produces a verdict, not a throw", () => {
  const broken = "<<<<<<< HEAD\nnot valid json\n=======\n>>>>>>> theirs\n";
  assert.doesNotThrow(() => structuralMatch("npm", broken, broken));
  const result = structuralMatch("npm", broken, broken);
  assert.equal(result.method, "text-fallback");
  assert.equal(result.match, true); // identical text on both sides
});
