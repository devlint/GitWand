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

// ─── Suppressions, commentaires et ordre (lot 3.15.x A) ─────────────────────
// Régressions : une instruction supprimée d'un seul côté revenait (une
// instruction présente d'un seul côté était toujours gardée) ; tous les
// commentaires partageaient la clé `COMMENT`, si bien qu'un commentaire pouvait
// en remplacer un autre ; la sortie suivait l'ordre de ours, si bien qu'un
// réordonnancement fait côté theirs était perdu.

describe("Dockerfile — suppression d'un seul côté", () => {
  it("theirs supprime une instruction que ours n'a pas touchée : elle ne revient pas", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=2`, `ENV B=1`], [`ENV A=1`, `ENV B=1`], [`ENV A=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("ENV A=2");
    expect(result.mergedContent).not.toContain("ENV B=1");
  });

  it("ours supprime une instruction que theirs n'a pas touchée : elle ne revient pas", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=1`], [`ENV A=1`, `ENV B=1`], [`ENV A=2`, `ENV B=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("ENV A=2");
    expect(result.mergedContent).not.toContain("ENV B=1");
  });

  it("supprimée d'un côté, modifiée de l'autre : pas de résolution automatique", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=2`, `ENV B=3`], [`ENV A=1`, `ENV B=1`], [`ENV A=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(0);
  });

  it("sans base (diff2), une instruction d'un seul côté est gardée comme avant", () => {
    const input = [`FROM node:20`, `<<<<<<< ours`, `ENV A=2`, `ENV B=1`, `=======`, `ENV A=1`, `>>>>>>> theirs`].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("ENV B=1");
  });
});

describe("Dockerfile — commentaires", () => {
  it("un commentaire ajouté de chaque côté : aucun ne remplace l'autre", () => {
    const input = [`FROM node:20`, dockerHunk([`# build deps`, `RUN make`], [`RUN make`], [`# cache layer`, `RUN make`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("# build deps");
    expect(result.mergedContent).toContain("# cache layer");
  });

  it("un commentaire supprimé d'un côté ne revient pas", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=2`], [`# old note`, `ENV A=1`], [`# old note`, `ENV A=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("ENV A=2");
    expect(result.mergedContent).not.toContain("# old note");
  });
});

describe("Dockerfile — ordre des instructions", () => {
  it("theirs réordonne, ours garde l'ordre de la base : l'ordre de theirs est gardé", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=2`, `ENV B=1`], [`ENV A=1`, `ENV B=1`], [`ENV B=1`, `ENV A=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent ?? "";
    expect(merged).toContain("ENV A=2");
    expect(merged.indexOf("ENV B=1")).toBeLessThan(merged.indexOf("ENV A=2"));
  });

  it("ours réordonne, theirs garde l'ordre de la base : l'ordre de ours est gardé", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV B=1`, `ENV A=1`], [`ENV A=1`, `ENV B=1`], [`ENV A=2`, `ENV B=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent ?? "";
    expect(merged.indexOf("ENV B=1")).toBeLessThan(merged.indexOf("ENV A=2"));
  });

  it("chaque côté réordonne autrement : pas de résolution automatique", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`ENV C=1`, `ENV A=1`, `ENV B=1`],
      [`ENV A=1`, `ENV B=1`, `ENV C=1`],
      [`ENV B=1`, `ENV A=1`, `ENV C=2`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(0);
  });
});

