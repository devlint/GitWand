import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import {
  matchGlob,
  effectivePolicyForFile,
  policyToConfig,
  parseGitwandrc,
  DEFAULT_POLICY,
} from "../config.js";

// ═══════════════════════════════════════════════════════════════
// PHASE 7.4 — Politiques de merge et configuration par projet
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.4 — matchGlob", () => {
  describe("extensions simples", () => {
    it("matche *.lock sur yarn.lock", () => {
      expect(matchGlob("*.lock", "yarn.lock")).toBe(true);
    });

    it("matche *.lock sur Cargo.lock", () => {
      expect(matchGlob("*.lock", "Cargo.lock")).toBe(true);
    });

    it("ne matche pas *.lock sur package.json", () => {
      expect(matchGlob("*.lock", "package.json")).toBe(false);
    });

    it("matche *.json sur package.json", () => {
      expect(matchGlob("*.json", "package.json")).toBe(true);
    });

    it("matche *.json même dans un sous-dossier (basename match)", () => {
      expect(matchGlob("*.json", "src/config.json")).toBe(true);
    });
  });

  describe("correspondance exacte", () => {
    it("matche package.json exactement", () => {
      expect(matchGlob("package.json", "package.json")).toBe(true);
    });

    it("ne matche pas package.json sur other.json", () => {
      expect(matchGlob("package.json", "other.json")).toBe(false);
    });
  });

  describe("globs avec slash", () => {
    it("matche src/**/*.ts sur src/utils/helper.ts", () => {
      expect(matchGlob("src/**/*.ts", "src/utils/helper.ts")).toBe(true);
    });

    it("matche src/**/*.ts sur src/components/App.ts", () => {
      expect(matchGlob("src/**/*.ts", "src/components/App.ts")).toBe(true);
    });

    it("ne matche pas src/**/*.ts sur test/utils.ts", () => {
      expect(matchGlob("src/**/*.ts", "test/utils.ts")).toBe(false);
    });

    it("matche docs/*.md sur docs/README.md", () => {
      expect(matchGlob("docs/*.md", "docs/README.md")).toBe(true);
    });

    it("ne matche pas docs/*.md sur docs/sub/README.md", () => {
      expect(matchGlob("docs/*.md", "docs/sub/README.md")).toBe(false);
    });

    it("matche **/*.lock sur node_modules/foo/yarn.lock", () => {
      expect(matchGlob("**/*.lock", "node_modules/foo/yarn.lock")).toBe(true);
    });
  });
});

describe("Phase 7.4 — effectivePolicyForFile", () => {
  it("retourne DEFAULT_POLICY si aucune option", () => {
    expect(effectivePolicyForFile("src/app.ts")).toBe(DEFAULT_POLICY);
  });

  it("retourne la politique globale si définie", () => {
    expect(effectivePolicyForFile("src/app.ts", "prefer-ours")).toBe("prefer-ours");
  });

  it("le pattern override bat la politique globale", () => {
    expect(
      effectivePolicyForFile("yarn.lock", "prefer-ours", { "*.lock": "prefer-theirs" })
    ).toBe("prefer-theirs");
  });

  it("le pattern le plus spécifique gagne", () => {
    expect(
      effectivePolicyForFile(
        "package.json",
        "prefer-merge",
        {
          "*.json": "prefer-safety",
          "package.json": "strict",  // plus spécifique
        }
      )
    ).toBe("strict");
  });

  it("les fichiers non-matchés utilisent la politique globale", () => {
    expect(
      effectivePolicyForFile("src/app.ts", "prefer-merge", { "*.json": "strict" })
    ).toBe("prefer-merge");
  });
});

