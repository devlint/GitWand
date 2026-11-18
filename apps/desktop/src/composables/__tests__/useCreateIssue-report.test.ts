/**
 * useCreateIssue — report mode (#301, part 3): "Report bad resolution" opens
 * the form for the current repository, with a switch to send the report to
 * GitWand's own repository behind guardrails (public confirmation, secrets
 * scan, no path in the text).
 */
import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import type { ConflictHunk } from "@gitwand/core";
import { useCreateIssue } from "../useCreateIssue";
import type { ForgeProvider } from "../forge/types";
import type { CreatedIssue, IssueTargets } from "../../utils/backend";
import { repoReportPrefill, gitwandReportPrefill, type ResolutionReport } from "../../utils/resolutionReport";

const ORIGIN = { repo: "me/app", htmlUrl: "https://github.com/me/app", hasIssues: true, isOrigin: true, canTriage: true };
const ENV = { version: "3.13.2", platform: "macOS" };
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

function provider(targets: IssueTargets = { targets: [ORIGIN], defaultRepo: "me/app" }) {
  return {
    name: "github",
    issueAvailable: vi.fn(async () => true),
    issueTargets: vi.fn(async () => targets),
    listLabels: vi.fn(async () => [{ name: "bug", color: "f00", description: null }]),
    listMilestones: vi.fn(async () => []),
    listAssignees: vi.fn(async () => []),
    createIssue: vi.fn(async (): Promise<CreatedIssue> => ({ number: 7, url: "u" })),
  } as unknown as ForgeProvider;
}

const REPORT: ResolutionReport = {
  kind: "engine",
  path: "src/x.ts",
  hunk: {
    baseLines: ["a"],
    oursLines: ["b"],
    theirsLines: ["c"],
    startLine: 3,
    type: "non_overlapping",
    confidence: { score: 90, label: "high", dimensions: {}, boosters: [], penalties: [] },
    explanation: "e",
    trace: { steps: [], selected: "non_overlapping", summary: "s", hasBase: true },
  } as unknown as ConflictHunk,
  resolvedLines: ["bc"],
};

function setup(p: ForgeProvider = provider(), writable = true) {
  const createGitwandIssue = vi.fn(async (): Promise<CreatedIssue> => ({ number: 9, url: "g" }));
  const api = useCreateIssue({
    cwd: ref("/repo"),
    provider: ref(p),
    onCreated: vi.fn(),
    report: {
      createGitwandIssue,
      gitwandWritable: async () => writable,
      env: () => ENV,
      secretsOptions: async () => ({ extraPatterns: [], entropyThreshold: 4 }),
      scanDebounceMs: 0,
    },
  });
  return { api, p, createGitwandIssue };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 4; i++) await flush();
}