describe("Dockerfile — review du lot A", () => {
  it("theirs réordonne, ours ajoute une instruction : elle reste à sa place (avant USER)", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`ENV A=1`, `ENV B=1`, `RUN apt-get install -y curl`, `USER node`],
      [`ENV A=1`, `ENV B=1`, `USER node`],
      [`ENV B=1`, `ENV A=1`, `USER node`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent ?? "";
    expect(merged.indexOf("RUN apt-get")).toBeLessThan(merged.indexOf("USER node"));
    expect(merged.indexOf("ENV B=1")).toBeLessThan(merged.indexOf("ENV A=1"));
  });

  it("ours mène, theirs ajoute une instruction : elle reste à sa place (avant USER)", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`ENV A=2`, `USER node`],
      [`ENV A=1`, `USER node`],
      [`ENV A=1`, `RUN make`, `USER node`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent ?? "";
    expect(merged.indexOf("RUN make")).toBeLessThan(merged.indexOf("USER node"));
  });

  it("un stage entier supprimé d'un côté et inchangé de l'autre ne revient pas", () => {
    const input = dockerHunk(
      [`FROM node:20 AS build`, `RUN npm ci`, `FROM node:20 AS test`, `RUN npm test`],
      [`FROM node:18 AS build`, `RUN npm ci`, `FROM node:20 AS test`, `RUN npm test`],
      [`FROM node:18 AS build`, `RUN npm ci`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("FROM node:20 AS build");
    expect(result.mergedContent).not.toContain("AS test");
  });

  it("un stage supprimé d'un côté et modifié de l'autre : pas de résolution automatique", () => {
    const input = dockerHunk(
      [`FROM node:20 AS build`, `RUN npm ci`, `FROM node:22 AS test`, `RUN npm test`],
      [`FROM node:18 AS build`, `RUN npm ci`, `FROM node:20 AS test`, `RUN npm test`],
      [`FROM node:18 AS build`, `RUN npm ci`],
    );
    expect(resolve(input, "Dockerfile").stats.autoResolved).toBe(0);
  });

  it("un même commentaire ajouté deux fois d'un seul côté reste en double", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`ENV A=2`],
      [`ENV A=1`],
      [`ENV A=1`, `# ----`, `ENV Z=1`, `# ----`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect((result.mergedContent ?? "").match(/^# ----$/gm)).toHaveLength(2);
  });

  it("le même commentaire de base réécrit autrement de chaque côté : pas de résolution automatique", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`# Uses node 22`, `ENV A=1`],
      [`# Uses node 20`, `ENV A=1`],
      [`# Uses node 21`, `ENV A=1`],
    )].join("\n");
    expect(resolve(input, "Dockerfile").stats.autoResolved).toBe(0);
  });
});

describe("Dockerfile — review du lot A, passe 2", () => {
  it("un commentaire déjà présent une fois dans la base, ajouté une seconde fois d'un côté : les deux copies restent, à leur place", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`# ----`, `ENV A=2`],
      [`# ----`, `ENV A=1`],
      [`# ----`, `ENV A=1`, `# ----`, `ENV Z=1`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent ?? "";
    expect(merged.match(/^# ----$/gm)).toHaveLength(2);
    expect(merged.indexOf("ENV A=2")).toBeLessThan(merged.indexOf("ENV Z=1"));
  });

  it("WORKDIR changé différemment de chaque côté : pas de résolution automatique", () => {
    const input = [`FROM node:20`, dockerHunk([`WORKDIR /srv`], [`WORKDIR /app`], [`WORKDIR /opt`])].join("\n");
    expect(resolve(input, "Dockerfile").stats.autoResolved).toBe(0);
  });

  it("WORKDIR changé d'un seul côté : ce changement est gardé, une seule fois", () => {
    const input = [`FROM node:20`, dockerHunk([`WORKDIR /srv`, `ENV A=1`], [`WORKDIR /app`, `ENV A=1`], [`WORKDIR /app`, `ENV A=2`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent?.match(/^WORKDIR /gm)).toHaveLength(1);
    expect(result.mergedContent).toContain("WORKDIR /srv");
  });

  it("un commentaire supprimé d'un côté et réécrit de l'autre : pas de résolution automatique", () => {
    const input = [`FROM node:20`, dockerHunk([`# b`, `ENV A=1`], [`# a`, `ENV A=1`], [`ENV A=2`])].join("\n");
    expect(resolve(input, "Dockerfile").stats.autoResolved).toBe(0);
  });

  it("les deux côtés retirent le même commentaire et en ajoutent d'autres ailleurs : laissé au moteur textuel, rien de perdu en silence", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`ENV A=1`, `# deps`, `RUN make`, `CMD ["x"]`],
      [`# obsolete`, `ENV A=1`, `RUN make`, `CMD ["x"]`],
      [`ENV A=1`, `RUN make`, `# build`, `CMD ["x"]`],
    )].join("\n");
    // Les deux côtés ont changé les commentaires : le résolveur Dockerfile
    // ne choisit pas ; ici le moteur textuel ne tranche pas non plus.
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(0);
  });

  it("une ligne vide ajoutée par le côté qui ne mène pas est gardée", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`ENV A=1`, ``, `ENV B=1`, `ENV C=1`],
      [`ENV A=1`, ``, `ENV B=1`],
      [`ENV A=1`, ``, `ENV B=1`, ``, `ENV D=1`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const lines = (result.mergedContent ?? "").split("\n");
    expect(lines.filter((l) => l === "")).toHaveLength(2);
    const d = lines.indexOf("ENV D=1");
    expect(lines[d - 1]).toBe("");
  });
});

