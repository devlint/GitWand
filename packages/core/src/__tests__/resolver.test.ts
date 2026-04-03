import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import { mergeNonOverlapping, lcs, computeDiff } from "../diff.js";

/**
 * Fixtures de fichiers avec conflits Git.
 * Chaque fixture simule un cas réel.
 */

const CONFLICT_SAME_CHANGE = `import { useState } from "react";
<<<<<<< ours
import { useEffect } from "react";
||||||| base
=======
import { useEffect } from "react";
>>>>>>> theirs
export default function App() {}`;

const CONFLICT_ONE_SIDE = `const config = {
<<<<<<< ours
  port: 3000,
  host: "localhost",
||||||| base
  port: 3000,
=======
  port: 3000,
>>>>>>> theirs
};`;

const CONFLICT_DELETE_NO_CHANGE = `function main() {
<<<<<<< ours
||||||| base
  console.log("debug");
=======
  console.log("debug");
>>>>>>> theirs
  return true;
}`;

const CONFLICT_WHITESPACE = `<<<<<<< ours
function hello() {
    return "world";
}
=======
function hello() {
  return "world";
}
>>>>>>> theirs`;

// --- Non-overlapping: imports ajoutés à des endroits différents ---
const CONFLICT_NON_OVERLAPPING_IMPORTS = `<<<<<<< ours
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

// --- Non-overlapping: modifications à des endroits différents du même bloc ---
const CONFLICT_NON_OVERLAPPING_CODE = `<<<<<<< ours
const API_URL = "https://api.example.com";
const TIMEOUT = 5000;
const RETRIES = 3;
const DEBUG = false;
||||||| base
const API_URL = "https://api.example.com";
const TIMEOUT = 5000;
const RETRIES = 3;
=======
const API_URL = "https://api.production.com";
const TIMEOUT = 5000;
const RETRIES = 3;
>>>>>>> theirs`;

// --- Non-overlapping impossible: modifications au même endroit ---
const CONFLICT_OVERLAPPING = `<<<<<<< ours
const API_URL = "https://staging.example.com";
const TIMEOUT = 10000;
||||||| base
const API_URL = "https://api.example.com";
const TIMEOUT = 5000;
=======
const API_URL = "https://production.example.com";
const TIMEOUT = 3000;
>>>>>>> theirs`;

const CONFLICT_COMPLEX = `<<<<<<< ours
function calculate(a: number, b: number) {
  return a + b;
}
=======
function calculate(x: number, y: number): number {
  return x * y;
}
>>>>>>> theirs`;

const MULTIPLE_CONFLICTS = `import React from "react";
<<<<<<< ours
import { useState } from "react";
||||||| base
=======
import { useState } from "react";
>>>>>>> theirs

