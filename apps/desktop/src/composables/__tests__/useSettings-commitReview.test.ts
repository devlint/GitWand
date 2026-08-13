/**
 * Task 1a (v3.7.0) — Commit Review settings: defaults + persistence round-trip.
 * Mirrors `useSettings-reviewAi.test.ts`'s structure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { defaultAppSettings, loadSettings, saveSettings } from "../useSettings";

describe("Commit Review settings (v3.7.0)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to opt-in-off: commitReviewEnabled false, commitReviewAutoReReview true", () => {
    expect(defaultAppSettings.commitReviewEnabled).toBe(false);
    expect(defaultAppSettings.commitReviewAutoReReview).toBe(true);
  });

  it("round-trips through save/load", () => {
    saveSettings({
      ...defaultAppSettings,
      commitReviewEnabled: true,
      commitReviewAutoReReview: false,
    });
    const loaded = loadSettings();
    expect(loaded.commitReviewEnabled).toBe(true);
    expect(loaded.commitReviewAutoReReview).toBe(false);
  });

  it("loadSettings backfills defaults for a stored payload missing the new fields", () => {
    const legacy = { ...defaultAppSettings } as Record<string, unknown>;
    delete legacy.commitReviewEnabled;
    delete legacy.commitReviewAutoReReview;
    localStorage.setItem("gitwand-settings", JSON.stringify(legacy));
    const loaded = loadSettings();
    expect(loaded.commitReviewEnabled).toBe(false);
    expect(loaded.commitReviewAutoReReview).toBe(true);
  });
});
