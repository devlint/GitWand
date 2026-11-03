/**
 * Tests du resolver imports ES/TS (GitWand)
 *
 * Fixtures :
 *   F1 — import ajouté d'un seul côté
 *   F2 — même module importé différemment des deux côtés → conflit non résolvable
 *   F3 — imports vides (bloc vide)
 *   F4 — TypeScript avec `import type`
 *   F5 — re-exports `export { X } from 'y'`
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F1 — import ajouté d'un seul côté ───────────────────────────────────────

describe("F1 — imports : import ajouté d'un seul côté (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `import { ref } from 'vue';`,
    `import { computed } from 'vue';`,
    `import { useRouter } from 'vue-router';`,
    `||||||| base`,
    `import { ref } from 'vue';`,
    `import { computed } from 'vue';`,
    `=======`,
    `import { ref } from 'vue';`,
    `import { computed } from 'vue';`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver imports", () => {
    const result = resolve(input, "composable.ts");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("les deux imports sont présents dans le merge", () => {
    const result = resolve(input, "composable.ts");
    expect(result.mergedContent).toContain("useRouter");
    expect(result.mergedContent).toContain("computed");
    expect(result.mergedContent).toContain("ref");
  });

  it("la raison mentionne [imports]", () => {
    const result = resolve(input, "composable.ts");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[imports\]/i);
  });
});

// ─── F2 — même module importé différemment des deux côtés ────────────────────

describe("F2 — imports : même module importé différemment des deux côtés (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `import { ref, computed, watch } from 'vue';`,
    `||||||| base`,
    `import { ref } from 'vue';`,
    `=======`,
    `import { ref, reactive, toRefs } from 'vue';`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "store.ts")).not.toThrow();
  });

  it("la raison mentionne [imports]", () => {
    const result = resolve(input, "store.ts");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[imports\]/i);
  });
});

// ─── F3 — imports vides ───────────────────────────────────────────────────────

describe("F3 — imports vides : ne plante pas", () => {
  const input = [
    `<<<<<<< ours`,
    `import {} from 'vue';`,
    `=======`,
    `import {} from 'vue';`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "empty.ts")).not.toThrow();
  });

  it("produit un résultat avec au moins un hunk", () => {
    const result = resolve(input, "empty.ts");
    expect(result.hunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── F4 — TypeScript avec import type ────────────────────────────────────────

describe("F4 — imports : TypeScript avec `import type` (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `import type { Ref } from 'vue';`,
    `import type { Router } from 'vue-router';`,
    `import type { GitWandOptions } from '@gitwand/core';`,
    `||||||| base`,
    `import type { Ref } from 'vue';`,
    `import type { Router } from 'vue-router';`,
    `=======`,
    `import type { Ref } from 'vue';`,
    `import type { Router } from 'vue-router';`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver imports", () => {
    const result = resolve(input, "types.ts");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient l'import type ajouté", () => {
    const result = resolve(input, "types.ts");
    expect(result.mergedContent).toContain("GitWandOptions");
    expect(result.mergedContent).toContain("import type");
  });

  it("la raison mentionne [imports]", () => {
    const result = resolve(input, "types.ts");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[imports\]/i);
  });
});

// ─── F5 — re-exports ──────────────────────────────────────────────────────────

// F5 — imports de deux modules différents ajoutés des deux côtés (diff2)
// En diff2, insertion_at_boundary n'a pas accès à la base → le resolver imports
// est sollicité pour la fusion sémantique.
describe("F5 — imports : deux modules différents ajoutés (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `import { useRouter } from 'vue-router';`,
    `import { ref } from 'vue';`,
    `import { useI18n } from './composables/useI18n';`,
    `=======`,
    `import { useRouter } from 'vue-router';`,
    `import { ref } from 'vue';`,
    `import { useTheme } from './composables/useTheme';`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout", () => {
    const result = resolve(input, "src/App.ts");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les imports des deux côtés", () => {
    const result = resolve(input, "src/App.ts");
    expect(result.mergedContent).toContain("useI18n");
    expect(result.mergedContent).toContain("useTheme");
    expect(result.mergedContent).toContain("useRouter");
  });
});

// ─── Même module, formes incompatibles : jamais de repli textuel ─────────────
// Régression : le résolveur imports refusait (null), le moteur textuel prenait
// le relais et classait le hunk insertion_at_boundary — les deux lignes étaient
// gardées et `useAuth` se retrouvait déclaré deux fois.

describe("imports — même module sous deux formes (named vs default)", () => {
  const input = [
    `<<<<<<< ours`,
    `import React from "react";`,
    `import { useAuth } from "./auth";`,
    `||||||| base`,
    `import React from "react";`,
    `=======`,
    `import React from "react";`,
    `import useAuth from "./auth";`,
    `>>>>>>> theirs`,
    `export const x = 1;`,
  ].join("\n");

  it("n'est pas auto-résolu", () => {
    const result = resolve(input, "app.ts");
    expect(result.stats.autoResolved).toBe(0);
  });

  it("est classé complex", () => {
    const result = resolve(input, "app.ts");
    expect(result.hunks[0].type).toBe("complex");
  });

  it("la raison cite le conflit d'import", () => {
    const result = resolve(input, "app.ts");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[imports\].*'\.\/auth'/);
  });

  it("même chose dans l'autre sens (default côté ours)", () => {
    const swapped = input
      .replace(`import { useAuth } from "./auth";`, "__TMP__")
      .replace(`import useAuth from "./auth";`, `import { useAuth } from "./auth";`)
      .replace("__TMP__", `import useAuth from "./auth";`);
    const result = resolve(swapped, "app.ts");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.hunks[0].type).toBe("complex");
  });

  it("un bloc non-import laisse toujours la main au moteur textuel", () => {
    const mixed = [
      `<<<<<<< ours`,
      `import React from "react";`,
      `const a = 1;`,
      `||||||| base`,
      `import React from "react";`,
      `=======`,
      `import React from "react";`,
      `const b = 2;`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(mixed, "app.ts");
    expect(result.hunks[0].type).toBe("insertion_at_boundary");
  });
});

// ─── Changement de forme d'un seul côté : pas un conflit ─────────────────────
// Régression : un côté passe `{ x }` → `x` et l'autre garde l'import de base.
// Le contrôle « même module, autre forme » se déclenchait quand même, et depuis
// que ce conflit n'est plus repassé au moteur textuel, le hunk devenait complex.

describe("imports — forme changée d'un seul côté", () => {
  it("theirs change la forme, ours modifie un autre import : résolu", () => {
    const input = [
      `<<<<<<< ours`, `import A2 from "a";`, `import { x } from "b";`,
      `||||||| base`, `import A from "a";`, `import { x } from "b";`,
      `=======`, `import A from "a";`, `import x from "b";`,
      `>>>>>>> theirs`, `export const y = 1;`,
    ].join("\n");
    const result = resolve(input, "app.ts");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain(`import A2 from "a";`);
    expect(result.mergedContent).toContain(`import x from "b";`);
    expect(result.mergedContent).not.toContain(`import { x } from "b";`);
  });

  it("ours change la forme, theirs ajoute un import : résolu", () => {
    const input = [
      `<<<<<<< ours`, `import x from "b";`,
      `||||||| base`, `import { x } from "b";`,
      `=======`, `import { x } from "b";`, `import C from "c";`,
      `>>>>>>> theirs`, `export const y = 1;`,
    ].join("\n");
    const result = resolve(input, "app.ts");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain(`import x from "b";`);
    expect(result.mergedContent).toContain(`import C from "c";`);
    expect(result.mergedContent).not.toContain(`import { x } from "b";`);
  });

  it("les deux côtés changent la forme différemment : toujours complex", () => {
    const input = [
      `<<<<<<< ours`, `import * as x from "b";`,
      `||||||| base`, `import { x } from "b";`,
      `=======`, `import x from "b";`,
      `>>>>>>> theirs`, `export const y = 1;`,
    ].join("\n");
    const result = resolve(input, "app.ts");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.hunks[0].type).toBe("complex");
  });
});

// ─── Formes différentes sans nom commun : pas un conflit ─────────────────────
// `import React from "react"` et `import { useState } from "react"` coexistent.
// Seule une collision de nom local (ou une liaison illisible, `require`) est un
// vrai conflit ; sinon le moteur textuel garde les deux lignes, comme sur main.

describe("imports — même module, formes différentes, noms distincts", () => {
  const hunk = (ours: string[], base: string[], theirs: string[]) => [
    `<<<<<<< ours`, ...ours, `||||||| base`, ...base, `=======`, ...theirs, `>>>>>>> theirs`, `export const z = 1;`,
  ].join("\n");

  it("default d'un côté, named de l'autre : les deux gardés", () => {
    const result = resolve(hunk(
      [`import a from "a";`, `import React from "react";`],
      [`import a from "a";`],
      [`import a from "a";`, `import { useState } from "react";`],
    ), "app.ts");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain(`import React from "react";`);
    expect(result.mergedContent).toContain(`import { useState } from "react";`);
  });

  it("named modifié d'un côté, default ajouté de l'autre : les deux gardés", () => {
    const result = resolve(hunk(
      [`import { a, b } from "m";`],
      [`import { a } from "m";`],
      [`import { a } from "m";`, `import M from "m";`],
    ), "app.ts");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain(`import { a, b } from "m";`);
    expect(result.mergedContent).toContain(`import M from "m";`);
  });

  it("alias en collision (`{ x as useAuth }` vs `useAuth`) : complex", () => {
    const result = resolve(hunk(
      [`import { x as useAuth } from "./auth";`], [], [`import useAuth from "./auth";`],
    ), "app.ts");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.hunks[0].type).toBe("complex");
  });

  it("require contre import du même module : complex (liaison du require non lue)", () => {
    const result = resolve(hunk(
      [`const useAuth = require("./auth");`], [], [`import useAuth from "./auth";`],
    ), "app.ts");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.hunks[0].type).toBe("complex");
  });

  it("même import de base modifié des deux côtés : le moteur textuel garde la main", () => {
    const result = resolve(hunk(
      [`import B from "./a";`], [`import A from "./a";`], [`import A from "./a.js";`],
    ), "app.ts");
    expect(result.hunks[0].type).not.toBe("complex");
    expect(result.mergedContent ?? "").not.toMatch(/import B from "\.\/a";\nimport A/);
  });
});
