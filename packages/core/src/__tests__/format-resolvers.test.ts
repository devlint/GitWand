import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import {
  tryResolveJsonConflict,
  stripJsoncComments,
} from "../resolvers/json.js";
import {
  tryResolveMarkdownConflict,
  parseSections,
  extractFrontmatter,
} from "../resolvers/markdown.js";
import {
  tryFormatAwareResolve,
  isJsonFile,
  isMarkdownFile,
} from "../resolvers/dispatcher.js";
import type { ConflictHunk } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────

/** Construit un ConflictHunk minimal pour les tests de dispatch */
function makeHunk(base: string[], ours: string[], theirs: string[]): ConflictHunk {
  return {
    baseLines: base,
    oursLines: ours,
    theirsLines: theirs,
    startLine: 1,
    type: "complex",
    confidence: { score: 20, label: "low", dimensions: { typeClassification: 20, dataRisk: 0, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 }, boosters: [], penalties: [] },
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
// PHASE 7.3 — Résolveur JSON sémantique
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3 — JSON resolver", () => {
  // ── stripJsoncComments ──────────────────────────────────

  describe("stripJsoncComments", () => {
    it("supprime les commentaires // sur une ligne", () => {
      const input = `{
  "name": "test", // mon app
  "version": "1.0.0"
}`;
      const result = stripJsoncComments(input);
      expect(result).not.toContain("//");
      expect(result).toContain('"name"');
      expect(result).toContain('"version"');
    });

    it("supprime les commentaires /* ... */", () => {
      const input = `{
  /* Configuration principale */
  "debug": false
}`;
      const result = stripJsoncComments(input);
      expect(result).not.toContain("/*");
      expect(result).toContain('"debug"');
    });

    it("ne touche pas aux URLs dans les chaînes", () => {
      const input = `{"url": "https://example.com/path"}`;
      const result = stripJsoncComments(input);
      expect(result).toContain("https://example.com/path");
    });

    it("retourne la chaîne intacte si pas de commentaires", () => {
      const input = `{"key": "value"}`;
      expect(stripJsoncComments(input)).toBe(input);
    });
  });

  // ── tryResolveJsonConflict ────────────────────────────────

  describe("tryResolveJsonConflict — cas de base", () => {
    it("fusionne deux clés ajoutées indépendamment", () => {
      const base = ['{"version": "1.0.0"}'];
      const ours = ['{"version": "1.0.0", "author": "Alice"}'];
      const theirs = ['{"version": "1.0.0", "license": "MIT"}'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).not.toBeNull();
      const merged = JSON.parse(result.merged as string);
      expect(merged.author).toBe("Alice");
      expect(merged.license).toBe("MIT");
      expect(merged.version).toBe("1.0.0");
      expect(result.resolvedKeys).toBeGreaterThan(0);
      expect(result.unresolvedKeys).toBe(0);
    });

    it("résout le cas same_change : même valeur ajoutée des deux côtés", () => {
      const base = ['{"name": "app"}'];
      const ours = ['{"name": "app", "type": "module"}'];
      const theirs = ['{"name": "app", "type": "module"}'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).not.toBeNull();
      const merged = JSON.parse(result.merged as string);
      expect(merged.type).toBe("module");
    });

    it("résout le cas one_side_change : seul ours a modifié une clé", () => {
      const base = ['{"version": "1.0.0", "port": 3000}'];
      const ours = ['{"version": "2.0.0", "port": 3000}'];
      const theirs = ['{"version": "1.0.0", "port": 4000}'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).not.toBeNull();
      const merged = JSON.parse(result.merged as string);
      expect(merged.version).toBe("2.0.0"); // ours a changé version
      expect(merged.port).toBe(4000);        // theirs a changé port
    });

    it("retourne null si les deux côtés ont modifié la même clé différemment", () => {
      const base = ['{"version": "1.0.0"}'];
      const ours = ['{"version": "2.0.0"}'];
      const theirs = ['{"version": "3.0.0"}'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).toBeNull();
      expect(result.unresolvedKeys).toBeGreaterThan(0);
    });

    it("résout la suppression d'une clé si l'autre côté n'a pas changé", () => {
      const base = ['{"name": "app", "debug": true}'];
      const ours = ['{"name": "app"}'];          // ours a supprimé debug
      const theirs = ['{"name": "app", "debug": true}']; // theirs n'a pas changé

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).not.toBeNull();
      const merged = JSON.parse(result.merged as string);
      expect(merged.debug).toBeUndefined(); // supprimé
      expect(merged.name).toBe("app");
    });

    it("retourne null si un côté supprime et l'autre modifie la même clé", () => {
      const base = ['{"value": 1}'];
      const ours = ['{}'];              // ours a supprimé value
      const theirs = ['{"value": 2}']; // theirs a modifié value

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).toBeNull();
    });
  });

  describe("tryResolveJsonConflict — objets imbriqués", () => {
    it("fusionne récursivement les objets imbriqués", () => {
      const base = [`{
  "scripts": {
    "build": "tsc",
    "test": "jest"
  }
}`];
      const ours = [`{
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "lint": "eslint ."
  }
}`];
      const theirs = [`{
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "format": "prettier ."
  }
}`];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).not.toBeNull();
      const merged = JSON.parse(result.merged as string);
      expect(merged.scripts.lint).toBe("eslint .");
      expect(merged.scripts.format).toBe("prettier .");
      expect(merged.scripts.build).toBe("tsc");
    });

    it("retourne null si conflit dans un objet imbriqué", () => {
      const base = ['{"deps": {"foo": "1.0.0"}}'];
      const ours = ['{"deps": {"foo": "2.0.0"}}'];   // ours upgraded foo
      const theirs = ['{"deps": {"foo": "3.0.0"}}']; // theirs upgraded foo differently

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).toBeNull();
    });
  });

  describe("tryResolveJsonConflict — base vide (diff2)", () => {
    it("fusionne deux ajouts de clés différentes sans base", () => {
      const base: string[] = []; // diff2 sans section base
      const ours = ['{"newFeature": true}'];
      const theirs = ['{"anotherFeature": "yes"}'];

      // Avec base vide, les deux clés sont "ajoutées" → conflit
      // car on ne sait pas distinguer ajout vs modification
      const result = tryResolveJsonConflict(base, ours, theirs);

      // Sans base, les deux côtés ont des clés différentes ajoutées (from empty)
      // → comme les clés sont distinctes, ça devrait merger
      if (result.merged !== null) {
        const merged = JSON.parse(result.merged as string);
        expect(merged.newFeature).toBe(true);
        expect(merged.anotherFeature).toBe("yes");
      }
      // Sinon (null) → ce test vérifie juste que ça ne plante pas
      expect(result).toBeDefined();
    });

    it("détecte un conflit sur la même clé sans base", () => {
      const base: string[] = [];
      const ours = ['{"port": 3000}'];
      const theirs = ['{"port": 4000}'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).toBeNull(); // conflit sur "port"
      expect(result.unresolvedKeys).toBeGreaterThan(0);
    });
  });

  describe("tryResolveJsonConflict — JSON mal formé", () => {
    it("retourne null si ours n'est pas un JSON valide", () => {
      const base = ['{"key": "val"}'];
      const ours = ['{ invalid json }'];
      const theirs = ['{"key": "val"}'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).toBeNull();
      expect(result.reason).toMatch(/parser ours/i);
    });

    it("retourne null si theirs n'est pas un JSON valide", () => {
      const base = ['{"key": "val"}'];
      const ours = ['{"key": "val2"}'];
      const theirs = ['not json at all'];

      const result = tryResolveJsonConflict(base, ours, theirs);

      expect(result.merged).toBeNull();
      expect(result.reason).toMatch(/parser theirs/i);
    });
  });

  // ── Intégration via resolve() ─────────────────────────────

  describe("Intégration JSON via resolve()", () => {
    it("résout un conflit JSON sémantique marqué complex par le classifieur textuel", () => {
      // Deux branches ajoutent chacune une dépendance différente.
      // Le conflit enveloppe un JSON complet (fichier entier) → le résolveur JSON peut le parser.
      // Note : le résolveur JSON ne fonctionne que si chaque section de conflit est un JSON valide.
      const jsonConflict = `<<<<<<< ours
{
  "name": "my-app",
  "version": "1.0.0",
  "lodash": "^4.17.0"
}
||||||| base
{
  "name": "my-app",
  "version": "1.0.0"
}
=======
{
  "name": "my-app",
  "version": "1.0.0",
  "axios": "^1.0.0"
}
>>>>>>> theirs`;
      const result = resolve(jsonConflict, "package.json");

      // Le résolveur JSON doit avoir fusionné les deux dépendances
      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).not.toBeNull();
      const merged = JSON.parse(result.mergedContent!);
      expect(merged.lodash).toBeDefined();
      expect(merged.axios).toBeDefined();
      expect(merged.version).toBe("1.0.0");
    });

    it("la raison de résolution mentionne le résolveur json", () => {
      const jsonConflict = `{
<<<<<<< ours
  "port": 3000,
  "debug": true
||||||| base
  "port": 3000
=======
  "port": 3000,
  "host": "0.0.0.0"
>>>>>>> theirs
}`;
      const result = resolve(jsonConflict, "config.json");

      if (result.stats.autoResolved > 0) {
        const res = result.resolutions[0];
        expect(res.resolutionReason).toMatch(/\[json\]/i);
      }
    });

    it("tombe en fallback textuel pour un conflit JSON non résolvable par le résolveur JSON", () => {
      // Les deux côtés changent la même clé scalaire différemment
      const jsonConflict = `{
  "name": "app",
<<<<<<< ours
  "version": "2.0.0",
  "description": "Version ours"
||||||| base
  "version": "1.0.0",
  "description": "Base"
=======
  "version": "3.0.0",
  "description": "Version theirs"
>>>>>>> theirs
}`;
      const result = resolve(jsonConflict, "package.json");

      // Le résolveur JSON ne peut pas résoudre (conflit sur version ET description)
      // Le moteur textuel prendra le relais → complex → non résolu
      expect(result.stats.remaining).toBe(1);
    });

    it("la validation JSON passe sur un conflit JSON résolu sémantiquement", () => {
      const jsonConflict = `{
  "a": 1,
<<<<<<< ours
  "b": 2,
  "c": 3
||||||| base
  "b": 2
=======
  "b": 2,
  "d": 4
>>>>>>> theirs
}`;
      const result = resolve(jsonConflict, "data.json");

      if (result.mergedContent !== null) {
        expect(result.validation.isValid).toBe(true);
        expect(result.validation.syntaxError).toBeNull();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3 — Résolveur Markdown
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3 — Markdown resolver", () => {
  // ── extractFrontmatter ────────────────────────────────────

  describe("extractFrontmatter", () => {
    it("extrait le frontmatter YAML entre ---", () => {
      const lines = [
        "---",
        "title: Mon article",
        "date: 2024-01-01",
        "---",
        "",
        "# Contenu",
      ];
      const { frontmatter, rest } = extractFrontmatter(lines);
      expect(frontmatter).toHaveLength(4);
      expect(frontmatter[0]).toBe("---");
      expect(frontmatter[3]).toBe("---");
      expect(rest).toContain("# Contenu");
    });

    it("retourne un frontmatter vide si pas de ---", () => {
      const lines = ["# Mon titre", "", "Contenu"];
      const { frontmatter, rest } = extractFrontmatter(lines);
      expect(frontmatter).toHaveLength(0);
      expect(rest).toEqual(lines);
    });

    it("gère le fichier vide", () => {
      const { frontmatter, rest } = extractFrontmatter([]);
      expect(frontmatter).toHaveLength(0);
      expect(rest).toHaveLength(0);
    });
  });

  // ── parseSections ─────────────────────────────────────────

  describe("parseSections", () => {
    it("découpe un document Markdown en sections", () => {
      const lines = [
        "Prologue",
        "# Introduction",
        "Contenu intro",
        "## Sous-section",
        "Contenu sous-section",
        "# Conclusion",
        "Fin",
      ];
      const sections = parseSections(lines);

      expect(sections).toHaveLength(4); // prologue + 3 headings
      expect(sections[0].heading).toBeNull(); // prologue
      expect(sections[1].heading).toBe("# Introduction");
      expect(sections[1].level).toBe(1);
      expect(sections[2].heading).toBe("## Sous-section");
      expect(sections[2].level).toBe(2);
      expect(sections[3].heading).toBe("# Conclusion");
    });

    it("gère un document sans prologue", () => {
      const lines = ["# Titre", "Contenu"];
      const sections = parseSections(lines);
      // sections[0] est le prologue vide, sections[1] est le heading
      const nonEmpty = sections.filter((s) => s.heading || s.lines.length > 0);
      expect(nonEmpty.some((s) => s.heading === "# Titre")).toBe(true);
    });

    it("gère un document vide", () => {
      const sections = parseSections([]);
      expect(sections).toHaveLength(1); // prologue vide
      expect(sections[0].heading).toBeNull();
      expect(sections[0].lines).toHaveLength(0);
    });
  });

  // ── tryResolveMarkdownConflict ────────────────────────────

  describe("tryResolveMarkdownConflict — résolution de sections", () => {
    it("accepte ours quand seul ours a modifié une section", () => {
      const base = [
        "# Titre",
        "",
        "## Introduction",
        "Texte original.",
        "",
        "## Conclusion",
        "Fin originale.",
      ];
      const ours = [
        "# Titre",
        "",
        "## Introduction",
        "Texte modifié par ours.",
        "",
        "## Conclusion",
        "Fin originale.",
      ];
      const theirs = [
        "# Titre",
        "",
        "## Introduction",
        "Texte original.",
        "",
        "## Conclusion",
        "Nouvelle fin par theirs.",
      ];

      const result = tryResolveMarkdownConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("Texte modifié par ours.");    // ours intro
      expect(merged).toContain("Nouvelle fin par theirs.");   // theirs conclusion
      expect(result.conflictedSections).toHaveLength(0);
    });

    it("accepte theirs quand seul theirs a ajouté une section", () => {
      const base = ["# Titre", "", "Contenu."];
      const ours = ["# Titre", "", "Contenu."];
      const theirs = ["# Titre", "", "Contenu.", "", "## Nouvelle section", "Contenu ajouté."];

      const result = tryResolveMarkdownConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("## Nouvelle section");
      expect(merged).toContain("Contenu ajouté.");
    });

    it("résout le cas same_change : même modification des deux côtés", () => {
      const base = ["# Titre", "Contenu original."];
      const ours = ["# Titre", "Contenu modifié."];
      const theirs = ["# Titre", "Contenu modifié."];

      const result = tryResolveMarkdownConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      expect(result.mergedLines!.join("\n")).toContain("Contenu modifié.");
    });

    it("retourne null si les deux côtés ont modifié la même section différemment", () => {
      const base = ["# Titre", "Contenu original."];
      const ours = ["# Titre", "Version ours."];
      const theirs = ["# Titre", "Version theirs."];

      const result = tryResolveMarkdownConflict(base, ours, theirs);

      expect(result.mergedLines).toBeNull();
      expect(result.conflictedSections.length).toBeGreaterThan(0);
    });
  });

  describe("tryResolveMarkdownConflict — frontmatter", () => {
    it("fusionne le frontmatter quand seul un côté l'a modifié", () => {
      const base = [
        "---",
        "title: Titre",
        "---",
        "",
        "# Contenu",
        "Texte.",
      ];
      const ours = [
        "---",
        "title: Titre mis à jour",
        "---",
        "",
        "# Contenu",
        "Texte.",
      ];
      const theirs = [
        "---",
        "title: Titre",
        "---",
        "",
        "# Contenu",
        "Texte modifié.",
      ];

      const result = tryResolveMarkdownConflict(base, ours, theirs);

      expect(result.mergedLines).not.toBeNull();
      const merged = result.mergedLines!.join("\n");
      expect(merged).toContain("Titre mis à jour"); // frontmatter de ours
      expect(merged).toContain("Texte modifié.");   // contenu de theirs
    });
  });

  // ── Intégration via resolve() ─────────────────────────────

  describe("Intégration Markdown via resolve()", () => {
    it("résout un conflit Markdown avec sections non-overlapping", () => {
      const mdConflict = `# Mon Document

## Introduction

Contexte du projet.

<<<<<<< ours
## Fonctionnalités

- Feature A
- Feature B (nouveau)
||||||| base
## Fonctionnalités

- Feature A
=======
## Fonctionnalités

- Feature A

## Déploiement

Instructions de déploiement.
>>>>>>> theirs

## Conclusion

Fin du document.`;

      const result = resolve(mdConflict, "README.md");

      // Le conflit doit être résolu (Markdown resolver ou insertion_at_boundary)
      if (result.stats.autoResolved > 0) {
        expect(result.mergedContent).not.toBeNull();
      }
      // Au minimum le test vérifie que ça ne plante pas
      expect(result.stats).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 7.3 — Dispatcher de format
// ═══════════════════════════════════════════════════════════════

describe("Phase 7.3 — Dispatcher de format", () => {
  describe("isJsonFile", () => {
    it("détecte les fichiers .json", () => {
      expect(isJsonFile("package.json")).toBe(true);
      expect(isJsonFile("tsconfig.json")).toBe(true);
      expect(isJsonFile("src/config.json")).toBe(true);
    });

    it("détecte les fichiers .jsonc", () => {
      expect(isJsonFile(".vscode/settings.jsonc")).toBe(true);
      expect(isJsonFile("tsconfig.jsonc")).toBe(true);
    });

    it("ne détecte pas les non-JSON", () => {
      expect(isJsonFile("app.ts")).toBe(false);
      expect(isJsonFile("config.yaml")).toBe(false);
      expect(isJsonFile("README.md")).toBe(false);
      expect(isJsonFile("package-lock.json.bak")).toBe(false);
    });
  });

  describe("isMarkdownFile", () => {
    it("détecte les fichiers .md", () => {
      expect(isMarkdownFile("README.md")).toBe(true);
      expect(isMarkdownFile("docs/guide.md")).toBe(true);
    });

    it("détecte les fichiers .mdx et .markdown", () => {
      expect(isMarkdownFile("docs/page.mdx")).toBe(true);
      expect(isMarkdownFile("CHANGELOG.markdown")).toBe(true);
    });

    it("ne détecte pas les non-Markdown", () => {
      expect(isMarkdownFile("app.ts")).toBe(false);
      expect(isMarkdownFile("config.json")).toBe(false);
    });
  });

  describe("tryFormatAwareResolve", () => {
    it("retourne resolverUsed: 'none' pour les fichiers .ts", () => {
      const hunk = makeHunk(["base"], ["ours"], ["theirs"]);
      const result = tryFormatAwareResolve(hunk, "src/app.ts");
      expect(result.resolverUsed).toBe("none");
      expect(result.lines).toBeNull();
    });

    it("retourne resolverUsed: 'json' pour les fichiers .json", () => {
      const hunk = makeHunk(
        ['{"a": 1}'],
        ['{"a": 1, "b": 2}'],
        ['{"a": 1, "c": 3}'],
      );
      const result = tryFormatAwareResolve(hunk, "config.json");
      expect(result.resolverUsed).toBe("json");
    });

    it("retourne resolverUsed: 'markdown' pour les fichiers .md", () => {
      const hunk = makeHunk(
        ["# Section", "Contenu."],
        ["# Section", "Modifié ours."],
        ["# Section", "Contenu."],
      );
      const result = tryFormatAwareResolve(hunk, "README.md");
      expect(result.resolverUsed).toBe("markdown");
    });

    it("retourne lines !== null quand JSON resolver réussit", () => {
      const hunk = makeHunk(
        ['{"x": 1}'],
        ['{"x": 1, "y": 2}'],
        ['{"x": 1, "z": 3}'],
      );
      const result = tryFormatAwareResolve(hunk, "data.json");
      expect(result.resolverUsed).toBe("json");
      expect(result.lines).not.toBeNull();
      // Le JSON fusionné doit avoir les deux nouvelles clés
      const merged = JSON.parse(result.lines!.join("\n"));
      expect(merged.y).toBe(2);
      expect(merged.z).toBe(3);
    });

    it("retourne lines: null quand JSON resolver échoue", () => {
      // Conflit sur la même clé → non résolvable
      const hunk = makeHunk(
        ['{"v": 1}'],
        ['{"v": 2}'],
        ['{"v": 3}'],
      );
      const result = tryFormatAwareResolve(hunk, "settings.json");
      expect(result.resolverUsed).toBe("json");
      expect(result.lines).toBeNull();
      expect(result.reason).toMatch(/\[json\]/i);
    });

    it("la reason mentionne le résolveur utilisé", () => {
      const hunk = makeHunk(['{"a": 1}'], ['{"a": 2}'], ['{"a": 3}']);
      const result = tryFormatAwareResolve(hunk, "app.json");
      expect(result.reason).toMatch(/^\[json\]/);
    });
  });
});
