import { describe, it, expect } from "vitest";
import {
  GITWAND_HOOK_MARKER,
  buildGitwandHookScript,
  parseGitwandHookSections,
  classifyPreCommitHook,
  type HookSections,
} from "../gitwandHook";
import { buildSecretsHookScript } from "../secretsHook";

describe("buildGitwandHookScript / parseGitwandHookSections — round-trip", () => {
  const combos: HookSections[] = [
    { secrets: false, review: false },
    { secrets: true, review: false },
    { secrets: false, review: true },
    { secrets: true, review: true },
  ];

  for (const sections of combos) {
    it(`round-trips secrets=${sections.secrets} review=${sections.review}`, () => {
      const script = buildGitwandHookScript(sections);
      expect(parseGitwandHookSections(script)).toEqual(sections);
    });
  }

  it("always starts with a bash shebang and carries the v2 marker", () => {
    const script = buildGitwandHookScript({ secrets: true, review: true });
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env bash");
    expect(script).toContain(GITWAND_HOOK_MARKER);
  });
});

describe("parseGitwandHookSections — migration and foreign-hook detection", () => {
  it("parses a v1 secrets-only script as {secrets:true, review:false}", () => {
    const v1Script = buildSecretsHookScript();
    expect(parseGitwandHookSections(v1Script)).toEqual({ secrets: true, review: false });
  });

  it("returns null for a foreign/unrelated hook script", () => {
    expect(parseGitwandHookSections("#!/usr/bin/env bash\necho hello\n")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseGitwandHookSections("")).toBeNull();
  });
});

describe("review section — warn-only contract", () => {
  it("never contains exit 1, in isolation or alongside the secrets section", () => {
    expect(buildGitwandHookScript({ secrets: false, review: true })).not.toContain("exit 1");
    expect(buildGitwandHookScript({ secrets: true, review: true })).not.toMatch(
      /gitwand:review[\s\S]*exit 1/,
    );
  });

  it("is absent entirely when review is off", () => {
    const script = buildGitwandHookScript({ secrets: true, review: false });
    expect(script).not.toContain("gitwand:review");
  });
});

describe("secrets section — byte-identical regression guard on the shipped v3.5.0 invocation", () => {
  it("contains the exact @gitwand/cli scan --staged --strict --json invocation, byte-for-byte", () => {
    const script = buildGitwandHookScript({ secrets: true, review: false });
    expect(script).toContain("npx --no-install @gitwand/cli scan --staged --strict --json || {");
    expect(script).toContain('  echo "GitWand: potential secrets in staged changes (see above). Commit blocked."');
    expect(script).toContain('  echo "Bypass once with: git commit --no-verify"');
    expect(script).toContain("  exit 1");
    expect(script).toContain("}");
  });

  it("matches the corresponding lines of the shipped buildSecretsHookScript() output exactly", () => {
    const legacyLines = buildSecretsHookScript().split("\n");
    const composableLines = buildGitwandHookScript({ secrets: true, review: false }).split("\n");

    // The invocation block (npx ... through the closing "}") is identical between the legacy
    // v1 script and the v2 composable script's secrets section — only the shebang/marker
    // lines around it, and the boundary comments, differ.
    const legacyInvocation = legacyLines.slice(2, 7); // npx.. / echo / echo / exit 1 / }
    const composableInvocation = composableLines.slice(3, 8); // after shebang, marker, >>> boundary
    expect(composableInvocation).toEqual(legacyInvocation);
  });

  it("is absent entirely when secrets is off", () => {
    const script = buildGitwandHookScript({ secrets: false, review: true });
    expect(script).not.toContain("@gitwand/cli scan");
  });
});

describe("neither section — an empty composable script still carries the v2 marker", () => {
  it("is still recognized as a GitWand-managed script with no sections installed", () => {
    const script = buildGitwandHookScript({ secrets: false, review: false });
    expect(parseGitwandHookSections(script)).toEqual({ secrets: false, review: false });
  });
});

// v3.7.0 review-round fix (finding #7) — a foreign (non-GitWand) pre-commit
// hook collapsed to the exact same "none" state as no hook at all, so the UI
// showed no warning that Install would OVERWRITE the user's own script.
describe("classifyPreCommitHook", () => {
  it("null (unreadable or absent) classifies as none, with both sections false", () => {
    expect(classifyPreCommitHook(null)).toEqual({
      kind: "none",
      sections: { secrets: false, review: false },
    });
  });

  it("an empty string classifies as none", () => {
    expect(classifyPreCommitHook("")).toEqual({
      kind: "none",
      sections: { secrets: false, review: false },
    });
  });

  it("a whitespace-only string classifies as none", () => {
    expect(classifyPreCommitHook("   \n\t  \n")).toEqual({
      kind: "none",
      sections: { secrets: false, review: false },
    });
  });

  const combos: HookSections[] = [
    { secrets: false, review: false },
    { secrets: true, review: false },
    { secrets: false, review: true },
    { secrets: true, review: true },
  ];
  for (const sections of combos) {
    it(`a v2 GitWand script (secrets=${sections.secrets} review=${sections.review}) classifies as gitwand with the right sections`, () => {
      const script = buildGitwandHookScript(sections);
      expect(classifyPreCommitHook(script)).toEqual({ kind: "gitwand", sections });
    });
  }

  it("a v1 secrets-only script classifies as gitwand with {secrets:true, review:false} (migration regression guard)", () => {
    const v1Script = buildSecretsHookScript();
    expect(classifyPreCommitHook(v1Script)).toEqual({
      kind: "gitwand",
      sections: { secrets: true, review: false },
    });
  });

  it("a hand-written, unrelated script classifies as foreign", () => {
    expect(classifyPreCommitHook("#!/bin/sh\nnpm test\n")).toEqual({
      kind: "foreign",
      sections: { secrets: false, review: false },
    });
  });

  it("a script that merely mentions 'gitwand' in a comment (no marker) still classifies as foreign — no fuzzy matching", () => {
    expect(classifyPreCommitHook("#!/bin/sh\n# note: unrelated to gitwand\nnpm test\n")).toEqual({
      kind: "foreign",
      sections: { secrets: false, review: false },
    });
  });
});
