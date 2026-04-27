/**
 * Tests d'intégration v2.2 — vérifie que le hook profil dans
 * `tryResolveJsonConflict` débloque les cas qui retombaient en fallback
 * textuel en v2.1.
 */

import { describe, it, expect } from "vitest";
import { tryResolveJsonConflict } from "../../resolvers/json.js";

describe("tryResolveJsonConflict — package.json + profil", () => {
  it("/keywords ajoutés des deux côtés (set) — résout", () => {
    const base = `{
  "name": "demo",
  "keywords": ["git"]
}`;
    const ours = `{
  "name": "demo",
  "keywords": ["git", "merge"]
}`;
    const theirs = `{
  "name": "demo",
  "keywords": ["git", "diff"]
}`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "package.json",
    );
    expect(result.merged).not.toBeNull();
    const parsed = JSON.parse(result.merged as string);
    // Le set doit contenir tous les keywords (ordre = ours d'abord, puis nouveaux de theirs)
    expect(parsed.keywords).toEqual(["git", "merge", "diff"]);
  });

  it("/files modifiés des deux côtés — set préserve les ajouts", () => {
    const base = `{
  "name": "demo",
  "files": ["dist", "README.md"]
}`;
    const ours = `{
  "name": "demo",
  "files": ["dist", "README.md", "LICENSE"]
}`;
    const theirs = `{
  "name": "demo",
  "files": ["dist", "README.md", "CHANGELOG.md"]
}`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "package.json",
    );
    expect(result.merged).not.toBeNull();
    const parsed = JSON.parse(result.merged as string);
    expect(parsed.files).toEqual(["dist", "README.md", "LICENSE", "CHANGELOG.md"]);
  });

  it("sans filePath — pas de profil, fallback v2.1 (pas de routage)", () => {
    // Sans filePath, le résolveur ne consulte pas le profil → comportement
    // v2.1 (les arrays modifiés différemment retombent en conflit).
    const base = `{ "tags": ["a"] }`;
    const ours = `{ "tags": ["a", "b"] }`;
    const theirs = `{ "tags": ["a", "c"] }`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      // pas de filePath
    );
    expect(result.merged).toBeNull();
  });
});

describe("tryResolveJsonConflict — tsconfig.json + profil", () => {
  it("/include divergent (set) — résout", () => {
    const base = `{
  "compilerOptions": { "strict": true },
  "include": ["src"]
}`;
    const ours = `{
  "compilerOptions": { "strict": true },
  "include": ["src", "tests"]
}`;
    const theirs = `{
  "compilerOptions": { "strict": true },
  "include": ["src", "scripts"]
}`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "tsconfig.json",
    );
    expect(result.merged).not.toBeNull();
    const parsed = JSON.parse(result.merged as string);
    expect(parsed.include).toEqual(["src", "tests", "scripts"]);
  });

  it("/compilerOptions/lib ajouté des deux côtés (depuis base sans lib)", () => {
    const base = `{
  "compilerOptions": { "strict": true }
}`;
    const ours = `{
  "compilerOptions": { "strict": true, "lib": ["ES2022", "DOM"] }
}`;
    const theirs = `{
  "compilerOptions": { "strict": true, "lib": ["ES2022", "WebWorker"] }
}`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "tsconfig.json",
    );
    expect(result.merged).not.toBeNull();
    const parsed = JSON.parse(result.merged as string);
    expect(parsed.compilerOptions.lib).toEqual(["ES2022", "DOM", "WebWorker"]);
  });

  it("/references avec identité 'path' — déduplique correctement", () => {
    const base = `{
  "references": [{ "path": "../shared" }]
}`;
    const ours = `{
  "references": [{ "path": "../shared" }, { "path": "../utils" }]
}`;
    const theirs = `{
  "references": [{ "path": "../shared" }, { "path": "../core" }]
}`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "tsconfig.json",
    );
    expect(result.merged).not.toBeNull();
    const parsed = JSON.parse(result.merged as string);
    expect(parsed.references).toEqual([
      { path: "../shared" },
      { path: "../utils" },
      { path: "../core" },
    ]);
  });
});

describe("tryResolveYamlConflict — kubernetes + profil", () => {
  it("Deployment containers mergés par 'name'", async () => {
    const { tryResolveYamlConflict } = await import("../../resolvers/yaml.js");
    const base = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`;
    const ours = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:2.0
        - name: sidecar
          image: sidecar:1.0
`;
    const theirs = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
        - name: log-shipper
          image: fluent-bit:2.0
`;
    const result = tryResolveYamlConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "k8s/deployment.yaml",
    );
    expect(result.mergedLines).not.toBeNull();
    const merged = result.mergedLines!.join("\n");
    // app a été modifié (1.0 → 2.0) côté ours, theirs n'y a pas touché → 2.0
    expect(merged).toContain("image: app:2.0");
    // les deux nouveaux containers sont présents
    expect(merged).toContain("sidecar");
    expect(merged).toContain("log-shipper");
  });
});

describe("disableFormatProfiles — rollback global v2.1", () => {
  it("désactive le hook profil dans le pipeline complet (resolve)", async () => {
    const { resolve } = await import("../../resolver.js");
    const conflict = `<<<<<<< ours
{
  "name": "demo",
  "keywords": ["a", "b"]
}
=======
{
  "name": "demo",
  "keywords": ["a", "c"]
}
>>>>>>> theirs
`;
    // Sans disable : profil package.json résout via "set"
    const enabled = resolve(conflict, "package.json");
    expect(enabled.stats.autoResolved).toBe(1);

    // Avec disable : retombée comportement v2.1 (fallback textuel)
    const disabled = resolve(conflict, "package.json", { disableFormatProfiles: true });
    expect(disabled.stats.autoResolved).toBe(0);
  });
});

describe("tryResolveJsonConflict — non-applicable", () => {
  it("conflit sur scalaire (modif divergente) — pas résolu malgré profil", () => {
    const base = `{ "name": "demo" }`;
    const ours = `{ "name": "demo-app" }`;
    const theirs = `{ "name": "demo-lib" }`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "package.json",
    );
    expect(result.merged).toBeNull();
  });

  it("filePath inconnu (pas de profil) — comportement v2.1", () => {
    const base = `{ "list": ["a"] }`;
    const ours = `{ "list": ["a", "b"] }`;
    const theirs = `{ "list": ["a", "c"] }`;
    const result = tryResolveJsonConflict(
      base.split("\n"),
      ours.split("\n"),
      theirs.split("\n"),
      "unknown-file.json",
    );
    expect(result.merged).toBeNull();
  });
});
