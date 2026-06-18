import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import type { WorkspaceRepo } from "../../utils/backend";

const settingsRef = ref<{ launchpadScopePaths: string[] }>({ launchpadScopePaths: [] });
const saveMock = vi.fn();

vi.mock("../../composables/useSettings", () => ({
  useSettings: () => ({ settings: settingsRef }),
  saveSettings: (s: unknown) => saveMock(s),
}));

import { useLaunchpadScope } from "../useLaunchpadScope";

const REPOS: WorkspaceRepo[] = [
  { path: "/a", name: "alpha" },
  { path: "/b", name: "beta" },
  { path: "/c", name: "gamma" },
];

describe("useLaunchpadScope", () => {
  beforeEach(() => {
    settingsRef.value = { launchpadScopePaths: [] };
    saveMock.mockReset();
  });

  it("defaults to all open repos when no selection", () => {
    const { isAll, scopedRepos } = useLaunchpadScope(ref(REPOS));
    expect(isAll.value).toBe(true);
    expect(scopedRepos.value).toEqual(REPOS);
  });

  it("toggling one off from 'all' keeps the rest (all-except-it)", () => {
    const { toggle, scopedRepos, isAll } = useLaunchpadScope(ref(REPOS));
    toggle("/b");
    expect(isAll.value).toBe(false);
    expect(scopedRepos.value.map((r) => r.path)).toEqual(["/a", "/c"]);
    expect(settingsRef.value.launchpadScopePaths).toEqual(["/a", "/c"]);
    expect(saveMock).toHaveBeenCalled();
  });

  it("selecting every repo normalises back to 'all' ([])", () => {
    settingsRef.value.launchpadScopePaths = ["/a", "/b"];
    const { toggle, isAll } = useLaunchpadScope(ref(REPOS));
    toggle("/c");
    expect(settingsRef.value.launchpadScopePaths).toEqual([]);
    expect(isAll.value).toBe(true);
  });

  it("unchecking the last selected repo reverts to 'all' rather than empty", () => {
    settingsRef.value.launchpadScopePaths = ["/a"];
    const { toggle, isAll } = useLaunchpadScope(ref(REPOS));
    toggle("/a");
    expect(settingsRef.value.launchpadScopePaths).toEqual([]);
    expect(isAll.value).toBe(true);
  });

  it("falls back to all when the selection matches no open repo", () => {
    settingsRef.value.launchpadScopePaths = ["/gone"];
    const { scopedRepos } = useLaunchpadScope(ref(REPOS));
    expect(scopedRepos.value).toEqual(REPOS);
  });

  it("setAll resets to all", () => {
    settingsRef.value.launchpadScopePaths = ["/a"];
    const { setAll, isAll } = useLaunchpadScope(ref(REPOS));
    setAll();
    expect(settingsRef.value.launchpadScopePaths).toEqual([]);
    expect(isAll.value).toBe(true);
  });

  it("isSelected reflects membership when a subset is active", () => {
    settingsRef.value.launchpadScopePaths = ["/a"];
    const { isSelected } = useLaunchpadScope(ref(REPOS));
    expect(isSelected("/a")).toBe(true);
    expect(isSelected("/b")).toBe(false);
  });
});
