/**
 * v2.12 unit tests — useArchivedBranches, usePinnedBranches,
 * useIdentity, useCommitTemplates.
 *
 * These composables persist state to localStorage via loadSettings/saveSettings.
 * Each test clears localStorage before running so there is no bleed-over.
 */

import { describe, it, expect, beforeEach } from "vitest";

// ─── helpers ──────────────────────────────────────────────────────────────────

function clearSettings() {
  localStorage.clear();
}

const CWD_A = "/repos/alpha";
const CWD_B = "/repos/beta";

// ═══════════════════════════════════════════════════════════════════════════════
// useArchivedBranches
// ═══════════════════════════════════════════════════════════════════════════════

describe("useArchivedBranches", () => {
  beforeEach(clearSettings);

  it("archive() adds branch; isArchived() → true", async () => {
    const { useArchivedBranches } = await import("../useArchivedBranches");
    const api = useArchivedBranches(() => CWD_A);
    expect(api.isArchived("feat/x")).toBe(false);
    api.archive("feat/x");
    expect(api.isArchived("feat/x")).toBe(true);
  });

  it("unarchive() removes branch", async () => {
    const { useArchivedBranches } = await import("../useArchivedBranches");
    const api = useArchivedBranches(() => CWD_A);
    api.archive("feat/x");
    api.unarchive("feat/x");
    expect(api.isArchived("feat/x")).toBe(false);
  });

  it("archiveMany() archives multiple branches at once", async () => {
    const { useArchivedBranches } = await import("../useArchivedBranches");
    const api = useArchivedBranches(() => CWD_A);
    api.archiveMany(["feat/a", "feat/b", "fix/c"]);
    expect(api.isArchived("feat/a")).toBe(true);
    expect(api.isArchived("feat/b")).toBe(true);
    expect(api.isArchived("fix/c")).toBe(true);
    expect(api.count.value).toBe(3);
  });

  it("unarchiveAll() clears all archived for repo", async () => {
    const { useArchivedBranches } = await import("../useArchivedBranches");
    const api = useArchivedBranches(() => CWD_A);
    api.archiveMany(["feat/a", "feat/b"]);
    api.unarchiveAll();
    expect(api.count.value).toBe(0);
  });

  it("archives are scoped per repo (CWD_A vs CWD_B are independent)", async () => {
    const { useArchivedBranches } = await import("../useArchivedBranches");
    const apiA = useArchivedBranches(() => CWD_A);
    const apiB = useArchivedBranches(() => CWD_B);
    apiA.archive("feat/x");
    expect(apiB.isArchived("feat/x")).toBe(false);
  });

  it("archiving the same branch twice is a no-op (no duplicates)", async () => {
    const { archiveBranch, archivedForRepo } = await import("../useArchivedBranches");
    const UNIQUE = "feat/no-dup-test";
    archiveBranch(CWD_A, UNIQUE);
    archiveBranch(CWD_A, UNIQUE);
    // Count only the specific branch to avoid state-bleed from other tests
    const occurrences = archivedForRepo(CWD_A).filter((b) => b === UNIQUE).length;
    expect(occurrences).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// usePinnedBranches
// ═══════════════════════════════════════════════════════════════════════════════

describe("usePinnedBranches", () => {
  beforeEach(clearSettings);

  it("pin() adds branch; isPinned() → true", async () => {
    const { usePinnedBranches } = await import("../usePinnedBranches");
    const api = usePinnedBranches(() => CWD_A);
    expect(api.isPinned("main")).toBe(false);
    api.pin("main");
    expect(api.isPinned("main")).toBe(true);
  });

  it("unpin() removes branch", async () => {
    const { usePinnedBranches } = await import("../usePinnedBranches");
    const api = usePinnedBranches(() => CWD_A);
    api.pin("main");
    api.unpin("main");
    expect(api.isPinned("main")).toBe(false);
  });

  it("moveUp() moves pinned branch toward front", async () => {
    const { usePinnedBranches } = await import("../usePinnedBranches");
    const api = usePinnedBranches(() => CWD_A);
    api.pin("a");
    api.pin("b");
    api.pin("c");
    // order: [a, b, c]
    api.moveUp("c"); // [a, c, b]
    expect(api.pinned.value[1]).toBe("c");
    expect(api.pinned.value[2]).toBe("b");
  });

  it("moveDown() moves pinned branch toward end", async () => {
    const { usePinnedBranches } = await import("../usePinnedBranches");
    const api = usePinnedBranches(() => CWD_A);
    api.pin("a");
    api.pin("b");
    api.pin("c");
    // order: [a, b, c]
    api.moveDown("a"); // [b, a, c]
    expect(api.pinned.value[0]).toBe("b");
    expect(api.pinned.value[1]).toBe("a");
  });

  it("moveUp() at index 0 is a no-op", async () => {
    const { usePinnedBranches } = await import("../usePinnedBranches");
    const api = usePinnedBranches(() => CWD_A);
    api.pin("a");
    api.pin("b");
    api.moveUp("a"); // already first — no change
    expect(api.pinned.value[0]).toBe("a");
  });

  it("pins are scoped per repo", async () => {
    const { usePinnedBranches } = await import("../usePinnedBranches");
    const apiA = usePinnedBranches(() => CWD_A);
    const apiB = usePinnedBranches(() => CWD_B);
    apiA.pin("feat/x");
    expect(apiB.isPinned("feat/x")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// useIdentity  (module-level functions — composable wraps them)
// ═══════════════════════════════════════════════════════════════════════════════

describe("useIdentity (module-level functions)", () => {
  beforeEach(clearSettings);

  it("addIdentity() creates a new profile", async () => {
    const { addIdentity, findIdentity } = await import("../useIdentity");
    const id = addIdentity({ label: "Work", gitName: "Alice", gitEmail: "alice@corp.com" });
    expect(typeof id).toBe("string");
    const found = findIdentity(id);
    expect(found?.label).toBe("Work");
    expect(found?.gitName).toBe("Alice");
  });

  it("updateIdentity() mutates existing profile", async () => {
    const { addIdentity, updateIdentity, findIdentity } = await import("../useIdentity");
    const id = addIdentity({ label: "Work", gitName: "Alice", gitEmail: "alice@corp.com" });
    updateIdentity(id, { gitEmail: "alice@newcorp.com" });
    expect(findIdentity(id)?.gitEmail).toBe("alice@newcorp.com");
  });

  it("removeIdentity() deletes profile and clears activeIdentityId", async () => {
    const { addIdentity, removeIdentity, findIdentity, setActiveIdentity, resolveIdentity } = await import("../useIdentity");
    const id = addIdentity({ label: "Work", gitName: "Alice", gitEmail: "alice@corp.com" });
    setActiveIdentity(id);
    removeIdentity(id);
    expect(findIdentity(id)).toBeUndefined();
    expect(resolveIdentity()).toBeNull();
  });

  it("setActiveIdentity() changes the global active identity", async () => {
    const { addIdentity, setActiveIdentity, resolveIdentity } = await import("../useIdentity");
    const id = addIdentity({ label: "Personal", gitName: "Bob", gitEmail: "bob@home.com" });
    setActiveIdentity(id);
    expect(resolveIdentity()?.label).toBe("Personal");
  });

  it("setRepoIdentity() overrides identity for specific repo", async () => {
    const { addIdentity, setActiveIdentity, setRepoIdentity, resolveIdentity } = await import("../useIdentity");
    const idWork = addIdentity({ label: "Work", gitName: "Alice", gitEmail: "alice@work.com" });
    const idHome = addIdentity({ label: "Personal", gitName: "Alice", gitEmail: "alice@home.com" });
    setActiveIdentity(idWork);
    setRepoIdentity(CWD_B, idHome);
    // CWD_B has override → resolves to Personal
    expect(resolveIdentity(CWD_B)?.gitEmail).toBe("alice@home.com");
    // CWD_A has no override → resolves to global active (Work)
    expect(resolveIdentity(CWD_A)?.gitEmail).toBe("alice@work.com");
  });

  it("removeIdentity() also clears all repo overrides for that identity", async () => {
    const { addIdentity, setRepoIdentity, removeIdentity, resolveIdentity } = await import("../useIdentity");
    const id = addIdentity({ label: "Work", gitName: "Alice", gitEmail: "alice@work.com" });
    setRepoIdentity(CWD_B, id);
    removeIdentity(id);
    // Override for CWD_B should be cleared → resolves null
    expect(resolveIdentity(CWD_B)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// useIdentity — reactivity of the `identities` / `activeIdentity` computeds
// (regression test for #140: SettingsPanel.vue renders `identities` straight
// from useIdentity() in a v-for and never re-mounts the composable, so the
// computed must invalidate on every add/update/remove without a reload).
// ═══════════════════════════════════════════════════════════════════════════════

describe("useIdentity (composable reactivity — #140)", () => {
  beforeEach(clearSettings);

  it("identities computed reflects addIdentity() without recreating the composable", async () => {
    const { useIdentity } = await import("../useIdentity");
    const api = useIdentity();
    expect(api.identities.value).toHaveLength(0);
    api.add({ label: "Work", gitName: "Alice", gitEmail: "alice@corp.com" });
    expect(api.identities.value).toHaveLength(1);
    expect(api.identities.value[0].label).toBe("Work");
  });

  it("identities computed reflects updateIdentity() without recreating the composable", async () => {
    const { useIdentity } = await import("../useIdentity");
    const api = useIdentity();
    const id = api.add({ label: "Work", gitName: "Alice", gitEmail: "alice@corp.com" });
    // Force an initial read so the computed caches a value before the mutation —
    // otherwise a lazy first-read-after-mutation would pass even with a stale cache.
    expect(api.identities.value[0].label).toBe("Work");
    api.update(id, { label: "Work (renamed)" });
    expect(api.identities.value[0].label).toBe("Work (renamed)");
  });

  it("identities computed reflects removeIdentity() without recreating the composable", async () => {
    const { useIdentity } = await import("../useIdentity");
    const api = useIdentity();
    const id = api.add({ label: "Work", gitName: "Alice", gitEmail: "alice@corp.com" });
    expect(api.identities.value).toHaveLength(1);
    api.remove(id);
    expect(api.identities.value).toHaveLength(0);
  });

  it("activeIdentity computed reflects setActive() without recreating the composable", async () => {
    const { useIdentity } = await import("../useIdentity");
    const api = useIdentity();
    const id = api.add({ label: "Personal", gitName: "Bob", gitEmail: "bob@home.com" });
    expect(api.activeIdentity.value).toBeNull();
    api.setActive(id);
    expect(api.activeIdentity.value?.label).toBe("Personal");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// useCommitTemplates (module-level functions — composable wraps them)
// ═══════════════════════════════════════════════════════════════════════════════

describe("useCommitTemplates (module-level functions)", () => {
  beforeEach(clearSettings);

  it("addTemplate() creates template", async () => {
    const { addTemplate, findTemplate } = await import("../useCommitTemplates");
    const id = addTemplate({ name: "Feat", subject: "feat: ${cursor}", body: "" });
    expect(typeof id).toBe("string");
    expect(findTemplate(id)?.name).toBe("Feat");
  });

  it("updateTemplate() mutates existing template", async () => {
    const { addTemplate, updateTemplate, findTemplate } = await import("../useCommitTemplates");
    const id = addTemplate({ name: "Feat", subject: "feat: ${cursor}", body: "" });
    updateTemplate(id, { name: "Feature" });
    expect(findTemplate(id)?.name).toBe("Feature");
  });

  it("removeTemplate() deletes template", async () => {
    const { addTemplate, removeTemplate, allTemplates } = await import("../useCommitTemplates");
    const id = addTemplate({ name: "Feat", subject: "feat: ${cursor}", body: "" });
    removeTemplate(id);
    expect(allTemplates().length).toBe(0);
  });

  it("addTemplate() for multiple templates preserves order", async () => {
    const { addTemplate, allTemplates } = await import("../useCommitTemplates");
    addTemplate({ name: "A", subject: "a", body: "" });
    addTemplate({ name: "B", subject: "b", body: "" });
    addTemplate({ name: "C", subject: "c", body: "" });
    expect(allTemplates().map((t) => t.name)).toEqual(["A", "B", "C"]);
  });

  it("findTemplate() returns undefined for unknown id", async () => {
    const { findTemplate } = await import("../useCommitTemplates");
    expect(findTemplate("nonexistent-id")).toBeUndefined();
  });
});
