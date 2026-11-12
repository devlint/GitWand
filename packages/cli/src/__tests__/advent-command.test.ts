import { describe, expect, it } from "vitest";

import { ADVENT_YEAR, DOORS, opensOn, publicDoor } from "../advent/index.js";
import {
  renderDoor,
  renderInvalid,
  renderLocked,
  renderNotStarted,
  renderOver,
  type Palette,
} from "../advent-render.js";
import { runAdvent } from "../commands/advent.js";
import { shouldCheckForUpdate } from "../cli.js";

const plain: Palette = {
  reset: "",
  bold: "",
  dim: "",
  green: "",
  yellow: "",
  red: "",
  cyan: "",
  magenta: "",
};
const at = (ymd: string): Date => new Date(`${ymd}T12:00:00+01:00`);
const dec12 = at(`${ADVENT_YEAR}-12-12`);
const run = (positional: string[], now: Date, flags: Record<string, boolean | string> = {}) =>
  runAdvent(positional, flags, { now, width: 80, palette: plain });

describe("runAdvent (human output)", () => {
  it("shows today's door with no argument", () => {
    const r = run([], dec12);
    expect(r.code).toBe(0);
    expect(r.stream).toBe("stdout");
    expect(r.output).toContain(`Day 12 · ${DOORS[11].command}`);
  });

  it("shows an unlocked past door", () => {
    const r = run(["5"], dec12);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`Day 5 · ${DOORS[4].command}`);
  });

  it("shows the locked message for a future door", () => {
    const r = run(["18"], dec12);
    expect(r.code).toBe(0);
    expect(r.stream).toBe("stdout");
    expect(r.output).toBe(renderLocked(18, plain));
  });

  it.each(["31", "0", "abc", "1.5", "-3", ""])("rejects %j", (arg) => {
    const r = run([arg], dec12);
    expect(r.code).toBe(2);
    expect(r.stream).toBe("stderr");
    expect(r.output).toBe(renderInvalid(arg, plain));
  });

  it("rejects an invalid day even before December", () => {
    const r = run(["31"], at(`${ADVENT_YEAR}-11-20`));
    expect(r.code).toBe(2);
    expect(r.stream).toBe("stderr");
    expect(r.output).toBe(renderInvalid("31", plain));
  });

  it("opens door 1 on December 1 (Paris)", () => {
    const r = run([], at(`${ADVENT_YEAR}-12-01`));
    expect(r.code).toBe(0);
    expect(r.output).toContain(`Day 1 · ${DOORS[0].command}`);
  });

  it("is over on December 25", () => {
    expect(run([], at(`${ADVENT_YEAR}-12-25`))).toEqual({
      code: 0,
      stream: "stdout",
      output: renderOver(plain),
    });
  });

  it("says the calendar has not started before December", () => {
    const nov = at(`${ADVENT_YEAR}-11-20`);
    expect(run([], nov)).toEqual({ code: 0, stream: "stdout", output: renderNotStarted(plain) });
    expect(run(["3"], nov)).toEqual({ code: 0, stream: "stdout", output: renderNotStarted(plain) });
  });

  it("says the calendar is over after Dec 24, but doors stay open", () => {
    const dec26 = at(`${ADVENT_YEAR}-12-26`);
    expect(run([], dec26)).toEqual({ code: 0, stream: "stdout", output: renderOver(plain) });
    expect(run(["18"], dec26).output).toBe(renderDoor(DOORS[17], { palette: plain, width: 80 }));
  });
});

describe("runAdvent --json", () => {
  const json = (positional: string[], now: Date) => {
    const r = run(positional, now, { json: true });
    return { r, body: JSON.parse(r.output) };
  };

  it("emits the door without tipEvidence", () => {
    const { r, body } = json([], dec12);
    expect(r.code).toBe(0);
    expect(body).toEqual({ status: "door", door: publicDoor(DOORS[11]) });
    expect(body.door).not.toHaveProperty("tipEvidence");
    expect(r.output).not.toContain("\x1b");
  });

  it("treats --json=true like --json", () => {
    const r = run([], dec12, { json: "true" });
    expect(JSON.parse(r.output)).toEqual({ status: "door", door: publicDoor(DOORS[11]) });
  });

  it("emits locked", () => {
    expect(json(["18"], dec12).body).toEqual({ status: "locked", day: 18, opensOn: opensOn(18) });
  });

  it("emits not-started", () => {
    expect(json([], at(`${ADVENT_YEAR}-11-20`)).body).toEqual({
      status: "not-started",
      startsOn: `${ADVENT_YEAR}-12-01`,
    });
  });

  it("emits over", () => {
    expect(json([], at(`${ADVENT_YEAR}-12-26`)).body).toEqual({ status: "over" });
  });

  it("emits an error on stdout with code 2", () => {
    const { r, body } = json(["31"], dec12);
    expect(r.code).toBe(2);
    expect(r.stream).toBe("stdout");
    expect(body).toEqual({ status: "error", error: renderInvalid("31", plain) });
  });
});

describe("shouldCheckForUpdate", () => {
  it("skips the update check for advent only", () => {
    expect(shouldCheckForUpdate("advent")).toBe(false);
    expect(shouldCheckForUpdate("resolve")).toBe(true);
    expect(shouldCheckForUpdate(undefined)).toBe(true);
  });
});
