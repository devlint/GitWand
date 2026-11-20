/**
 * reportGuard — the issue form's secrets scan (#301) lives in `@gitwand/core`
 * (shared with the MCP `gitwand_create_issue` tool); its tests are there
 * (`packages/core/src/__tests__/secrets/report.test.ts`). This file only pins
 * that the desktop uses that one implementation.
 */
import { describe, it, expect } from "vitest";
import * as core from "@gitwand/core";
import { scanReportBody } from "../reportGuard";

describe("reportGuard", () => {
  it("re-exports core's scanReportBody", () => {
    expect(scanReportBody).toBe(core.scanReportBody);
  });
});
