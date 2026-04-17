/**
 * Tests du resolver Cargo.toml / Cargo.lock (v1.4)
 *
 * Fixtures :
 *   F25 — conflit [dependencies] dans Cargo.toml
 *   F26 — version bump dans Cargo.toml
 *   F27 — merge de packages dans Cargo.lock
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F25 — conflit [dependencies] ────────────────────────────

describe("F25 — Cargo.toml : merge [dependencies] (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `[dependencies]`,
    `serde = { version = "1.0", features = ["derive"] }`,
    `tokio = { version = "1.0", features = ["full"] }`,
    `clap = "4.0"`,
    `||||||| base`,
    `[dependencies]`,
    `serde = { version = "1.0", features = ["derive"] }`,
    `tokio = { version = "1.0", features = ["full"] }`,
    `=======`,
    `[dependencies]`,
    `serde = { version = "1.0", features = ["derive"] }`,
    `tokio = { version = "1.0", features = ["full"] }`,
    `anyhow = "1.0"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver cargo", () => {
    const result = resolve(input, "Cargo.toml");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les dépendances des deux côtés", () => {
    const result = resolve(input, "Cargo.toml");
    const merged = result.mergedContent!;
    expect(merged).toContain("clap");
    expect(merged).toContain("anyhow");
    expect(merged).toContain("serde");
    expect(merged).toContain("tokio");
  });

  it("la raison mentionne [cargo]", () => {
    const result = resolve(input, "Cargo.toml");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[cargo\]/i);
  });
});

// ─── F26 — version bump Cargo.toml ───────────────────────────

describe("F26 — Cargo.toml : version bump dans [package] (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `[package]`,
    `name = "my-crate"`,
    `version = "0.2.0"`,
    `edition = "2021"`,
    `||||||| base`,
    `[package]`,
    `name = "my-crate"`,
    `version = "0.1.0"`,
    `edition = "2021"`,
    `=======`,
    `[package]`,
    `name = "my-crate"`,
    `version = "0.3.0"`,
    `edition = "2021"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout (prefer theirs pour la version)", () => {
    const result = resolve(input, "Cargo.toml");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("conserve la version de theirs (prefer-theirs sur les conflits de clé)", () => {
    const result = resolve(input, "Cargo.toml");
    expect(result.mergedContent).toContain('"0.3.0"');
  });
});

// ─── F27 — Cargo.lock merge de packages ──────────────────────

describe("F27 — Cargo.lock : merge de packages [[package]] (diff3)", () => {
  const lockConflict = [
    `<<<<<<< ours`,
    `[[package]]`,
    `name = "serde"`,
    `version = "1.0.195"`,
    `source = "registry+https://github.com/rust-lang/crates.io-index"`,
    `checksum = "aaaa"`,
    ``,
    `[[package]]`,
    `name = "clap"`,
    `version = "4.4.0"`,
    `source = "registry+https://github.com/rust-lang/crates.io-index"`,
    `checksum = "bbbb"`,
    `||||||| base`,
    `[[package]]`,
    `name = "serde"`,
    `version = "1.0.195"`,
    `source = "registry+https://github.com/rust-lang/crates.io-index"`,
    `checksum = "aaaa"`,
    `=======`,
    `[[package]]`,
    `name = "serde"`,
    `version = "1.0.195"`,
    `source = "registry+https://github.com/rust-lang/crates.io-index"`,
    `checksum = "aaaa"`,
    ``,
    `[[package]]`,
    `name = "anyhow"`,
    `version = "1.0.80"`,
    `source = "registry+https://github.com/rust-lang/crates.io-index"`,
    `checksum = "cccc"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver cargo", () => {
    const result = resolve(lockConflict, "Cargo.lock");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les deux nouveaux packages", () => {
    const result = resolve(lockConflict, "Cargo.lock");
    const merged = result.mergedContent!;
    expect(merged).toContain("clap");
    expect(merged).toContain("anyhow");
    expect(merged).toContain("serde");
  });

  it("la raison mentionne Cargo.lock", () => {
    const result = resolve(lockConflict, "Cargo.lock");
    expect(result.resolutions[0].resolutionReason).toMatch(/Cargo\.lock/i);
  });
});

// ─── Nom de fichier — détection ──────────────────────────────

describe("Cargo — détection du nom de fichier", () => {
  it("Cargo.toml est détecté", () => {
    const input = [
      `<<<<<<< ours`,
      `[dependencies]`,
      `foo = "1.0"`,
      `=======`,
      `[dependencies]`,
      `bar = "2.0"`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "Cargo.toml");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[cargo\]/i);
  });

  it("Cargo.lock est détecté", () => {
    const input = [
      `<<<<<<< ours`,
      `[[package]]`,
      `name = "foo"`,
      `version = "1.0.0"`,
      `=======`,
      `[[package]]`,
      `name = "bar"`,
      `version = "2.0.0"`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "Cargo.lock");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[cargo\]/i);
  });
});