describe("Dockerfile — review du lot A, passe 3", () => {
  it("le côté qui mène garde une copie que l'autre a retirée : elle ne revient pas", () => {
    const input = [`FROM node:20`, dockerHunk([`# --`, `ENV A=2`, `# --`], [`# --`, `ENV A=1`, `# --`], [`ENV A=1`, `# --`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect((result.mergedContent ?? "").match(/^# --$/gm)).toHaveLength(1);
  });

  it("ours ajoute une copie en fin, theirs retire celle de la base : chacune à son emplacement", () => {
    // Emplacement ENV A : base [# --], ours [# --], theirs [] → retirée.
    // Fin de stage : seul ours ajoute # --.
    const input = [`FROM node:20`, dockerHunk([`# --`, `ENV A=2`, `# --`], [`# --`, `ENV A=1`], [`ENV A=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toBe([`FROM node:20`, `ENV A=2`, `# --`].join("\n"));
  });

  it("WORKDIR changé d'un côté et supprimé de l'autre : pas de résolution automatique", () => {
    const input = [`FROM node:20`, dockerHunk([`WORKDIR /srv`, `ENV A=1`], [`WORKDIR /app`, `ENV A=1`], [`ENV A=2`])].join("\n");
    expect(resolve(input, "Dockerfile").stats.autoResolved).toBe(0);
  });

  it("un commentaire ajouté reste juste avant l'instruction qu'il décrit", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV A=1`, `RUN y`, `CMD x`], [`ENV A=1`, `CMD x`], [`ENV A=1`, `# start`, `CMD x`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    const lines = (result.mergedContent ?? "").split("\n");
    expect(lines[lines.indexOf("CMD x") - 1]).toBe("# start");
  });

  it("une ligne vide déplacée d'un côté et retirée de l'autre : laissée à l'utilisateur, jamais prise pour celle de la base", () => {
    // ours déplace la ligne vide (devant ENV C), theirs la retire : les deux
    // côtés ont changé les lignes vides, le résolveur Dockerfile ne choisit pas.
    const input = [`FROM node:20`, dockerHunk([`ENV A=1`, `ENV B=1`, ``, `ENV C=1`], [`ENV A=1`, ``, `ENV B=1`], [`ENV A=1`, `ENV B=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(0);
  });
});

describe("Dockerfile — review du lot A, passe 4", () => {
  it("une instruction à clé répétée dans la base, supprimée de l'autre côté : elle ne revient pas", () => {
    const input = [`FROM node:20`, dockerHunk([`ENV X=2`, `RUN a`], [`ENV X=1`, `RUN a`, `RUN b`], [`ENV X=1`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.mergedContent ?? "").not.toMatch(/^RUN a$/m);
  });

  it("commentaire réécrit d'un côté (WORKDIR changé dessous) et supprimé de l'autre : pas de résolution par le résolveur Dockerfile", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`# use srv`, `WORKDIR /srv`, `ENV A=1`],
      [`# use app`, `WORKDIR /app`, `ENV A=1`],
      [`WORKDIR /app`, `ENV A=2`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.resolutions[0]?.resolutionReason ?? "").not.toMatch(/Dockerfile merged by stage/);
  });

  it("un stage ajouté d'un côté se place avant le stage qui le suivait de ce côté", () => {
    const input = dockerHunk(
      [`FROM node:20 AS x`, `RUN 1`],
      [`FROM node:18 AS x`, `RUN 1`],
      [`FROM a AS y`, `RUN 9`, `FROM node:18 AS x`, `COPY --from=y /o /o`, `RUN 1`],
    );
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toBe(
      [`FROM a AS y`, `RUN 9`, `FROM node:20 AS x`, `COPY --from=y /o /o`, `RUN 1`].join("\n"),
    );
  });
});

describe("Dockerfile — review du lot A, passe 5", () => {
  it("le même séparateur ajouté de chaque côté à des endroits différents : les deux restent", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`# ------`, `ENV A=1`, `ENV B=1`],
      [`ENV A=1`, `ENV B=1`],
      [`ENV A=1`, `# ------`, `ENV B=1`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toBe([`FROM node:20`, `# ------`, `ENV A=1`, `# ------`, `ENV B=1`].join("\n"));
  });

  it("theirs retire le séparateur au-dessus de ENV A : c'est celui-là qui part, pas l'autre", () => {
    const input = [`FROM node:20`, dockerHunk(
      [`# ---`, `ENV A=2`, ``, `# ---`, `ENV B=1`],
      [`# ---`, `ENV A=1`, ``, `# ---`, `ENV B=1`],
      [`ENV A=1`, ``, `# ---`, `ENV B=1`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toBe([`FROM node:20`, `ENV A=2`, ``, `# ---`, `ENV B=1`].join("\n"));
  });
});

describe("Dockerfile — review du lot A, passe 6", () => {
  it("un commentaire au-dessus de chacun de deux COPY : aucun ne disparaît ni ne change de place", () => {
    const stage = (env: string) => [`# deps`, `COPY package.json /app/`, `RUN npm ci`, ``, `COPY . /app/src/`, env];
    const input = [`FROM node:20`, dockerHunk(stage(`ENV A=2`), stage(`ENV A=1`), stage(`ENV A=1`))].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toBe([`FROM node:20`, ...stage(`ENV A=2`)].join("\n"));
  });

  it("une instruction insérée sous un commentaire de chaque côté : le commentaire n'est jamais dédoublé", () => {
    const input = [`FROM n`, dockerHunk(
      [`ENV A=1`, `# runtime`, `RUN x`, `USER node`],
      [`ENV A=1`, `# runtime`, `USER node`],
      [`ENV A=1`, `# runtime`, `EXPOSE 80`, `USER node`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    if (result.mergedContent) expect(result.mergedContent.match(/^# runtime$/gm)).toHaveLength(1);
  });

  it("theirs supprime un commentaire sous lequel ours insère : la suppression n'est pas perdue en silence", () => {
    const input = [`FROM n`, dockerHunk(
      [`ENV A=1`, `# runtime`, `RUN x`, `USER node`],
      [`ENV A=1`, `# runtime`, `USER node`],
      [`ENV A=1`, `USER node`],
    )].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.resolutions[0]?.resolutionReason ?? "").not.toMatch(/Dockerfile merged by stage/);
  });

  it("les deux côtés retirent le même WORKDIR, un seul en ajoute un autre ailleurs : fusion automatique", () => {
    const input = [`FROM n`, dockerHunk([`ENV A=2`], [`WORKDIR /app`, `ENV A=1`], [`ENV A=1`, `WORKDIR /x`])].join("\n");
    const result = resolve(input, "Dockerfile");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toBe([`FROM n`, `ENV A=2`, `WORKDIR /x`].join("\n"));
  });
});