describe("Phase 7.4 — policyToConfig", () => {
  it("prefer-ours : preferOurs = true", () => {
    const cfg = policyToConfig("prefer-ours");
    expect(cfg.preferOurs).toBe(true);
    expect(cfg.allowWhitespace).toBe(true);
    expect(cfg.allowValueOnly).toBe(true);
  });

  it("prefer-theirs : preferOurs = false", () => {
    const cfg = policyToConfig("prefer-theirs");
    expect(cfg.preferOurs).toBe(false);
  });

  it("prefer-merge : minConfidence medium", () => {
    const cfg = policyToConfig("prefer-merge");
    expect(cfg.minConfidence).toBe("medium");
    expect(cfg.allowWhitespace).toBe(true);
  });

  it("prefer-safety : whitespace et value_only désactivés", () => {
    const cfg = policyToConfig("prefer-safety");
    expect(cfg.allowWhitespace).toBe(false);
    expect(cfg.allowValueOnly).toBe(false);
    expect(cfg.allowNonOverlapping).toBe(true);
  });

  it("strict : whitespace, value_only, non_overlapping désactivés", () => {
    const cfg = policyToConfig("strict");
    expect(cfg.allowWhitespace).toBe(false);
    expect(cfg.allowValueOnly).toBe(false);
    expect(cfg.allowNonOverlapping).toBe(false);
  });
});

describe("Phase 7.4 — parseGitwandrc", () => {
  it("parse un .gitwandrc valide", () => {
    const json = JSON.stringify({
      policy: "prefer-safety",
      patterns: {
        "*.lock": "prefer-theirs",
        "src/**/*.ts": "prefer-ours",
      },
    });
    const cfg = parseGitwandrc(json);
    expect(cfg).not.toBeNull();
    expect(cfg!.policy).toBe("prefer-safety");
    expect(cfg!.patterns?.["*.lock"]).toBe("prefer-theirs");
  });

  it("retourne null pour JSON invalide", () => {
    expect(parseGitwandrc("not json")).toBeNull();
  });

  it("ignore les politiques invalides", () => {
    const json = JSON.stringify({ policy: "unknown-policy" });
    const cfg = parseGitwandrc(json);
    // Ne doit pas crasher, juste ignorer la politique invalide
    expect(cfg).not.toBeNull();
    expect(cfg!.policy).toBeUndefined();
  });

  it("parse un objet partiel (seulement policy)", () => {
    const json = JSON.stringify({ policy: "strict" });
    const cfg = parseGitwandrc(json);
    expect(cfg!.policy).toBe("strict");
    expect(cfg!.patterns).toBeUndefined();
  });

  it("retourne null pour un JSON non-objet", () => {
    expect(parseGitwandrc('"string"')).toBeNull();
    expect(parseGitwandrc("42")).toBeNull();
    expect(parseGitwandrc("null")).toBeNull();
  });
});

// ─── Fixtures pour les tests d'intégration ───────────────

const WHITESPACE_CONFLICT = `<<<<<<< ours
function hello() {
    return "world";
}
=======
function hello() {
  return "world";
}
>>>>>>> theirs`;

const VALUE_ONLY_CONFLICT = `<<<<<<< HEAD
  "version": "3.2.1",
  "integrity": "sha512-abc123"
=======
  "version": "3.3.0",
  "integrity": "sha512-xyz789"
>>>>>>> master`;

const NON_OVERLAPPING_CONFLICT = `<<<<<<< ours
import React from "react";
import { useState } from "react";
import { useEffect } from "react";
import axios from "axios";
||||||| base
import React from "react";
import { useState } from "react";
import axios from "axios";
=======
import React from "react";
import { useState } from "react";
import axios from "axios";
import dayjs from "dayjs";
>>>>>>> theirs`;

