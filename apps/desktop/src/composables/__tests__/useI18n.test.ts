import { describe, it, expect } from "vitest";
import { t } from "../useI18n";

describe("t — positional interpolation", () => {
  it("replaces every occurrence of a placeholder, not only the first", () => {
    // en: "Rebase {0} onto {1}, then fast-forward {1}."
    expect(t("mergeBack.previewIntro.rebase", "task/x", "main")).toBe(
      "Rebase task/x onto main, then fast-forward main.",
    );
  });
});
