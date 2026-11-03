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

// ─── Appariement des stages sans alias ───────────────────────────────────────
// Régression : les stages étaient appariés par `alias ?? image` (et par une clé
// aléatoire sans FROM). Sans alias, deux FROM différents ne s'appariaient pas et
// les deux stages étaient gardés ; sans FROM dans le hunk, rien ne s'appariait.

function dockerHunk(ours: string[], base: string[], theirs: string[], after: string[] = []): string {
  return [
    `<<<<<<< ours`, ...ours,
    `||||||| base`, ...base,
    `=======`, ...theirs,
    `>>>>>>> theirs`, ...after,
  ].join("\n");
}

describe("Dockerfile — stages sans alias appariés par position", () => {
  it("hunk limité au FROM : une seule ligne FROM (prefer theirs)", () => {
    const input = dockerHunk([`FROM node:20-alpine`], [`FROM node:18-alpine`], [`FROM node:22-alpine`], [`RUN npm ci`]);
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent?.match(/^FROM /gm)).toHaveLength(1);
    expect(result.mergedContent).toContain("FROM node:22-alpine");
    expect(result.mergedContent).not.toContain("node:20-alpine");
  });

  it("FROM + instructions : un seul stage, instructions des deux côtés", () => {
    const input = dockerHunk(
      [`FROM node:20-alpine`, `ENV A=1`],
      [`FROM node:18-alpine`],
      [`FROM node:22-alpine`, `ENV B=2`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent?.match(/^FROM /gm)).toHaveLength(1);
    expect(result.mergedContent).toContain("ENV A=1");
    expect(result.mergedContent).toContain("ENV B=2");
  });

  it("deux stages sans alias : appariés un à un", () => {
    const input = dockerHunk(
      [`FROM golang:1.21`, `RUN go build`, `FROM alpine:3.18`],
      [`FROM golang:1.20`, `RUN go build`, `FROM alpine:3.17`],
      [`FROM golang:1.22`, `RUN go build`, `FROM alpine:3.19`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent?.match(/^FROM /gm)).toHaveLength(2);
    expect(result.mergedContent).toContain("FROM golang:1.22");
    expect(result.mergedContent).toContain("FROM alpine:3.19");
    expect(result.mergedContent?.match(/RUN go build/g)).toHaveLength(1);
  });

  it("hunk sans FROM : la même instruction n'est pas dupliquée", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV PORT=3000`], [`ENV PORT=8080`], [`ENV PORT=4000`], [`RUN npm ci`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent?.match(/ENV PORT=/g)).toHaveLength(1);
    expect(result.mergedContent).toContain("ENV PORT=4000");
  });

  it("alias d'un côté seulement : pas de résolution automatique", () => {
    const input = dockerHunk([`FROM node:20 AS build`], [`FROM node:18`], [`FROM node:22`]);
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(0);
  });

  it("nombre de stages sans alias différent : pas de résolution automatique", () => {
    const input = dockerHunk(
      [`FROM node:20`, `RUN npm ci`, `FROM nginx:1.25`],
      [`FROM node:18`, `RUN npm ci`],
      [`FROM node:22`, `RUN npm ci`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(0);
  });
});

// ─── Changement d'un seul côté : jamais effacé par « prefer theirs » ─────────
// Avec l'appariement par position, une modification faite seulement côté ours
// (bump d'image, ENV) était remplacée par la valeur de base venue de theirs.

describe("Dockerfile — la base départage les instructions", () => {
  it("FROM changé côté ours seulement, ENV changé côté theirs : les deux gardés", () => {
    const input = dockerHunk([`FROM node:20`, `ENV A=1`], [`FROM node:18`, `ENV A=1`], [`FROM node:18`, `ENV A=2`]);
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("FROM node:20");
    expect(result.mergedContent).toContain("ENV A=2");
    expect(result.mergedContent?.match(/^FROM /gm)).toHaveLength(1);
  });

  it("hunk sans FROM : ENV changé de chaque côté sur des clés différentes", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV PORT=3000`, `ENV B=1`], [`ENV PORT=8080`, `ENV B=1`], [`ENV PORT=8080`, `ENV B=2`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("ENV PORT=3000");
    expect(result.mergedContent).toContain("ENV B=2");
    expect(result.mergedContent).not.toContain("PORT=8080");
  });

  it("second stage bumpé côté ours seulement : bump gardé", () => {
    const input = dockerHunk(
      [`FROM golang:1.21`, `RUN go build`, `FROM alpine:3.19`],
      [`FROM golang:1.21`, `RUN go build`, `FROM alpine:3.18`],
      [`FROM debian:12`, `RUN go build`, `FROM alpine:3.18`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("FROM debian:12");
    expect(result.mergedContent).toContain("FROM alpine:3.19");
    expect(result.mergedContent).not.toContain("alpine:3.18");
  });
});

// ─── Clé répétée côté theirs : jamais d'instruction perdue ───────────────────
describe("Dockerfile — instructions de même clé côté theirs", () => {
  it("theirs ajoute un second RUN : RUN a n'est pas perdu", () => {
    const input = dockerHunk(
      [`FROM node:20 AS app`, `ENV A=2`, `RUN a`],
      [`FROM node:20 AS app`, `ENV A=1`, `RUN a`],
      [`FROM node:20 AS app`, `ENV A=1`, `RUN a`, `RUN b`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("RUN a");
    expect(result.mergedContent).toContain("RUN b");
    expect(result.mergedContent).toContain("ENV A=2");
  });

  it("theirs ajoute un COPY : le premier COPY n'est pas perdu (hunk sans FROM)", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=2`, `COPY a .`], [`ENV A=1`, `COPY a .`], [`ENV A=1`, `COPY a .`, `COPY b .`])].join("\n");
    const result = resolve(input, "Dockerfile");
    if (result.mergedContent) {
      expect(result.mergedContent).toContain("COPY a .");
      expect(result.mergedContent).toContain("COPY b .");
    }
  });

  it("hunk au milieu d'une continuation `\\` : pas de fusion Dockerfile", () => {
    const input = [`FROM node:20`, `RUN apt-get install \\`, dockerHunk([`    pkg-a \\`, `    pkg-b`], [`    pkg-a`], [`    pkg-a \\`, `    pkg-c`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.resolutions[0].resolutionReason ?? "").not.toMatch(/merged by stage/);
    expect(result.mergedContent ?? "").not.toMatch(/pkg-c\n\s*pkg-c/);
  });
});

describe("Dockerfile — instructions de même clé côté ours", () => {
  it("ours ajoute un RUN que theirs a aussi : jamais en double", () => {
    const input = dockerHunk(
      [`FROM node:20 AS app`, `ENV A=2`, `RUN npm ci`, `RUN npm run build`],
      [`FROM node:20 AS app`, `ENV A=1`, `RUN npm ci`],
      [`FROM node:20 AS app`, `ENV A=1`, `RUN npm run build`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.mergedContent?.match(/RUN npm run build/g) ?? []).not.toHaveLength(2);
  });

  it("ENV répété côté ours : aucune valeur perdue en silence", () => {
    const input = dockerHunk(
      [`FROM node:20 AS app`, `ENV PATH=p1`, `ENV PATH=p2`],
      [`FROM node:20 AS app`, `ENV PATH=p1`],
      [`FROM node:20 AS app`, `ENV PATH=p3`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.resolutions[0].resolutionReason ?? "").not.toMatch(/merged by stage/);
  });

  it("MAINTAINER est une instruction : la fusion par stage reste possible", () => {
    const input = dockerHunk(
      [`FROM node:20 AS app`, `MAINTAINER x`, `ENV A=2`],
      [`FROM node:20 AS app`, `MAINTAINER x`, `ENV A=1`],
      [`FROM node:20 AS app`, `MAINTAINER x`, `ENV A=1`, `EXPOSE 80`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("ENV A=2");
    expect(result.mergedContent).toContain("EXPOSE 80");
    expect(result.mergedContent?.match(/MAINTAINER x/g)).toHaveLength(1);
  });
});
