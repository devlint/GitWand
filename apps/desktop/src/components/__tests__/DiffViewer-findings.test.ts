/**
 * Task 1b (v3.7.0) — inline commit-review finding rows in `DiffViewer`
 * (inline mode). Mounted with the native `createApp` (no @vue/test-utils
 * dep), mirroring `PrInlineDiff.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import DiffViewer from "../DiffViewer.vue";
import type { GitDiff, DiffLine } from "../../utils/backend";
import type { ReviewFinding } from "../../composables/usePrPreReview";

function line(type: DiffLine["type"], content: string, oldLineNo?: number, newLineNo?: number): DiffLine {
  return { type, content, oldLineNo, newLineNo };
}

function smallDiff(): GitDiff {
  return {
    path: "src/foo.ts",
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          line("context", "unchanged", 1, 1),
          line("delete", "old value", 2, undefined),
          line("add", "new value", undefined, 2),
        ],
      },
    ],
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    path: "src/foo.ts",
    line: 2,
    side: "RIGHT",
    severity: "risk",
    confidence: 80,
    title: "Risk title",
    detail: "Risk detail",
    ...overrides,
  };
}

interface MountResult { app: App; container: HTMLDivElement; vm: any }

function mountDiff(props: Record<string, unknown>): MountResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(DiffViewer as any, props);
  const vm = app.mount(container);
  return { app, container, vm };
}

function unmount({ app, container }: MountResult) {
  app.unmount();
  if (container.parentNode) container.parentNode.removeChild(container);
}

describe("DiffViewer — inline commit-review finding rows", () => {
  let mounted: MountResult | null = null;

  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  it("renders one finding row anchored on the added line, with the right severity class", async () => {
    mounted = mountDiff({
      diff: smallDiff(),
      filePath: "src/foo.ts",
      diffMode: "inline",
      findings: [finding({ severity: "risk" })],
    });
    await nextTick();

    const rows = mounted.container.querySelectorAll(".diff-finding-row");
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(".diff-finding-severity")?.classList.contains("diff-finding-severity--risk")).toBe(true);
    expect(rows[0].textContent).toContain("Risk title");
    expect(rows[0].textContent).toContain("Risk detail");
    expect(rows[0].textContent).toContain("80");
  });

  it("renders no row (and does not throw) for a finding whose line isn't in the diff", async () => {
    mounted = mountDiff({
      diff: smallDiff(),
      filePath: "src/foo.ts",
      diffMode: "inline",
      findings: [finding({ id: "orphan", line: 99, severity: "nit" })],
    });
    await nextTick();

    expect(mounted.container.querySelectorAll(".diff-finding-row").length).toBe(0);
  });

  it("emits dismiss-finding with the finding's id when Dismiss is clicked", async () => {
    let dismissedId: string | null = null;
    mounted = mountDiff({
      diff: smallDiff(),
      filePath: "src/foo.ts",
      diffMode: "inline",
      findings: [finding({ id: "f-dismiss" })],
      onDismissFinding: (id: string) => { dismissedId = id; },
    });
    await nextTick();

    mounted.container.querySelector<HTMLButtonElement>(".diff-finding-dismiss")!.click();
    expect(dismissedId).toBe("f-dismiss");
  });

  it("does not merge LEFT and RIGHT findings that share the same line number", async () => {
    mounted = mountDiff({
      diff: smallDiff(),
      filePath: "src/foo.ts",
      diffMode: "inline",
      findings: [
        finding({ id: "right-2", side: "RIGHT", line: 2, title: "Right finding" }),
        finding({ id: "left-2", side: "LEFT", line: 2, title: "Left finding" }),
      ],
    });
    await nextTick();

    const rows = mounted.container.querySelectorAll(".diff-finding-row");
    expect(rows.length).toBe(2);
    // Each row carries exactly one finding, not a merged pair.
    expect(rows[0].textContent).toContain("Left finding");
    expect(rows[0].textContent).not.toContain("Right finding");
    expect(rows[1].textContent).toContain("Right finding");
    expect(rows[1].textContent).not.toContain("Left finding");
  });
});
