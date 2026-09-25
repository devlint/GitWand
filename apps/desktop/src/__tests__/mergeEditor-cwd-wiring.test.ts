/**
 * `MergeEditor` declares an optional `cwd` prop, and everything that needs the
 * repository reads it: the v3.11.1 history section of "Resolve with AI", custom
 * automations and resolution-memory apply. Because the prop is optional,
 * forgetting to pass it type-checks and fails silently: every one of those
 * features just turns itself off. That is exactly how "Resolve with AI" shipped
 * its first v3.11.1 build without history (caught in manual QA, not by any
 * test), so this pins the one call site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appVue = readFileSync(resolve(__dirname, "../App.vue"), "utf-8");

describe("App.vue — MergeEditor wiring", () => {
  it("passes the repository path to every <MergeEditor>", () => {
    const tags = [...appVue.matchAll(/<MergeEditor\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/\s:cwd="/);
  });
});
