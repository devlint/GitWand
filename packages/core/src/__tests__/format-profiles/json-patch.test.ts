/**
 * Tests de l'implémentation RFC 6902 maison (v2.2).
 *
 * Couvre :
 *  - parseJsonPointer / buildJsonPointer (escapes ~0, ~1)
 *  - applyJsonPatch sur add / remove / replace
 *  - diffJson (objets, scalaires, type changes)
 *  - mergeJsonPatches (paths disjoints vs en conflit)
 *  - test de propriété : applyJsonPatch(base, diffJson(base, x)) ≡ x
 */

import { describe, it, expect } from "vitest";
import {
  parseJsonPointer,
  buildJsonPointer,
  applyJsonPatch,
  diffJson,
  mergeJsonPatches,
  jsonStructEqual,
} from "../../format-profiles/json-patch.js";

// ─── JSON Pointer (RFC 6901) ────────────────────────────────

describe("parseJsonPointer / buildJsonPointer", () => {
  it("racine vide", () => {
    expect(parseJsonPointer("")).toEqual([]);
    expect(buildJsonPointer([])).toBe("");
  });

  it("path simple", () => {
    expect(parseJsonPointer("/foo/bar")).toEqual(["foo", "bar"]);
    expect(buildJsonPointer(["foo", "bar"])).toBe("/foo/bar");
  });

  it("escapes ~0 (~) et ~1 (/)", () => {
    expect(parseJsonPointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(buildJsonPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
  });

  it("token vide légal (clé '')", () => {
    expect(parseJsonPointer("//x")).toEqual(["", "x"]);
  });

  it("path invalide → throw", () => {
    expect(() => parseJsonPointer("foo/bar")).toThrow();
  });
});

// ─── applyJsonPatch ─────────────────────────────────────────

describe("applyJsonPatch — opérations de base", () => {
  it("add à la racine — replace tout le doc", () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "", value: { b: 2 } }])).toEqual({ b: 2 });
  });

  it("add une nouvelle clé d'objet", () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "/b", value: 2 }])).toEqual({ a: 1, b: 2 });
  });

  it("replace une clé existante", () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/a", value: 99 }])).toEqual({ a: 99 });
  });

  it("remove une clé existante", () => {
    expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: "remove", path: "/a" }])).toEqual({ b: 2 });
  });

  it("add dans un tableau (index)", () => {
    expect(applyJsonPatch([1, 2, 3], [{ op: "add", path: "/1", value: 99 }])).toEqual([1, 99, 2, 3]);
  });

  it("add en fin de tableau via '-'", () => {
    expect(applyJsonPatch([1, 2], [{ op: "add", path: "/-", value: 3 }])).toEqual([1, 2, 3]);
  });

  it("remove dans un tableau (shift)", () => {
    expect(applyJsonPatch([1, 2, 3], [{ op: "remove", path: "/1" }])).toEqual([1, 3]);
  });

  it("path imbriqué", () => {
    const doc = { user: { name: "alice", age: 30 } };
    const out = applyJsonPatch(doc, [{ op: "replace", path: "/user/name", value: "bob" }]);
    expect(out).toEqual({ user: { name: "bob", age: 30 } });
    // Immutabilité : doc d'origine intact
    expect(doc.user.name).toBe("alice");
  });

  it("séquence de plusieurs ops", () => {
    const out = applyJsonPatch({ a: 1, b: 2 }, [
      { op: "add", path: "/c", value: 3 },
      { op: "remove", path: "/a" },
      { op: "replace", path: "/b", value: 20 },
    ]);
    expect(out).toEqual({ b: 20, c: 3 });
  });

  it("remove sur clé absente → throw", () => {
    expect(() =>
      applyJsonPatch({ a: 1 }, [{ op: "remove", path: "/missing" }]),
    ).toThrow();
  });

  it("replace sur path inexistant → throw", () => {
    expect(() =>
      applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/missing/sub", value: 0 }]),
    ).toThrow();
  });
});

// ─── diffJson ───────────────────────────────────────────────

