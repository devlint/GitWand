/**
 * Task E3 (v3.6.0) — Review AI settings: defaults + persistence round-trip.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { defaultAppSettings, loadSettings, saveSettings } from "../useSettings";

describe("Review AI settings (E3)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults match the spec: pre-review/summary off, threshold 60, cap 15", () => {
    expect(defaultAppSettings.reviewAiPreReview).toBe(false);
    expect(defaultAppSettings.reviewAiConfidenceThreshold).toBe(60);
    expect(defaultAppSettings.reviewAiMaxFindings).toBe(15);
    expect(defaultAppSettings.reviewAiSummary).toBe(false);
  });

  it("round-trips through save/load", () => {
    saveSettings({
      ...defaultAppSettings,
      reviewAiPreReview: true,
      reviewAiConfidenceThreshold: 80,
      reviewAiMaxFindings: 5,
      reviewAiSummary: true,
    });
    const loaded = loadSettings();
    expect(loaded.reviewAiPreReview).toBe(true);
    expect(loaded.reviewAiConfidenceThreshold).toBe(80);
    expect(loaded.reviewAiMaxFindings).toBe(5);
    expect(loaded.reviewAiSummary).toBe(true);
  });

  it("loadSettings backfills defaults for a stored payload missing the new fields", () => {
    const legacy = { ...defaultAppSettings } as Record<string, unknown>;
    delete legacy.reviewAiPreReview;
    delete legacy.reviewAiConfidenceThreshold;
    delete legacy.reviewAiMaxFindings;
    delete legacy.reviewAiSummary;
    localStorage.setItem("gitwand-settings", JSON.stringify(legacy));
    const loaded = loadSettings();
    expect(loaded.reviewAiPreReview).toBe(false);
    expect(loaded.reviewAiConfidenceThreshold).toBe(60);
    expect(loaded.reviewAiMaxFindings).toBe(15);
    expect(loaded.reviewAiSummary).toBe(false);
  });
});