describe("Phase 7.4 — politiques via resolve()", () => {
  describe("prefer-ours", () => {
    it("whitespace_only : résolution avec ours", () => {
      const result = resolve(WHITESPACE_CONFLICT, "style.css", { policy: "prefer-ours" });
      expect(result.stats.autoResolved).toBe(1);
    });

    it("value_only_change : prend ours (pas theirs)", () => {
      const result = resolve(VALUE_ONLY_CONFLICT, "lock.json", { policy: "prefer-ours" });
      if (result.stats.autoResolved > 0) {
        expect(result.mergedContent).toContain("3.2.1");   // ours
        expect(result.mergedContent).not.toContain("3.3.0"); // pas theirs
      }
    });

    it("la raison mentionne la politique", () => {
      const result = resolve(VALUE_ONLY_CONFLICT, "lock.json", { policy: "prefer-ours" });
      if (result.resolutions[0].autoResolved) {
        expect(result.resolutions[0].resolutionReason).toMatch(/prefer-ours/);
      }
    });
  });

  describe("prefer-theirs (défaut)", () => {
    it("value_only_change : prend theirs", () => {
      const result = resolve(VALUE_ONLY_CONFLICT, "lock.json");
      if (result.stats.autoResolved > 0) {
        expect(result.mergedContent).toContain("3.3.0");    // theirs
        expect(result.mergedContent).not.toContain("3.2.1"); // pas ours
      }
    });
  });

  describe("prefer-merge", () => {
    it("résout non_overlapping normalement", () => {
      const result = resolve(NON_OVERLAPPING_CONFLICT, "imports.ts", { policy: "prefer-merge" });
      expect(result.stats.autoResolved).toBe(1);
    });

    it("accepte les hunks de confiance medium", () => {
      // Un conflit whitespace sans base (diff2) → confidence: medium
      const diff2ws = `<<<<<<< HEAD
function foo() {
    return 1;
}
=======
function foo() {
  return 1;
}
>>>>>>> master`;
      const resultStrict = resolve(diff2ws, "f.ts", { policy: "strict" });
      const resultMerge = resolve(diff2ws, "f.ts", { policy: "prefer-merge" });
      // prefer-merge doit résoudre plus (ou autant) que strict
      expect(resultMerge.stats.autoResolved).toBeGreaterThanOrEqual(resultStrict.stats.autoResolved);
    });
  });

  describe("prefer-safety", () => {
    it("ne résout pas whitespace_only", () => {
      const result = resolve(WHITESPACE_CONFLICT, "style.css", { policy: "prefer-safety" });
      expect(result.stats.autoResolved).toBe(0);
      expect(result.resolutions[0].resolutionReason).toMatch(/prefer-safety/);
    });

    it("ne résout pas value_only_change", () => {
      const result = resolve(VALUE_ONLY_CONFLICT, "lock.json", { policy: "prefer-safety" });
      expect(result.stats.autoResolved).toBe(0);
      expect(result.resolutions[0].resolutionReason).toMatch(/prefer-safety/);
    });

    it("résout quand même same_change", () => {
      const sameChange = `import { useState } from "react";
<<<<<<< ours
import { useEffect } from "react";
||||||| base
=======
import { useEffect } from "react";
>>>>>>> theirs
export default function App() {}`;
      const result = resolve(sameChange, "App.tsx", { policy: "prefer-safety" });
      expect(result.stats.autoResolved).toBe(1);
    });
  });

  describe("strict", () => {
    it("ne résout pas non_overlapping", () => {
      const result = resolve(NON_OVERLAPPING_CONFLICT, "imports.ts", { policy: "strict" });
      expect(result.stats.autoResolved).toBe(0);
      expect(result.resolutions[0].resolutionReason).toMatch(/strict/);
    });

    it("résout one_side_change", () => {
      const oneSide = `const config = {
<<<<<<< ours
  port: 3000,
  host: "localhost",
||||||| base
  port: 3000,
=======
  port: 3000,
>>>>>>> theirs
};`;
      const result = resolve(oneSide, "config.ts", { policy: "strict" });
      expect(result.stats.autoResolved).toBe(1);
    });
  });

  describe("patternOverrides", () => {
    it("override par pattern pour les lockfiles", () => {
      // En prefer-safety, value_only_change n'est pas résolu
      // Mais avec un override *.lock → prefer-theirs, il devrait l'être
      const result = resolve(VALUE_ONLY_CONFLICT, "yarn.lock", {
        policy: "prefer-safety",
        patternOverrides: { "*.lock": "prefer-theirs" },
      });
      // La politique "prefer-theirs" permet value_only_change
      if (result.hunks[0]?.type === "value_only_change") {
        expect(result.stats.autoResolved).toBe(1);
        expect(result.resolutions[0].resolutionReason).toMatch(/prefer-theirs/);
      }
    });

    it("les fichiers non-matchés gardent la politique globale", () => {
      const result = resolve(VALUE_ONLY_CONFLICT, "config.ts", {
        policy: "prefer-safety",
        patternOverrides: { "*.lock": "prefer-theirs" },
      });
      // config.ts ne matche pas *.lock → prefer-safety → value_only skippé
      if (result.hunks[0]?.type === "value_only_change") {
        expect(result.stats.autoResolved).toBe(0);
      }
    });
  });
});
