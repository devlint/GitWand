/**
 * v3.11.2 — the Browse view is gone: the File Explorer panel is the file
 * browser (spec addendum 2026-10-02). These pin what an existing user's saved
 * settings meet after the upgrade, and that the locales lost exactly the
 * Browse-only keys.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_DOCK_ORDER,
  defaultAppSettings,
  isDockEntryHidden,
  loadSettings,
  normalizeDockOrder,
  type DockEntryId,
} from "../useSettings";
import en from "../../locales/en";
import fr from "../../locales/fr";
import es from "../../locales/es";
import ptBR from "../../locales/pt-BR";
import zhCN from "../../locales/zh-CN";

const SRC = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
/** useSettings.ts:566 (SETTINGS_KEY, not exported). */
const SETTINGS_KEY = "gitwand-settings";

describe("v3.11.2 — Browse removed, the File Explorer panel is the file browser", () => {
  beforeEach(() => localStorage.clear());

  it("drops a stored 'files-view' dock id", () => {
    expect(DEFAULT_DOCK_ORDER).not.toContain("files-view");
    const stored = ["files-view", "changes", "graph", "prs", "dashboard", "launchpad"] as unknown as DockEntryId[];
    expect(normalizeDockOrder(stored)).toEqual(["graph", "prs", "dashboard", "launchpad"]);
    expect(normalizeDockOrder(["files-view"] as unknown as DockEntryId[])).toEqual(DEFAULT_DOCK_ORDER);
  });

  it("an existing user's saved Browse settings load, and startup lands on a real view", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        dockOrder: ["files-view", "graph", "launchpad", "dashboard", "prs", "changes"],
        dockHideFilesView: false,
      }),
    );
    const s = loadSettings();
    // App.vue's "default" startup view: the first visible entry in dock order.
    const first = normalizeDockOrder(s.dockOrder).find((id) => !isDockEntryHidden(id, s));
    expect(first).toBe("graph");
  });

  it("has no dockHideFilesView left in either settings file", () => {
    expect("dockHideFilesView" in defaultAppSettings).toBe(false);
    expect(read("composables/useSettings.ts")).not.toContain("dockHideFilesView");
    expect(read("components/SettingsPanel.vue")).not.toContain("dockHideFilesView");
  });

  it("removes the Browse-only keys from all five locales, and keeps the rest aligned", () => {
    for (const loc of [en, fr, es, ptBR, zhCN]) {
      const l = loc as unknown as Record<string, Record<string, unknown>>;
      expect(l.header!.paletteViewFiles).toBeUndefined();
      expect(l.menu!.openFilesView).toBeUndefined();
      const dock = l.settings!.dock as Record<string, unknown>;
      expect(dock.itemFilesView).toBeUndefined();
      expect(dock.showFilesView).toBeUndefined();
      expect(l.filesView!.dockLabel).toBeUndefined();
      expect(l.filesView!.breadcrumbLabel).toBeUndefined();
      expect(Object.keys(loc.filesView).sort()).toEqual(Object.keys(en.filesView).sort());
      expect(Object.keys(loc.filesView.preview).sort()).toEqual(Object.keys(en.filesView.preview).sort());
    }
  });

  it("references every remaining filesView key from the source", () => {
    const sources = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((f) => /\.(vue|ts)$/.test(f) && !f.includes("locales") && !f.includes("__tests__"))
      .map((f) => readFileSync(join(SRC, f), "utf-8"))
      .join("\n");
    const keys = [
      ...Object.keys(en.filesView).filter((k) => k !== "preview").map((k) => `filesView.${k}`),
      ...Object.keys(en.filesView.preview).map((k) => `filesView.preview.${k}`),
    ];
    const unreferenced = keys.filter((k) => !sources.includes(`"${k}"`) && !sources.includes(`'${k}'`));
    expect(unreferenced).toEqual([]);
  });
});
