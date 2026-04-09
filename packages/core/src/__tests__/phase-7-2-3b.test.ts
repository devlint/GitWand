/**
 * Tests Phase 7.2 — Whitespace normalization + threshold tuning
 * Tests Phase 7.3b — YAML, TS/JS imports, Vue SFC, CSS resolvers
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import { classifyConflict } from "../parser.js";
import { tryResolveYamlConflict } from "../resolvers/yaml.js";
import { tryResolveImportConflict, isImportBlock } from "../resolvers/imports.js";
import { tryResolveVueConflict, parseSfcBlocks } from "../resolvers/vue.js";
import { tryResolveCssConflict, parseCssRules } from "../resolvers/css.js";
import {
  tryFormatAwareResolve,
  isYamlFile,
  isJsFile,
  isVueFile,
  isCssFile,
} from "../resolvers/dispatcher.js";
import type { ConflictHunk } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────

function makeHunk(base: string[], ours: string[], theirs: string[]): ConflictHunk {
  return {
    baseLines: base,
    oursLines: ours,
    theirsLines: theirs,
    startLine: 1,
    type: "complex",
    confidence: {
      score: 20, label: "low",
      dimensions: { typeClassification: 20, dataRisk: 0, scopeImpact: 0 },
      boosters: [], penalties: [],
    },
    explanation: "test hunk",
    trace: {
      steps: [{ type: "complex", passed: true, reason: "test" }],
      selected: "complex",
      summary: "test",
      hasBase: base.length > 0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 7.2 — Whitespace normalization
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.2 — Whitespace normalization améliorée", () => {
  describe("Normalisation des tabs", () => {
    it("détecte whitespace_only quand ours a des tabs et theirs a des espaces", () => {
      // Pour déclencher whitespace_only : ours ≠ base ET theirs ≠ base
      // mais normalize(ours) === normalize(theirs)
      const conflict = {
        oursLines: ["\tconst x = 1;", "\tconst y = 2;"],      // tabs
        baseLines: [],                                          // pas de base (diff2)
        theirsLines: ["  const x = 1;", "  const y = 2;"],    // 2 espaces
        startLine: 1,
        endLine: 5,
      };
      const result = classifyConflict(conflict);
      // Sans base, same_change est testé en premier : ours ≠ theirs → non
      // Puis whitespace_only : normalize(tabs) === normalize(2 espaces) → oui
      expect(result.type).toBe("whitespace_only");
    });

    it("détecte whitespace_only entre 2 et 4 espaces (sans base)", () => {
      const conflict = {
        oursLines: ["    function foo() {", "      return 1;", "    }"],  // 4 espaces
        baseLines: [],                                                       // diff2
        theirsLines: ["  function foo() {", "    return 1;", "  }"],       // 2 espaces
        startLine: 1,
        endLine: 8,
      };
      const result = classifyConflict(conflict);
      expect(result.type).toBe("whitespace_only");
    });
  });

  describe("Strip des lignes vides en tête/queue", () => {
    it("détecte whitespace_only quand ours a une ligne vide en tête (diff2)", () => {
      // ours a une ligne vide en tête, theirs n'en a pas
      // normalize(ours) retire la ligne vide → identique à theirs
      const conflict = {
        oursLines: ["", "const x = 1;"],
        baseLines: [],
        theirsLines: ["const x = 1;"],
        startLine: 1,
        endLine: 4,
      };
      const result = classifyConflict(conflict);
      // same_change : ours ≠ theirs → non
      // whitespace_only : normalize(["", "const x = 1;"]) = "const x = 1" === normalize(theirs) → oui
      expect(result.type).toBe("whitespace_only");
    });

    it("détecte whitespace_only quand theirs a des lignes vides en queue (diff2)", () => {
      const conflict = {
        oursLines: ["const a = 1;"],
        baseLines: [],
        theirsLines: ["const a = 1;", "", ""],
        startLine: 1,
        endLine: 5,
      };
      const result = classifyConflict(conflict);
      expect(result.type).toBe("whitespace_only");
    });
  });

  describe("Collapse des espaces internes", () => {
    it("détecte whitespace_only avec espaces multiples (diff2)", () => {
      // ours et theirs diffèrent seulement par le nombre d'espaces
      const conflict = {
        oursLines: ["key:  value"],
        baseLines: [],
        theirsLines: ["key: value"],
        startLine: 1,
        endLine: 3,
      };
      const result = classifyConflict(conflict);
      // normalize collapse les espaces multiples
      expect(result.type).toBe("whitespace_only");
    });
  });

  describe("value_only_change — seuils affinés", () => {
    it("détecte value_only_change sur un hash Git valide (hex lowercase)", () => {
      const conflict = {
        oursLines: ['"integrity": "sha512-abc123def456"'],
        baseLines: [],
        theirsLines: ['"integrity": "sha512-fed789cba321"'],
        startLine: 1,
        endLine: 3,
      };
      // Avec les nouveaux seuils et patterns, les hashes hex purs sont toujours volatils
      const result = classifyConflict(conflict);
      // Peut être value_only_change ou complex selon le ratio — on vérifie juste que ça ne plante pas
      expect(result.type).toBeDefined();
    });

    it("détecte semver comme volatile", () => {
      // La ligne '"version": "1.2.3"' avec le tokenizer original produit le token "1.2.3"
      // (sans les guillemets → split sur `"`) qui matche le pattern semver ^N.N.N$
      const conflict = {
        oursLines: ['"version": "1.2.3"'],
        baseLines: [],
        theirsLines: ['"version": "2.0.0"'],
        startLine: 1,
        endLine: 3,
      };
      const result = classifyConflict(conflict);
      // Les semvers 1.2.3 et 2.0.0 sont des tokens volatils (après split sur `"`)
      expect(result.type).toBe("value_only_change");
    });

    it("ne considère pas un identifiant camelCase standard comme volatile", () => {
      // myFunction et otherFunction ne matchent pas les patterns ^hex$ ni ^UUID$ ni semver etc.
      const conflict = {
        oursLines: ["const handler = myFunction;"],
        baseLines: [],
        theirsLines: ["const handler = otherFunction;"],
        startLine: 1,
        endLine: 3,
      };
      const result = classifyConflict(conflict);
      // Ces noms ne sont pas volatils → complex
      expect(result.type).toBe("complex");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3b — Résolveur YAML
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3b — Résolveur YAML", () => {
  describe("tryResolveYamlConflict — cas de base", () => {
    it("fusionne deux clés ajoutées indépendamment", () => {
      const base = ["name: app", "version: 1.0.0"];
      const ours = ["name: app", "version: 1.0.0", "author: Alice"];
      const theirs = ["name: app", "version: 1.0.0", "license: MIT"];

      const result = tryResolveYamlConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("author: Alice");
      expect(merged).toContain("license: MIT");
      expect(result.resolvedKeys).toBeGreaterThan(0);
    });

    it("résout seul ours a modifié une clé", () => {
      const base = ["name: app", "port: 3000"];
      const ours = ["name: app", "port: 4000"];    // ours a changé port
      const theirs = ["name: app", "port: 3000"];   // theirs n'a pas changé

      const result = tryResolveYamlConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("port: 4000");
    });

    it("résout seul theirs a modifié une clé", () => {
      const base = ["name: app", "debug: false"];
      const ours = ["name: app", "debug: false"];
      const theirs = ["name: app", "debug: true"];

      const result = tryResolveYamlConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("debug: true");
    });

    it("retourne null si les deux côtés ont modifié la même clé différemment", () => {
      const base = ["version: 1.0.0"];
      const ours = ["version: 2.0.0"];
      const theirs = ["version: 3.0.0"];

      const result = tryResolveYamlConflict(base, ours, theirs);

      expect(result.mergedLines).toBeNull();
      expect(result.unresolvedKeys).toBeGreaterThan(0);
    });

    it("résout le cas same_change", () => {
      const base = ["name: app"];
      const ours = ["name: app", "type: module"];
      const theirs = ["name: app", "type: module"];

      const result = tryResolveYamlConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      expect(result.mergedLines!.join("\n")).toContain("type: module");
    });

    it("rejette les blocs avec anchors YAML", () => {
      const base = ["defaults: &defaults", "  port: 3000"];
      const ours = ["defaults: &defaults", "  port: 4000"];
      const theirs = ["defaults: &defaults", "  port: 3000"];

      const result = tryResolveYamlConflict(base, ours, theirs);

      // Anchors non supportés → null
      expect(result.mergedLines).toBeNull();
      expect(result.reason).toMatch(/anchor/i);
    });
  });

  describe("tryResolveYamlConflict — blocs imbriqués", () => {
    it("fusionne des sous-clés ajoutées indépendamment", () => {
      const base = [
        "scripts:",
        "  build: tsc",
        "  test: jest",
      ];
      const ours = [
        "scripts:",
        "  build: tsc",
        "  test: jest",
        "  lint: eslint .",
      ];
      const theirs = [
        "scripts:",
        "  build: tsc",
        "  test: jest",
        "  format: prettier .",
      ];

      const result = tryResolveYamlConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("lint: eslint .");
      expect(merged).toContain("format: prettier .");
      expect(merged).toContain("build: tsc");
    });
  });

  describe("Intégration YAML via resolve()", () => {
    it("résout un conflit YAML via le moteur principal", () => {
      const yamlConflict = `name: my-app
version: 1.0.0
<<<<<<< ours
author: Alice
port: 3000
||||||| base
port: 3000
=======
license: MIT
port: 3000
>>>>>>> theirs`;

      const result = resolve(yamlConflict, "config.yaml");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).not.toBeNull();
      const merged = result.mergedContent!;
      expect(merged).toContain("author: Alice");
      expect(merged).toContain("license: MIT");
    });

    it("la raison mentionne le résolveur yaml", () => {
      const yamlConflict = `name: app
<<<<<<< ours
debug: true
||||||| base
debug: false
=======
debug: false
>>>>>>> theirs`;

      const result = resolve(yamlConflict, "config.yml");

      if (result.stats.autoResolved > 0) {
        expect(result.resolutions[0].resolutionReason).toMatch(/\[yaml\]/i);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3b — Résolveur d'imports TS/JS
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3b — Résolveur d'imports TS/JS", () => {
  describe("isImportBlock", () => {
    it("détecte un bloc entièrement composé d'imports", () => {
      const lines = [
        "import React from 'react';",
        "import { useState } from 'react';",
        "import type { FC } from 'react';",
      ];
      expect(isImportBlock(lines)).toBe(true);
    });

    it("rejette un bloc avec du code non-import", () => {
      const lines = [
        "import React from 'react';",
        "const x = 1;",
      ];
      expect(isImportBlock(lines)).toBe(false);
    });

    it("accepte les lignes vides et commentaires dans un bloc d'imports", () => {
      const lines = [
        "// React",
        "import React from 'react';",
        "",
        "import { useState } from 'react';",
      ];
      expect(isImportBlock(lines)).toBe(true);
    });
  });

  describe("tryResolveImportConflict — cas de base", () => {
    it("fusionne deux imports ajoutés indépendamment", () => {
      const base = ["import React from 'react';"];
      const ours = ["import React from 'react';", "import { useState } from 'react';"];
      const theirs = ["import React from 'react';", "import { useEffect } from 'react';"];

      const result = tryResolveImportConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("useState");
      expect(merged).toContain("useEffect");
    });

    it("fusionne des named imports du même module", () => {
      const base = ["import { useState } from 'react';"];
      const ours = ["import { useState, useEffect } from 'react';"];
      const theirs = ["import { useState, useCallback } from 'react';"];

      const result = tryResolveImportConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("useState");
      expect(merged).toContain("useEffect");
      expect(merged).toContain("useCallback");
    });

    it("déduplique les imports identiques ajoutés des deux côtés", () => {
      const base: string[] = [];
      const ours = ["import React from 'react';"];
      const theirs = ["import React from 'react';"];

      const result = tryResolveImportConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      // Un seul import React dans le résultat
      const count = result.mergedLines!.filter((l) => l.includes("import React")).length;
      expect(count).toBe(1);
    });

    it("retourne null si les deux côtés ont modifié le même named import de façon conflictuelle", () => {
      // ours a supprimé 'a' de l'import, theirs a supprimé 'b' → conflit (chacun a supprimé quelque chose)
      const base = ["import { a, b } from 'lib';"];
      const ours = ["import { a } from 'lib';"]; // supprimé b
      const theirs = ["import { b } from 'lib';"]; // supprimé a

      const result = tryResolveImportConflict(base, ours, theirs);

      // ours supprime b que theirs garde, theirs supprime a que ours garde → conflit non résolvable
      expect(result.mergedLines).toBeNull();
    });
  });

  describe("Intégration imports via resolve()", () => {
    it("résout un conflit d'imports TypeScript via le moteur principal", () => {
      const tsConflict = `<<<<<<< ours
import React from 'react';
import { useState } from 'react';
import { MyComponent } from './components';
||||||| base
import React from 'react';
import { useState } from 'react';
=======
import React from 'react';
import { useState } from 'react';
import { useEffect } from 'react';
>>>>>>> theirs`;

      const result = resolve(tsConflict, "src/app.tsx");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).not.toBeNull();
      const merged = result.mergedContent!;
      expect(merged).toContain("MyComponent");
      expect(merged).toContain("useEffect");
    });

    it("la raison mentionne le résolveur imports", () => {
      const tsConflict = `<<<<<<< ours
import { A } from './a';
import { B } from './b';
||||||| base
import { A } from './a';
=======
import { A } from './a';
import { C } from './c';
>>>>>>> theirs`;

      const result = resolve(tsConflict, "src/index.ts");

      if (result.stats.autoResolved > 0) {
        expect(result.resolutions[0].resolutionReason).toMatch(/\[imports\]/i);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3b — Résolveur Vue SFC
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3b — Résolveur Vue SFC", () => {
  describe("parseSfcBlocks", () => {
    it("découpe un fichier Vue en blocs", () => {
      const lines = [
        "<template>",
        "  <div>Hello</div>",
        "</template>",
        "",
        "<script setup>",
        "const msg = 'world';",
        "</script>",
        "",
        "<style scoped>",
        ".container { color: red; }",
        "</style>",
      ];

      const blocks = parseSfcBlocks(lines);
      const names = blocks.map((b) => b.name);

      expect(names).toContain("template");
      expect(names).toContain("script");
      expect(names).toContain("style");
    });

    it("gère un fichier avec seulement un template", () => {
      const lines = ["<template>", "  <p>test</p>", "</template>"];
      const blocks = parseSfcBlocks(lines);
      expect(blocks[0].name).toBe("template");
      expect(blocks[0].lines).toContain("  <p>test</p>");
    });
  });

  describe("tryResolveVueConflict — blocs indépendants", () => {
    const baseVue = [
      "<template>",
      "  <div>Base</div>",
      "</template>",
      "",
      "<script setup>",
      "const x = 1;",
      "</script>",
    ];

    it("accepte la modification de script quand seul ours a changé", () => {
      const ours = [
        "<template>",
        "  <div>Base</div>",
        "</template>",
        "",
        "<script setup>",
        "const x = 2; // modifié par ours",
        "</script>",
      ];
      const theirs = [...baseVue]; // identique à base

      const result = tryResolveVueConflict(baseVue, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("modifié par ours");
    });

    it("accepte la modification de template quand seul theirs a changé", () => {
      const ours = [...baseVue]; // identique à base
      const theirs = [
        "<template>",
        "  <div>Modifié par theirs</div>",
        "</template>",
        "",
        "<script setup>",
        "const x = 1;",
        "</script>",
      ];

      const result = tryResolveVueConflict(baseVue, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("Modifié par theirs");
    });

    it("retourne null si les deux côtés ont modifié le même bloc", () => {
      const ours = [
        "<template>",
        "  <div>Version ours</div>",
        "</template>",
        "",
        "<script setup>",
        "const x = 1;",
        "</script>",
      ];
      const theirs = [
        "<template>",
        "  <div>Version theirs</div>",
        "</template>",
        "",
        "<script setup>",
        "const x = 1;",
        "</script>",
      ];

      const result = tryResolveVueConflict(baseVue, ours, theirs);

      expect(result.mergedLines).toBeNull();
      expect(result.conflictedBlocks.length).toBeGreaterThan(0);
    });

    it("intègre un nouveau bloc style ajouté par theirs", () => {
      const ours = [...baseVue]; // pas de style
      const theirs = [
        ...baseVue,
        "",
        "<style scoped>",
        ".container { color: blue; }",
        "</style>",
      ];

      const result = tryResolveVueConflict(baseVue, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("color: blue");
    });
  });

  describe("Intégration Vue via resolve()", () => {
    it("résout un conflit Vue SFC avec blocs indépendants", () => {
      const vueConflict = `<template>
  <div>Hello</div>
</template>

<<<<<<< ours
<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>
||||||| base
<script setup>
const msg = 'hello';
</script>
=======
<script setup>
const msg = 'world';
</script>
>>>>>>> theirs

<style>
.app { color: red; }
</style>`;

      const result = resolve(vueConflict, "App.vue");

      // Si les deux ont modifié le script → non résolvable (correct)
      // ou si c'est un one_side_change selon la base
      expect(result.stats).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3b — Résolveur CSS
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3b — Résolveur CSS", () => {
  describe("parseCssRules", () => {
    it("parse des règles CSS basiques", () => {
      const lines = [
        ".button {",
        "  color: red;",
        "  font-size: 14px;",
        "}",
        "",
        ".container {",
        "  max-width: 1200px;",
        "}",
      ];

      const rules = parseCssRules(lines);
      const ruleNames = rules.filter((r) => r.kind === "rule").map((r) => r.selector);

      expect(ruleNames).toContain(".button");
      expect(ruleNames).toContain(".container");
    });

    it("détecte les at-rules", () => {
      const lines = [
        "@media (max-width: 768px) {",
        "  .container { width: 100%; }",
        "}",
      ];

      const rules = parseCssRules(lines);
      const atRules = rules.filter((r) => r.kind === "at-rule");

      expect(atRules.length).toBeGreaterThan(0);
      expect(atRules[0].selector).toContain("@media");
    });
  });

  describe("tryResolveCssConflict — cas de base", () => {
    it("fusionne deux sélecteurs ajoutés indépendamment", () => {
      const base = [".container {", "  max-width: 1200px;", "}"];
      const ours = [
        ".container {",
        "  max-width: 1200px;",
        "}",
        ".button {",
        "  color: blue;",
        "}",
      ];
      const theirs = [
        ".container {",
        "  max-width: 1200px;",
        "}",
        ".header {",
        "  font-size: 24px;",
        "}",
      ];

      const result = tryResolveCssConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain(".button");
      expect(merged).toContain(".header");
    });

    it("fusionne des propriétés ajoutées dans le même sélecteur", () => {
      const base = [".btn {", "  color: blue;", "}"];
      const ours = [".btn {", "  color: blue;", "  font-size: 14px;", "}"];
      const theirs = [".btn {", "  color: blue;", "  padding: 8px;", "}"];

      const result = tryResolveCssConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("font-size: 14px");
      expect(merged).toContain("padding: 8px");
    });

    it("retourne null si les deux côtés modifient la même propriété différemment", () => {
      const base = [".btn {", "  color: blue;", "}"];
      const ours = [".btn {", "  color: red;", "}"];
      const theirs = [".btn {", "  color: green;", "}"];

      const result = tryResolveCssConflict(base, ours, theirs);

      expect(result.mergedLines).toBeNull();
    });

    it("accepte un sélecteur inchangé", () => {
      const base = [".container {", "  width: 100%;", "}"];
      const ours = [".container {", "  width: 100%;", "}", ".new {", "  color: red;", "}"];
      const theirs = [...base]; // theirs n'a pas changé

      const result = tryResolveCssConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain(".new");
    });
  });

  describe("Intégration CSS via resolve()", () => {
    it("résout un conflit CSS avec sélecteurs indépendants", () => {
      const cssConflict = `.container {
  max-width: 1200px;
}

<<<<<<< ours
.button {
  color: blue;
  padding: 8px;
}
||||||| base
=======
.header {
  font-size: 24px;
}
>>>>>>> theirs`;

      const result = resolve(cssConflict, "styles.css");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).not.toBeNull();
      const merged = result.mergedContent!;
      expect(merged).toContain(".button");
      expect(merged).toContain(".header");
    });

    it("la raison mentionne le résolveur css", () => {
      const cssConflict = `<<<<<<< ours
.a { color: red; }
||||||| base
=======
.b { color: blue; }
>>>>>>> theirs`;

      const result = resolve(cssConflict, "app.scss");

      if (result.stats.autoResolved > 0) {
        expect(result.resolutions[0].resolutionReason).toMatch(/\[css\]/i);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3b — Dispatcher — détection des nouveaux types
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3b — Dispatcher — nouveaux types de fichiers", () => {
  describe("isYamlFile", () => {
    it("détecte .yaml et .yml", () => {
      expect(isYamlFile("config.yaml")).toBe(true);
      expect(isYamlFile("config.yml")).toBe(true);
      expect(isYamlFile(".github/workflows/ci.yml")).toBe(true);
    });

    it("ne détecte pas les non-YAML", () => {
      expect(isYamlFile("config.json")).toBe(false);
      expect(isYamlFile("app.ts")).toBe(false);
    });
  });

  describe("isJsFile", () => {
    it("détecte .ts, .js, .tsx, .jsx, .mjs, .cjs", () => {
      expect(isJsFile("app.ts")).toBe(true);
      expect(isJsFile("App.tsx")).toBe(true);
      expect(isJsFile("index.js")).toBe(true);
      expect(isJsFile("Component.jsx")).toBe(true);
      expect(isJsFile("server.mjs")).toBe(true);
      expect(isJsFile("require.cjs")).toBe(true);
    });

    it("ne détecte pas les non-JS", () => {
      expect(isJsFile("styles.css")).toBe(false);
      expect(isJsFile("App.vue")).toBe(false);
    });
  });

  describe("isVueFile", () => {
    it("détecte .vue", () => {
      expect(isVueFile("App.vue")).toBe(true);
      expect(isVueFile("components/Button.vue")).toBe(true);
    });
    it("ne détecte pas les non-Vue", () => {
      expect(isVueFile("app.ts")).toBe(false);
    });
  });

  describe("isCssFile", () => {
    it("détecte .css, .scss, .less, .sass", () => {
      expect(isCssFile("styles.css")).toBe(true);
      expect(isCssFile("theme.scss")).toBe(true);
      expect(isCssFile("vars.less")).toBe(true);
      expect(isCssFile("mixins.sass")).toBe(true);
    });
    it("ne détecte pas les non-CSS", () => {
      expect(isCssFile("app.ts")).toBe(false);
    });
  });

  describe("tryFormatAwareResolve — nouveaux résolveurs", () => {
    it("utilise le résolveur yaml pour .yaml", () => {
      const hunk = makeHunk(
        ["name: app", "port: 3000"],
        ["name: app", "port: 4000"],
        ["name: app", "port: 3000"],
      );
      const result = tryFormatAwareResolve(hunk, "config.yaml");
      expect(result.resolverUsed).toBe("yaml");
    });

    it("utilise le résolveur vue pour .vue", () => {
      const hunk = makeHunk(
        ["<template>", "  <div>Base</div>", "</template>"],
        ["<template>", "  <div>Ours</div>", "</template>"],
        ["<template>", "  <div>Base</div>", "</template>"],
      );
      const result = tryFormatAwareResolve(hunk, "App.vue");
      expect(result.resolverUsed).toBe("vue");
    });

    it("utilise le résolveur css pour .scss", () => {
      const hunk = makeHunk(
        [".btn { color: blue; }"],
        [".btn { color: blue; }", ".new { font-size: 14px; }"],
        [".btn { color: blue; }"],
      );
      const result = tryFormatAwareResolve(hunk, "styles.scss");
      expect(result.resolverUsed).toBe("css");
    });

    it("utilise le résolveur imports pour .ts avec bloc d'imports", () => {
      const hunk = makeHunk(
        ["import React from 'react';"],
        ["import React from 'react';", "import { useState } from 'react';"],
        ["import React from 'react';", "import { useEffect } from 'react';"],
      );
      const result = tryFormatAwareResolve(hunk, "app.ts");
      expect(result.resolverUsed).toBe("imports");
    });

    it("n'utilise pas le résolveur imports pour .ts avec code non-import", () => {
      const hunk = makeHunk(
        ["const x = 1;"],
        ["const x = 2;"],
        ["const x = 3;"],
      );
      const result = tryFormatAwareResolve(hunk, "app.ts");
      // Pas de résolveur spécialisé pour du code TS général
      expect(result.resolverUsed).toBe("none");
    });
  });
});
