/**
 * README remote-image consent is remembered per project, keyed like the other
 * per-repo settings (normaliseCwd), and the global setting still wins.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import { useRepoRemoteImages } from "../useRemoteImages";
import { loadSettings, refreshSettings, saveSettings } from "../useSettings";

beforeEach(() => {
  localStorage.clear();
  refreshSettings();
});

describe("useRepoRemoteImages", () => {
  it("remembers the choice for one project only", () => {
    const cwd = ref<string | null>("C:\\repos\\app\\");
    const app = useRepoRemoteImages(cwd);
    expect(app.allowed.value).toBe(false);
    app.allowForRepo();
    expect(app.allowed.value).toBe(true);
    expect(loadSettings().remoteImagesByRepo).toEqual({ "C:/repos/app": true });

    const other = useRepoRemoteImages(ref("/repos/other"));
    expect(other.allowed.value).toBe(false);
  });

  it("is allowed everywhere when the global setting is on", () => {
    const s = loadSettings();
    s.allowRemoteImages = true;
    saveSettings(s);
    refreshSettings();
    expect(useRepoRemoteImages(ref("/repos/x")).allowed.value).toBe(true);
  });

  it("does nothing without a project", () => {
    const none = useRepoRemoteImages(ref(null));
    none.allowForRepo();
    expect(loadSettings().remoteImagesByRepo).toEqual({});
  });
});