describe("diffJson", () => {
  it("aucune différence → []", () => {
    expect(diffJson({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("ajout d'une clé", () => {
    expect(diffJson({ a: 1 }, { a: 1, b: 2 })).toEqual([
      { op: "add", path: "/b", value: 2 },
    ]);
  });

  it("suppression d'une clé", () => {
    expect(diffJson({ a: 1, b: 2 }, { a: 1 })).toEqual([
      { op: "remove", path: "/b" },
    ]);
  });

  it("changement scalaire → replace", () => {
    expect(diffJson({ a: 1 }, { a: 2 })).toEqual([
      { op: "replace", path: "/a", value: 2 },
    ]);
  });

  it("changement de type → replace", () => {
    expect(diffJson({ a: 1 }, { a: "one" })).toEqual([
      { op: "replace", path: "/a", value: "one" },
    ]);
  });

  it("récursion sur objet imbriqué", () => {
    const ops = diffJson({ user: { name: "a", age: 30 } }, { user: { name: "b", age: 30 } });
    expect(ops).toEqual([
      { op: "replace", path: "/user/name", value: "b" },
    ]);
  });

  it("tableau différent → replace global du tableau", () => {
    expect(diffJson({ deps: [1, 2] }, { deps: [1, 2, 3] })).toEqual([
      { op: "replace", path: "/deps", value: [1, 2, 3] },
    ]);
  });
});

// ─── mergeJsonPatches ───────────────────────────────────────

describe("mergeJsonPatches", () => {
  it("paths disjoints → concaténation", () => {
    const ours: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "add", path: "/x", value: 1 },
    ];
    const theirs: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "add", path: "/y", value: 2 },
    ];
    const r = mergeJsonPatches(ours, theirs);
    expect(r.merged).toEqual([...ours, ...theirs]);
    expect(r.conflictingPaths).toEqual([]);
  });

  it("path identique → conflit", () => {
    const ours: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "replace", path: "/v", value: 1 },
    ];
    const theirs: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "replace", path: "/v", value: 2 },
    ];
    const r = mergeJsonPatches(ours, theirs);
    expect(r.merged).toBeNull();
    expect(r.conflictingPaths).toEqual(["/v"]);
  });

  it("path préfixe → conflit", () => {
    // ours touche /user, theirs touche /user/name → ils se chevauchent.
    const ours: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "replace", path: "/user", value: { name: "x" } },
    ];
    const theirs: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "replace", path: "/user/name", value: "y" },
    ];
    const r = mergeJsonPatches(ours, theirs);
    expect(r.merged).toBeNull();
  });

  it("paths frères dans un même objet → disjoints", () => {
    // /a/b et /a/c sont disjoints (frères).
    const ours: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "add", path: "/a/b", value: 1 },
    ];
    const theirs: import("../../format-profiles/types.js").JsonPatchOp[] = [
      { op: "add", path: "/a/c", value: 2 },
    ];
    const r = mergeJsonPatches(ours, theirs);
    expect(r.merged).toHaveLength(2);
  });
});

// ─── Test de propriété : round-trip ─────────────────────────

/** PRNG déterministe (mulberry32) — évite la flakiness. */
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Génère un JSON pseudo-aléatoire avec profondeur bornée. */
function randomJson(rng: () => number, depth: number): unknown {
  if (depth <= 0) {
    const r = rng();
    if (r < 0.25) return null;
    if (r < 0.5) return Math.floor(rng() * 100);
    if (r < 0.75) return rng() < 0.5;
    return `s_${Math.floor(rng() * 1000)}`;
  }
  const r = rng();
  if (r < 0.4) {
    const n = Math.floor(rng() * 4);
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      obj[`k${i}`] = randomJson(rng, depth - 1);
    }
    return obj;
  }
  if (r < 0.6) {
    const n = Math.floor(rng() * 3);
    return Array.from({ length: n }, () => randomJson(rng, depth - 1));
  }
  return randomJson(rng, 0); // scalaire
}

describe("Round-trip — propriété diffJson + applyJsonPatch", () => {
  it("applyJsonPatch(base, diffJson(base, x)) ≡ x sur 100 entrées générées", () => {
    const rng = mulberry32(20260427);
    for (let run = 0; run < 100; run++) {
      const base = randomJson(rng, 3);
      const target = randomJson(rng, 3);
      const ops = diffJson(base, target);
      const reconstructed = applyJsonPatch(base, ops);
      // Égalité structurelle (pas de référence — `target` peut contenir des
      // sous-arbres équivalents par valeur mais pas identiques par référence).
      const ok = jsonStructEqual(reconstructed, target);
      if (!ok) {
        // Affiche l'input pour debug si l'assert casse.
        // eslint-disable-next-line no-console
        console.error(`FAIL run ${run}:`, { base, target, ops, reconstructed });
      }
      expect(ok).toBe(true);
    }
  });
});