const App = () => {
<<<<<<< ours
  const title = "Hello GitWand";
||||||| base
  const title = "Hello World";
=======
  const title = "Hello World";
>>>>>>> theirs
  return <h1>{title}</h1>;
};`;

describe("@gitwand/core resolve", () => {
  describe("same_change", () => {
    it("résout quand les deux branches ont la même modification", () => {
      const result = resolve(CONFLICT_SAME_CHANGE, "app.tsx");

      expect(result.stats.totalConflicts).toBe(1);
      expect(result.stats.autoResolved).toBe(1);
      expect(result.stats.remaining).toBe(0);
      expect(result.mergedContent).toContain('import { useEffect } from "react"');
      expect(result.mergedContent).not.toContain("<<<<<<<");
      expect(result.hunks[0].type).toBe("same_change");
      expect(result.hunks[0].confidence).toBe("certain");
    });
  });

  describe("one_side_change", () => {
    it("résout en prenant le côté qui a changé (ours)", () => {
      const result = resolve(CONFLICT_ONE_SIDE, "config.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).toContain('host: "localhost"');
      expect(result.hunks[0].type).toBe("one_side_change");
    });
  });

  describe("delete_no_change", () => {
    it("résout en acceptant la suppression", () => {
      const result = resolve(CONFLICT_DELETE_NO_CHANGE, "main.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.mergedContent).not.toContain("console.log");
      expect(result.hunks[0].type).toBe("delete_no_change");
    });
  });

  describe("whitespace_only", () => {
    it("résout les conflits de whitespace", () => {
      const result = resolve(CONFLICT_WHITESPACE, "hello.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("whitespace_only");
    });

    it("ne résout pas le whitespace si l'option est désactivée", () => {
      const result = resolve(CONFLICT_WHITESPACE, "hello.ts", {
        resolveWhitespace: false,
      });

      expect(result.stats.autoResolved).toBe(0);
      expect(result.stats.remaining).toBe(1);
    });
  });

  describe("non_overlapping", () => {
    it("fusionne des imports ajoutés à des endroits différents", () => {
      const result = resolve(CONFLICT_NON_OVERLAPPING_IMPORTS, "imports.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("non_overlapping");
      expect(result.hunks[0].confidence).toBe("high");
      // Le résultat doit contenir les deux imports ajoutés
      expect(result.mergedContent).toContain("useEffect");
      expect(result.mergedContent).toContain("dayjs");
      // Et garder les existants
      expect(result.mergedContent).toContain("React");
      expect(result.mergedContent).toContain("useState");
      expect(result.mergedContent).toContain("axios");
    });

    it("fusionne des modifications de code à des endroits différents", () => {
      const result = resolve(CONFLICT_NON_OVERLAPPING_CODE, "config.ts");

      expect(result.stats.autoResolved).toBe(1);
      expect(result.hunks[0].type).toBe("non_overlapping");
      // Ours a ajouté DEBUG, theirs a changé API_URL
      expect(result.mergedContent).toContain("DEBUG");
      expect(result.mergedContent).toContain("production.com");
    });

    it("ne fusionne PAS quand les modifications se chevauchent", () => {
      const result = resolve(CONFLICT_OVERLAPPING, "config.ts");

      // Les deux branches modifient les mêmes lignes → doit être complex
      expect(result.hunks[0].type).toBe("complex");
      expect(result.stats.autoResolved).toBe(0);
    });

    it("ne résout pas si l'option est désactivée", () => {
      const result = resolve(CONFLICT_NON_OVERLAPPING_IMPORTS, "imports.ts", {
        resolveNonOverlapping: false,
      });

      expect(result.stats.autoResolved).toBe(0);
    });
  });

  describe("complex", () => {
    it("ne résout pas les conflits complexes", () => {
      const result = resolve(CONFLICT_COMPLEX, "calc.ts");

      expect(result.stats.autoResolved).toBe(0);
      expect(result.stats.remaining).toBe(1);
      expect(result.mergedContent).toBeNull();
      expect(result.hunks[0].type).toBe("complex");
    });
  });

  describe("fichiers avec plusieurs conflits", () => {
    it("résout les conflits triviaux et laisse les autres", () => {
      const result = resolve(MULTIPLE_CONFLICTS, "app.tsx");

      expect(result.stats.totalConflicts).toBe(2);
      // Premier conflit : same_change → résolu
      expect(result.resolutions[0].autoResolved).toBe(true);
      // Deuxième conflit : one_side_change (ours a changé) → résolu
      expect(result.resolutions[1].autoResolved).toBe(true);
      expect(result.stats.autoResolved).toBe(2);
    });
  });

  describe("fichier sans conflit", () => {
    it("retourne le contenu tel quel", () => {
      const clean = 'const x = 42;\nconsole.log(x);\n';
      const result = resolve(clean, "clean.ts");

      expect(result.stats.totalConflicts).toBe(0);
      expect(result.mergedContent).toBe(clean);
    });
  });

  describe("diff utilities", () => {
    it("lcs trouve la plus longue sous-séquence commune", () => {
      const a = ["a", "b", "c", "d"];
      const b = ["a", "x", "c", "d"];
      const result = lcs(a, b);
      // a, c, d sont communs
      expect(result).toEqual([[0, 0], [2, 2], [3, 3]]);
    });

    it("computeDiff identifie les ajouts et suppressions", () => {
      const base = ["a", "b", "c"];
      const branch = ["a", "x", "b", "c"];
      const diff = computeDiff(base, branch);

      const adds = diff.filter((d) => d.type === "add");
      expect(adds.length).toBe(1);
      expect(adds[0].line).toBe("x");
    });

    it("mergeNonOverlapping fusionne des ajouts à des endroits différents", () => {
      const base = ["a", "b", "c"];
      const ours = ["a", "x", "b", "c"];     // ajout de "x" entre a et b
      const theirs = ["a", "b", "c", "y"];   // ajout de "y" après c

      const result = mergeNonOverlapping(base, ours, theirs);

      expect(result).not.toBeNull();
      expect(result).toEqual(["a", "x", "b", "c", "y"]);
    });

    it("mergeNonOverlapping retourne null si les edits se chevauchent", () => {
      const base = ["a", "b", "c"];
      const ours = ["a", "X", "c"];    // b → X
      const theirs = ["a", "Y", "c"];  // b → Y

      const result = mergeNonOverlapping(base, ours, theirs);
      expect(result).toBeNull();
    });
  });

  describe("stats et reporting", () => {
    it("fournit des explications lisibles pour chaque hunk", () => {
      const result = resolve(CONFLICT_ONE_SIDE, "config.ts");

      expect(result.hunks[0].explanation).toBeTruthy();
      expect(typeof result.hunks[0].explanation).toBe("string");
      expect(result.hunks[0].explanation.length).toBeGreaterThan(10);
    });

    it("fournit les stats par type", () => {
      const result = resolve(MULTIPLE_CONFLICTS, "app.tsx");

      expect(result.stats.byType).toBeDefined();
      expect(typeof result.stats.byType).toBe("object");
    });
  });
});
