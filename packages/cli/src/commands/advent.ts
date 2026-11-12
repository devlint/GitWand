/**
 * Commande `gitwand advent [day]` — opens a door of the Git Advent Calendar.
 *
 * `runAdvent` is pure (date, width and palette are injected) so it can be
 * tested without a terminal; `cmdAdvent` only wires it to the process.
 */

import {
  ADVENT_YEAR,
  DOORS,
  DOOR_COUNT,
  calendarState,
  isUnlocked,
  opensOn,
  parseDateOverride,
  publicDoor,
} from "../advent/index.js";
import {
  renderDoor,
  renderInvalid,
  renderLocked,
  renderNotStarted,
  renderOver,
  type Palette,
} from "../advent-render.js";
import { c } from "../ui.js";

export type AdventResult = { code: 0 | 2; stream: "stdout" | "stderr"; output: string };

/** JSON output never carries ANSI, whatever palette the caller holds. */
const PLAIN: Palette = {
  reset: "",
  bold: "",
  dim: "",
  green: "",
  yellow: "",
  red: "",
  cyan: "",
  magenta: "",
};

/** A day is a plain positive integer string within 1..DOOR_COUNT. */
function parseDay(arg: string): number | null {
  if (!/^\d+$/.test(arg)) return null;
  const day = Number(arg);
  return day >= 1 && day <= DOOR_COUNT ? day : null;
}

export function runAdvent(
  positional: string[],
  flags: Record<string, boolean | string>,
  ctx: { now: Date; width: number; palette: Palette },
): AdventResult {
  const json = flags.json === true || flags.json === "true";
  const p = json ? PLAIN : ctx.palette;
  const out = (code: 0 | 2, stream: "stdout" | "stderr", human: string, body: object): AdventResult => ({
    code,
    stream: json ? "stdout" : stream,
    output: json ? JSON.stringify(body, null, 2) : human,
  });

  const arg = positional[0];
  const state = calendarState(ctx.now);

  let day: number;
  if (arg === undefined) {
    if (state.phase === "not-started") {
      return out(0, "stdout", renderNotStarted(p), {
        status: "not-started",
        startsOn: `${ADVENT_YEAR}-12-01`,
      });
    }
    if (state.phase === "over") {
      return out(0, "stdout", renderOver(p), { status: "over" });
    }
    day = state.today;
  } else {
    const parsed = parseDay(arg);
    if (parsed === null) {
      return out(2, "stderr", renderInvalid(arg, p), {
        status: "error",
        error: renderInvalid(arg, PLAIN),
      });
    }
    if (state.phase === "not-started") {
      return out(0, "stdout", renderNotStarted(p), {
        status: "not-started",
        startsOn: `${ADVENT_YEAR}-12-01`,
      });
    }
    if (!isUnlocked(parsed, ctx.now)) {
      return out(0, "stdout", renderLocked(parsed, p), {
        status: "locked",
        day: parsed,
        opensOn: opensOn(parsed),
      });
    }
    day = parsed;
  }

  const door = DOORS[day - 1];
  return out(0, "stdout", renderDoor(door, { palette: p, width: ctx.width }), {
    status: "door",
    door: publicDoor(door),
  });
}

export async function cmdAdvent(
  positional: string[],
  flags: Record<string, boolean | string>,
): Promise<void> {
  const now = parseDateOverride(process.env.GITWAND_ADVENT_DATE) ?? new Date();
  // Piped output gets no colour even when NO_COLOR/CI are unset.
  const palette = process.stdout.isTTY ? c : PLAIN;
  const result = runAdvent(positional, flags, {
    now,
    width: process.stdout.columns ?? 80,
    palette,
  });
  const stream = result.stream === "stdout" ? process.stdout : process.stderr;
  stream.write(result.output + "\n", () => process.exit(result.code));
}