describe("useCreateIssue — report mode", () => {
  it("opens for the current repository with the repository report", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    expect(api.report.value).toEqual(REPORT);
    expect(api.toGitwand.value).toBe(false);
    expect(api.gitwandLocked.value).toBe(false);
    expect(api.repo.value).toBe("me/app");
    const expected = repoReportPrefill(REPORT);
    expect(api.title.value).toBe(expected.title);
    expect(api.body.value).toBe(expected.body);
    expect(api.dirty.value).toBe(false);
  });

  it("opens locked on GitWand when the repository cannot take the issue", async () => {
    const { api } = setup(provider({ targets: [], defaultRepo: null }));
    await api.openFromResolution(REPORT);
    await settle();
    expect(api.toGitwand.value).toBe(true);
    expect(api.gitwandLocked.value).toBe(true);
    expect(api.repo.value).toBe("devlint/GitWand");
    expect(api.body.value).not.toContain("src/x.ts");
  });

  it("a failed targets read still opens the report, locked on GitWand, with the reason", async () => {
    const p = provider();
    (p.issueTargets as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gh: not signed in to ghe.acme"));
    const { api } = setup(p);
    await api.openFromResolution(REPORT);
    await settle();
    expect(api.targetsFailed.value).toBe(false);
    expect(api.targetsError.value).toContain("not signed in");
    expect(api.gitwandLocked.value).toBe(true);
    expect(api.toGitwand.value).toBe(true);
    expect(api.repo.value).toBe("devlint/GitWand");
  });

  it("switching keeps the answer, drops the path and the pickers, and back again", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.labels.value = ["bug"];
    api.answer.value = "keep both";
    api.setGitwand(true);
    expect(api.repo.value).toBe("devlint/GitWand");
    expect(api.body.value).toBe(gitwandReportPrefill(REPORT, ENV).body);
    expect(api.title.value).toBe(gitwandReportPrefill(REPORT, ENV).title);
    expect(api.finalBody.value.startsWith("### What it should have been\n\n```text\nkeep both\n```")).toBe(true);
    expect(api.finalBody.value).not.toContain("src/x.ts");
    expect(api.answer.value).toBe("keep both");
    expect(api.labels.value).toEqual([]);
    expect(api.labelOptions.value).toEqual([]);
    api.confirmedPublic.value = true;
    api.setGitwand(false);
    expect(api.repo.value).toBe("me/app");
    expect(api.body.value).toBe(repoReportPrefill(REPORT).body);
    expect(api.confirmedPublic.value).toBe(false);
  });

  it("switching back returns to the repository the user picked", async () => {
    const PARENT = { repo: "org/app", htmlUrl: "https://github.com/org/app", hasIssues: true, isOrigin: false, canTriage: true };
    const { api } = setup(provider({ targets: [ORIGIN, PARENT], defaultRepo: "me/app" }));
    await api.openFromResolution(REPORT);
    await settle();
    api.setRepo("org/app");
    api.setGitwand(true);
    api.setGitwand(false);
    expect(api.repo.value).toBe("org/app");
  });

  it("on GitWand, Create needs the confirmation and no blocking secret", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.setGitwand(true);
    await settle();
    expect(api.canSubmit.value).toBe(false);
    api.confirmedPublic.value = true;
    await settle();
    expect(api.canSubmit.value).toBe(true);
    api.answer.value = `token ${TOKEN}`;
    await settle();
    expect(api.findings.value.blocking).toHaveLength(1);
    expect(api.canSubmit.value).toBe(false);
    api.answer.value = "token removed";
    await settle();
    expect(api.findings.value.blocking).toHaveLength(0);
    expect(api.canSubmit.value).toBe(true);
  });

  it("a secret in the title blocks too, named as in the title", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.setGitwand(true);
    api.confirmedPublic.value = true;
    api.title.value = `Leak ${TOKEN}`;
    await settle();
    expect(api.findings.value.blocking.map((f) => f.file)).toEqual(["title"]);
    expect(api.canSubmit.value).toBe(false);
  });

  it("names where a secret is: the answer, or the description's own line", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.setGitwand(true);
    api.answer.value = `one\ntwo ${TOKEN}`;
    api.body.value = `l1\nl2\nl3\nl4\nkey ${TOKEN}`;
    await settle();
    expect(api.findings.value.blocking.map((f) => [f.file, f.line])).toEqual([["answer", 2], ["description", 5]]);
  });

  it("holds Create until the repository's secret patterns are loaded", async () => {
    let release!: (o: { extraPatterns: never[]; entropyThreshold: number }) => void;
    const api = useCreateIssue({
      cwd: ref("/repo"),
      provider: ref(provider()),
      onCreated: vi.fn(),
      report: {
        createGitwandIssue: vi.fn(),
        gitwandWritable: async () => true,
        env: () => ENV,
        secretsOptions: () => new Promise((r) => { release = r; }),
        scanDebounceMs: 0,
      },
    });
    await api.openFromResolution(REPORT);
    api.setGitwand(true);
    api.confirmedPublic.value = true;
    await settle();
    expect(api.canSubmit.value).toBe(false);
    release({ extraPatterns: [], entropyThreshold: 4 });
    await settle();
    expect(api.canSubmit.value).toBe(true);
  });

  it("switching clears the previous target's error", async () => {
    const { api, p } = setup();
    (p.createIssue as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("403 Resource not accessible"));
    await api.openFromResolution(REPORT);
    await settle();
    await api.submit();
    expect(api.error.value).toContain("403");
    api.setGitwand(true);
    expect(api.error.value).toBeNull();
  });

  it("on the repository, a secret only warns", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    api.answer.value = `token ${TOKEN}`;
    await settle();
    expect(api.findings.value.blocking).toHaveLength(0);
    expect(api.findings.value.warnings).toHaveLength(1);
    expect(api.canSubmit.value).toBe(true);
  });

  it("sends a GitWand report through its own path, with the answer on top", async () => {
    const { api, p, createGitwandIssue } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.answer.value = "x";
    api.setGitwand(true);
    api.confirmedPublic.value = true;
    await settle();
    const title = api.title.value;
    await api.submit();
    expect(createGitwandIssue).toHaveBeenCalledWith({ title, body: expect.stringContaining("### What it should have been\n\n```text\nx\n```") });
    expect(p.createIssue).not.toHaveBeenCalled();
    expect(api.isOpen.value).toBe(false);
  });

  it("holds Create after a GitWand report that may have been created", async () => {
    const { api, createGitwandIssue } = setup();
    createGitwandIssue.mockRejectedValueOnce(new Error("[may-have-been-created] timeout"));
    await api.openFromResolution(REPORT);
    await settle();
    api.setGitwand(true);
    api.confirmedPublic.value = true;
    await settle();
    await api.submit();
    expect(api.outcomeUnknown.value).toBe(true);
    expect(api.canSubmit.value).toBe(false);
  });

  it("a GitWand report cannot be sent without a github.com sign-in", async () => {
    const { api } = setup(provider(), false);
    await api.openFromResolution(REPORT);
    await settle();
    expect(api.gitwandWritable.value).toBe(false);
    api.setGitwand(true);
    api.confirmedPublic.value = true;
    await settle();
    expect(api.canSubmit.value).toBe(false);
  });

  it("the answer alone makes the form dirty; bodyEdited tracks the generated text", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.answer.value = "y";
    expect(api.dirty.value).toBe(true);
    expect(api.bodyEdited.value).toBe(false);
    api.body.value += "\nmore";
    expect(api.bodyEdited.value).toBe(true);
  });

  it("replaces an untouched open form, like the other entry points", async () => {
    const { api } = setup();
    await api.open();
    await api.openFromResolution(REPORT);
    await settle();
    expect(api.report.value).toEqual(REPORT);
  });

  it("leaves an edited open form alone", async () => {
    const { api } = setup();
    await api.open();
    api.title.value = "mine";
    await api.openFromResolution(REPORT);
    expect(api.report.value).toBeNull();
    expect(api.title.value).toBe("mine");
  });

  it("a report closed while its targets load does not attach to the next form", async () => {
    let release!: (t: IssueTargets) => void;
    const p = provider();
    (p.issueTargets as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<IssueTargets>((r) => { release = r; }),
    );
    const { api } = setup(p);
    const pending = api.openFromResolution(REPORT);
    await flush();
    api.close();
    const plain = api.open();
    release({ targets: [ORIGIN], defaultRepo: "me/app" });
    await pending;
    await plain;
    await settle();
    expect(api.isOpen.value).toBe(true);
    expect(api.report.value).toBeNull();
    expect(api.toGitwand.value).toBe(false);
  });

  it("forgets the previous repository's secret patterns", async () => {
    const acme = { id: "acme", regex: "ACME-[0-9]{6}", severity: "high" as const, description: "d" };
    const opts = vi
      .fn()
      .mockResolvedValueOnce({ extraPatterns: [acme], entropyThreshold: 4 })
      .mockImplementationOnce(() => new Promise(() => {}));
    const api = useCreateIssue({
      cwd: ref("/repo"),
      provider: ref(provider()),
      onCreated: vi.fn(),
      report: {
        createGitwandIssue: vi.fn(),
        gitwandWritable: async () => true,
        env: () => ENV,
        secretsOptions: opts,
        scanDebounceMs: 0,
      },
    });
    await api.openFromResolution(REPORT);
    await settle();
    api.answer.value = "ACME-123456";
    await settle();
    expect(api.findings.value.warnings.map((f) => f.patternId)).toEqual(["acme"]);
    api.close();
    await api.openFromResolution(REPORT);
    api.answer.value = "ACME-123456";
    await settle();
    expect(api.findings.value.warnings).toEqual([]);
  });

  it("a plain open after a report shows no report state", async () => {
    const { api } = setup();
    await api.openFromResolution(REPORT);
    await settle();
    api.close();
    await api.open();
    expect(api.report.value).toBeNull();
    expect(api.toGitwand.value).toBe(false);
    expect(api.answer.value).toBe("");
  });
});
