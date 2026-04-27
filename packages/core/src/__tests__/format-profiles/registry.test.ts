/**
 * Tests du registre de profils (v2.2).
 */

import { describe, it, expect } from "vitest";
import {
  profileForFile,
  registerFormatProfile,
  strategyForPath,
} from "../../format-profiles/index.js";
import type { FormatProfile } from "../../format-profiles/types.js";

describe("profileForFile — built-ins", () => {
  it("matche package.json à la racine", () => {
    const p = profileForFile("package.json");
    expect(p?.name).toBe("package.json");
  });

  it("matche package.json dans un workspace", () => {
    const p = profileForFile("apps/desktop/package.json");
    expect(p?.name).toBe("package.json");
  });

  it("ne matche pas package-lock.json", () => {
    expect(profileForFile("package-lock.json")).toBeNull();
  });

  it("ne matche pas un fichier non reconnu", () => {
    expect(profileForFile("README.md")).toBeNull();
    expect(profileForFile("src/utils.ts")).toBeNull();
  });

  it("matche tsconfig.json et ses variants", () => {
    expect(profileForFile("tsconfig.json")?.name).toBe("tsconfig.json");
    expect(profileForFile("tsconfig.build.json")?.name).toBe("tsconfig.json");
    expect(profileForFile("apps/desktop/tsconfig.app.json")?.name).toBe("tsconfig.json");
  });

  it("matche composer.json", () => {
    expect(profileForFile("composer.json")?.name).toBe("composer.json");
    expect(profileForFile("backend/composer.json")?.name).toBe("composer.json");
    // composer-lock pas couvert par ce profil
    expect(profileForFile("composer.lock")).toBeNull();
  });

  it("matche helm/values.yaml", () => {
    expect(profileForFile("helm/values.yaml")?.name).toBe("helm/values.yaml");
    expect(profileForFile("charts/myapp/values.yaml")?.name).toBe("helm/values.yaml");
    expect(profileForFile("charts/myapp/values.production.yaml")?.name).toBe("helm/values.yaml");
    // .yaml sans dossier helm/charts → kubernetes ou null
    expect(profileForFile("config/values.yaml")?.name).not.toBe("helm/values.yaml");
  });

  it("matche kubernetes manifests", () => {
    expect(profileForFile("k8s/deployment.yaml")?.name).toBe("kubernetes");
    expect(profileForFile("kubernetes/service.yml")?.name).toBe("kubernetes");
    expect(profileForFile("manifests/configmap.yaml")?.name).toBe("kubernetes");
    // basename only (sans dossier k8s)
    expect(profileForFile("deployment.yaml")?.name).toBe("kubernetes");
    expect(profileForFile("ingress.yml")?.name).toBe("kubernetes");
    // .yaml sans signal kubernetes ni helm → null
    expect(profileForFile("config/app.yaml")).toBeNull();
  });
});

describe("strategyForPath — tsconfig.json", () => {
  const profile = profileForFile("tsconfig.json")!;

  it("/compilerOptions/lib → set", () => {
    expect(strategyForPath(profile, "/compilerOptions/lib")).toEqual({ kind: "set" });
  });

  it("/include → set", () => {
    expect(strategyForPath(profile, "/include")).toEqual({ kind: "set" });
  });

  it("/references identité par path", () => {
    const s = strategyForPath(profile, "/references");
    expect(s.kind).toBe("set");
    if (s.kind === "set" && s.identity) {
      expect(s.identity({ path: "../shared" })).toBe("../shared");
    }
  });
});

describe("strategyForPath — package.json", () => {
  const profile = profileForFile("package.json")!;

  it("/dependencies → merge-keys", () => {
    expect(strategyForPath(profile, "/dependencies")).toEqual({ kind: "merge-keys" });
  });

  it("/scripts → merge-keys", () => {
    expect(strategyForPath(profile, "/scripts")).toEqual({ kind: "merge-keys" });
  });

  it("/keywords → set", () => {
    expect(strategyForPath(profile, "/keywords")).toEqual({ kind: "set" });
  });

  it("path inconnu → défaut (merge-keys)", () => {
    expect(strategyForPath(profile, "/foo")).toEqual({ kind: "merge-keys" });
  });
});

describe("registerFormatProfile — custom + cleanup", () => {
  it("override un built-in et désinscrit proprement", () => {
    const customProfile: FormatProfile = {
      name: "custom-package-json",
      matches: (fp) => fp.endsWith("package.json"),
      paths: {
        "/dependencies": { kind: "ordered-list" },
      },
      default: { kind: "opaque" },
    };

    // Avant register : built-in trouvé
    expect(profileForFile("package.json")?.name).toBe("package.json");

    const unregister = registerFormatProfile(customProfile);
    try {
      // Le custom prend priorité (inséré en tête)
      expect(profileForFile("package.json")?.name).toBe("custom-package-json");
      expect(strategyForPath(customProfile, "/dependencies")).toEqual({ kind: "ordered-list" });
    } finally {
      unregister();
    }

    // Après cleanup : built-in retrouvé
    expect(profileForFile("package.json")?.name).toBe("package.json");
  });
});

describe("strategyForPath — wildcards", () => {
  it("matche un segment via *", () => {
    const profile: FormatProfile = {
      name: "test",
      matches: () => true,
      paths: {
        "/items/*/tags": { kind: "set" },
      },
      default: { kind: "opaque" },
    };
    expect(strategyForPath(profile, "/items/foo/tags")).toEqual({ kind: "set" });
    expect(strategyForPath(profile, "/items/0/tags")).toEqual({ kind: "set" });
    // Non-match : nombre de segments différent
    expect(strategyForPath(profile, "/items/foo")).toEqual({ kind: "opaque" });
    expect(strategyForPath(profile, "/items/foo/tags/extra")).toEqual({ kind: "opaque" });
  });
});
