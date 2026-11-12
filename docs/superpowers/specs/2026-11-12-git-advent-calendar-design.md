# Git Advent Calendar — design

**Date:** 2026-11-12
**Deadline:** live on 2026-12-01 (Europe/Paris), site and CLI.
**Language:** English only, both surfaces (user decision).

Decisions the user made are stated plainly. Everything marked **(spec call)** is mine. Check those while reading.

---

## 1. Intent

A Christmas advent calendar: 24 doors, one per day from 1 to 24 December. Each door reveals a **little-known git command**, followed by a short **GitWand tip**.

It serves two people (user's words):
- **a developer discovering GitWand**, who learns something useful and ends up downloading the app;
- **a curious GitWand user**, who learns something about the app they didn't know.

Success means people come back, share the doors, and some newcomers download GitWand.

## 2. Goals, non-goals, anti-goals

**Goals**
- 24 genuinely useful, little-known git commands, each solving a concrete problem.
- Two surfaces fed by one content source: a website page and a CLI command.
- Each day has a shareable URL, so it can be posted daily.

**Non-goals**
- No desktop-app integration this year. The release cycle makes it risky, and it could feel gimmicky.
- No quiz, account, newsletter or server-side state.

**Anti-goals** (user: "un truc trop commercial, des tips qui sonnent pub")
- The tip must never read like an ad. The git command is the gift. The GitWand tip reads like a colleague's advice: "In GitWand, drag a commit onto another to fixup", never "GitWand revolutionizes your workflow!".
- Every tip must be **true** and verifiable in the code. When GitWand has nothing meaningful to add to a command, the door has no tip, or says so honestly ("GitWand doesn't do this (yet)").
- No hype words, exclamation-heavy copy, or pricing/CTA banners inside a door.

## 3. Content

### 3.1 One door
Each door has:
- `day` (1–24)
- `command`, the short title shown on the door once opened, e.g. `git log -L`
- `problem`, one sentence in the reader's voice, e.g. "Who broke this function, and when?"
- `snippet`, a copyable command line
- `explanation`, 1–3 sentences, optionally with a ≤5-line before/after example
- `tip`, optional: the GitWand tip, one or two sentences
- `tipEvidence`, internal only, never rendered: the file(s) that prove the tip is true. Required whenever `tip` is set.

### 3.2 Arc (spec call)
Four themed weeks that build towards GitWand's core, conflicts:
1. **Small gifts** (1–6): everyday shortcuts.
2. **Christmas investigation** (7–12): digging through history.
3. **Rewriting history** (13–18): keeping history clean.
4. **The magic of conflicts** (19–24): GitWand's home turf. **Day 24 is `git rerere`**, paired with GitWand's automatic conflict resolution.

The exact 24 commands and tips are drafted separately in `2026-11-12-git-advent-calendar-content.md`. Claude writes the draft and checks every tip against the code (`tipEvidence`). The user reviews it and adjusts the tone. That content is the critical path: it must be frozen before the release in §6.

### 3.3 Single source of truth
One data module holds the 24 doors. Both the site and the CLI import it, so a fix lands in both. Where it lives, and how the site imports it, is the builder's call. It must not become a runtime dependency of `@gitwand/core` (browser constraint, unrelated concern). A candidate is a small file in `packages/cli` that the website imports at build time, or the reverse.

## 4. Website page

The user chose **layout A, the classic grid**. The mockup is in `.superpowers/brainstorm/` (not committed).

- **Route** `/advent` on the VitePress site. Top: a short title and one line ("24 little-known git commands, one a day until Christmas"), then the grid. Nothing else above the fold.
- **Grid**: 24 doors, 6×4 on desktop. Fewer columns on mobile, with no horizontal scroll. Day 24 is visually special (🎄).
- **Three door states**: *opened* (past days), *today* (highlighted), *locked* (future). Clicking a locked door gives a small shake and "Patience — opens on December 18".
- **Unlock rule**: computed client-side from the current date in **Europe/Paris**. The calendar is the **2026 edition**: the rule compares full dates, not month and day. From 25 December 2026 on, all doors are open **for good, in every later year**, so December 2027 does not lock them again **(spec call)**. A new edition next year would be a new decision. From 25 December 2026, and the page stays as a permanent resource for SEO. Before 1 December, all doors are locked and the page shows a "starts December 1" state. Future content is visible in the page source; we accept that **(spec call)**.
- **Opening a door**: a short opening animation, then the content in a modal over the grid: command, problem, snippet with a **copy** button, explanation, then the tip with a discreet **Download GitWand** link. The modal closes with Esc, a click outside, or a close button. It must be keyboard- and screen-reader-accessible.
- **Per-day URL**: `/advent/<day>` (or `/advent#<day>`, builder's call based on VitePress constraints) opens the grid with that door's modal already open, provided the door is unlocked. Each day gets its **own social preview** (OG title, description and image), because the doors get shared daily. A static OG image per day is fine **(spec call)**.
- **Progress**: "12/24 opened", stored in `localStorage` (wrapped in try/catch, page works without it).
- **Style**: follows the site's existing theme and brand (`website/.vitepress/theme/custom.css`, light and dark), festive but restrained. Respects `prefers-reduced-motion`.
- **Discovery**: link the page from the home announcement (`nt.badge`) and the nav from 1 to 25 December 2026 **(spec call)**. The switch is **date-aware in the browser** and uses the shared unlock logic, so nobody has to redeploy on 1 December or in January. Outside that window, the badge shows its usual content.

## 5. CLI command

`gitwand advent [day]` in `@gitwand/cli`, also usable as `npx @gitwand/cli advent`.

- **No argument**: shows today's door. **`advent 5`**: shows door 5 if unlocked. A future day prints "Patience — door 18 opens on December 18 🎁" and exits 0.
- **Output** (user: "la case du jour en ASCII avec un sapin… simple et efficace"): a small ASCII Christmas tree on the left, the door on the right. Header, day and command, the problem in quotes, the snippet, the explanation, the tip prefixed with 🪄, then a footer `12/24 · all doors: <site>/advent/12`. The mockup agreed in conversation:

```
        ★          🪄 GitWand Advent Calendar
       /*\
      /*o*\        Day 12 · git log -L
     /o*~*o\
    /*~o*~o*\      "Who broke this function, and when?"
       |_|
                   $ git log -L :parseHunk:src/parse.ts

                   Shows every commit that touched that
                   function, with the diff limited to its lines.

   🪄 In GitWand: <verified tip>

   12/24 · all doors: <site>/advent/12
```

- **Colors** degrade cleanly when not a TTY or when `NO_COLOR` is set. On narrow terminals, the tree is dropped rather than wrapping badly **(spec call)**.
- **`--json`**: required by the CLI rules. Prints the door object (without `tipEvidence`), or a JSON error for a locked or invalid day.
- **Outside the season**: before 1 Dec 2026, bare `advent` and `advent <day>` print "starts December 1" with the site link. From 25 Dec 2026 on, bare `advent` prints a short message ("the calendar is over, every door is open: `gitwand advent <1-24>` or <site>/advent"), while `advent <day>` shows any door. Exit code 0 in all these cases. In `--json`, the output is `{ "status": "door" | "locked" | "not-started" | "over", ... }`, with the door object under `door` when `status` is `door` **(spec call)**.
- **Offline**: the content is bundled into the CLI. No network call.
- **Exit codes**: 0 on success or a locked door, 2 on an invalid argument (e.g. `advent 31`), per the CLI's convention.
- **Date**: Europe/Paris, same rule as the site, so both surfaces agree on "today" **(spec call)**. The CLI's npm update check is skipped for `advent`, so the command stays fully offline.
- **QA**: a hidden date override (an env var for the CLI, a query param for the site) lets us test every state before December.

## 6. Constraints

- **Release before Dec 1.** The CLI content ships inside the npm package, so all 24 doors must be final before the tag. A content fix after that needs another release. The site can be fixed any time.
- **A full GitWand release is OK** (user decision). Any tag publishes npm *and* the desktop app, and `bump-version.sh` moves all packages together. Everything on `main` at tag time ships too.
- **Version: 3.13.2** **(spec call)**. `ROADMAP.md` reserves 3.14.0 for Stacked Branches, so the calendar ships as a patch release, with whatever else is merged and ready by then. The tag lands by **Friday 27 November** **(spec call)**, so there's margin for the npm smoke tests, the update manifest and winget before 1 December. The site page ships with the same tag or just before, with its doors locked until Dec 1.
- Monorepo rules apply. Versions go through `./scripts/bump-version.sh`. CHANGELOG and `website/changelog.md` are updated at the tag. Tests must not mock git where git is involved (here it mostly isn't: date logic and rendering are pure).
- `packages/core` is untouched.

## 7. Left to the builder

- The site is static on GitHub Pages (gitwand.app), so per-day URLs are pre-rendered static pages.
- Where the shared data module lives and how the site consumes it.
- VitePress mechanics for per-day URLs and OG tags/images.
- Animation details, exact grid breakpoints, ASCII tree art and colors.
- Test strategy. At least: the unlock logic around the Paris timezone and month boundaries, the CLI's locked/invalid/out-of-season paths, and `--json`.
