/**
 * The invariant: every Tauri command the frontend invokes declares either its
 * dev-server route or why it has none.
 *
 * This is not a unit test of anything — it is what keeps `commandRegistry.ts`
 * true as commands are added. See
 * docs/superpowers/specs/2026-09-18-command-route-registry-design.md §4.
 *
 * Environment: `node`. This file reads sources with `fs` and never imports
 * `backend.ts`, which would pull in `window` and force jsdom for no reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { COMMAND_REGISTRY } from "../commandRegistry";
import {
  findInvokedCommands,
  findDevServerRoutes,
} from "../commandRegistryParse";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

const frontendSource =
  read("src/utils/backend.ts") + "\n" + read("src/utils/backend-core.ts");
const { commands: invoked, dynamic } = findInvokedCommands(frontendSource);
const routes = new Set(findDevServerRoutes(read("dev-server.mjs")));

describe("command registry", () => {
  it("has an entry for every command the frontend invokes", () => {
    const missing = invoked.filter((c) => !(c in COMMAND_REGISTRY));
    expect(
      missing,
      `These commands are invoked but absent from commandRegistry.ts. Add an ` +
        `entry naming the dev-server route, or saying why the command cannot ` +
        `have one: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("declares exactly one of route or desktopOnly for every entry", () => {
    const bad = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => Boolean(e.route) === Boolean(e.desktopOnly))
      .map(([c]) => c);
    expect(
      bad,
      `An entry names a route or explains why it has none — never both, never ` +
        `neither: ${bad.join(", ")}`,
    ).toEqual([]);
  });

  it("gives a real reason wherever it claims desktop-only or CLI-only", () => {
    // A one-word reason is the same as no reason: the next reader still cannot
    // tell a deliberate choice from an oversight.
    const thin = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => {
        const reason = e.desktopOnly ?? e.cliPathOnly;
        return reason !== undefined && reason.trim().split(/\s+/).length < 5;
      })
      .map(([c]) => c);
    expect(thin, `Reason too short to be useful: ${thin.join(", ")}`).toEqual(
      [],
    );
  });

  it("names only routes the dev-server actually serves", () => {
    const phantom = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => e.route && !routes.has(e.route))
      .map(([c, e]) => `${c} → ${e.route}`);
    expect(
      phantom,
      `These entries name a route dev-server.mjs does not declare. Either the ` +
        `route was renamed, or the entry was written from a guess: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  it("has no entry for a command nothing invokes any more", () => {
    const invokedSet = new Set(invoked);
    const stale = Object.keys(COMMAND_REGISTRY).filter(
      (c) => !invokedSet.has(c),
    );
    expect(
      stale,
      `These entries describe commands the frontend no longer invokes. Delete ` +
        `them — a registry that keeps stale rows stops being readable as the ` +
        `list of what the app calls: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("refuses an invocation whose command name is not a string literal", () => {
    expect(
      dynamic,
      `tauriInvoke was called with a non-literal command name. The registry ` +
        `cannot see such a call, so the audit would be wrong rather than ` +
        `merely incomplete. Use a literal: ${dynamic.join(" | ")}`,
    ).toEqual([]);
  });

  it("sets cliPathOnly only on an entry that has a route", () => {
    const bad = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => e.cliPathOnly && !e.route)
      .map(([c]) => c);
    expect(
      bad,
      `cliPathOnly qualifies how an existing route behaves; without a route ` +
        `it says nothing: ${bad.join(", ")}`,
    ).toEqual([]);
  });
});
