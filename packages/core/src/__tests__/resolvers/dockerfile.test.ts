/**
 * Tests du resolver Dockerfile (v1.4)
 *
 * Fixtures :
 *   F30 — conflit ENV + FROM dans un Dockerfile multi-stage
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F30 — Dockerfile multi-stage ENV + FROM ──────────────────

describe("F30 — Dockerfile : ENV + FROM dans un multi-stage (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `FROM node:18-alpine AS builder`,
    `ENV NODE_ENV=development`,
    `ENV PORT=3000`,
    `WORKDIR /app`,
    `COPY package.json .`,
    `RUN npm install`,
    `||||||| base`,
    `FROM node:16-alpine AS builder`,
    `ENV NODE_ENV=development`,
    `WORKDIR /app`,
    `COPY package.json .`,
    `RUN npm install`,
    `=======`,
    `FROM node:18-alpine AS builder`,
    `ENV NODE_ENV=production`,
    `ENV API_URL=https://api.example.com`,
    `WORKDIR /app`,
    `COPY package.json .`,
    `RUN npm install`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver dockerfile", () => {
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("la raison mentionne [dockerfile]", () => {
    const result = resolve(input, "Dockerfile");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dockerfile\]/i);
  });

  it("conserve FROM node:18-alpine (prefer theirs)", () => {
    const result = resolve(input, "Dockerfile");
    expect(result.mergedContent).toContain("node:18-alpine");
  });

  it("conserve NODE_ENV=production (prefer theirs sur ENV)", () => {
    const result = resolve(input, "Dockerfile");
    expect(result.mergedContent).toContain("NODE_ENV=production");
    expect(result.mergedContent).not.toContain("NODE_ENV=development");
  });

  it("contient PORT=3000 (ajouté dans ours)", () => {
    const result = resolve(input, "Dockerfile");
    expect(result.mergedContent).toContain("PORT=3000");
  });

  it("contient API_URL (ajouté dans theirs)", () => {
    const result = resolve(input, "Dockerfile");
    expect(result.mergedContent).toContain("API_URL=https://api.example.com");
  });
});

// ─── Détection du nom de fichier ─────────────────────────────

describe("Dockerfile — détection des noms de fichier", () => {
  const simpleInput = [
    `<<<<<<< ours`,
    `FROM node:18`,
    `ENV FOO=bar`,
    `=======`,
    `FROM node:20`,
    `ENV FOO=baz`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("Dockerfile est détecté", () => {
    const result = resolve(simpleInput, "Dockerfile");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dockerfile\]/i);
  });

  it("Dockerfile.dev est détecté", () => {
    const result = resolve(simpleInput, "Dockerfile.dev");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dockerfile\]/i);
  });

  it("app.dockerfile est détecté", () => {
    const result = resolve(simpleInput, "docker/app.dockerfile");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dockerfile\]/i);
  });
});

// ─── Conflit irréductible (RUN) ───────────────────────────────

describe("Dockerfile — conflit irréductible sur RUN", () => {
  it("ne résout pas un conflit de RUN différent", () => {
    const input = [
      `<<<<<<< ours`,
      `FROM node:18`,
      `RUN npm install && npm run build`,
      `=======`,
      `FROM node:18`,
      `RUN yarn install && yarn build`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "Dockerfile");
    // RUN conflict → fallback (unresolved)
    expect(result.stats.autoResolved).toBe(0);
  });
});

// ─── Commentaires ─────────────────────────────────────────────

describe("Dockerfile — préservation avec commentaires", () => {
  it("résout correctement quand des commentaires sont présents", () => {
    const input = [
      `<<<<<<< ours`,
      `# Build stage`,
      `FROM node:18-alpine`,
      `ENV NODE_ENV=test`,
      `=======`,
      `# Build stage`,
      `FROM node:18-alpine`,
      `ENV NODE_ENV=production`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("NODE_ENV=production");
  });
});
