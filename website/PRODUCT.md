# PRODUCT.md — GitWand website

## Register

**Hybrid, split by a hard boundary.** `/agent` is the surface this file was written for.

- **Above the break: product.** The Merge Room is a real tool doing real work, in the browser, for whoever is standing there. Design serves the task.
- **Below the break: brand.** Explanation, tool contracts, positioning. Design carries the argument.

The break is deliberate and visible. The previous version interleaved the two, which is what made the page read as muddled: a diagnostic panel with a section heading of its own, sitting between the workspace and the copy, competing with both.

Other site surfaces (`/`, `/conflict-engine`, `/features`) are brand.

## What the product is

GitWand resolves the Git merge conflicts that were never decisions, deterministically, and refuses the ones that were. Twelve patterns in a classifier registry, eight of which auto-apply, each resolution carrying a pattern name, a composite confidence score and a full decision trace. No model touches the code.

`/agent` exposes that engine to browsing agents over the W3C WebMCP standard, as three page-registered tools. An agent files conflicts and Git failures into a shared room; the engine settles what carries no decision; every hunk where the two branches genuinely disagree waits for a person.

## Users

- **Primary, above the break:** a developer mid-incident, or an agent acting for one. They are in a task and want it over with. Density and legibility beat charm.
- **Secondary, below the break:** someone evaluating whether this is real, including hackathon judges reading for three minutes and engineers deciding whether to install anything.

## The one idea

**A boundary, made visible.** What a machine may settle, and what only a person may decide. That line is the product, not a feature of it, so it is the page's primary visual structure rather than a message written on top of one.

Everything follows from it: settled work is quiet and recedes, open work is the only thing carrying weight and colour, and the page is honest about which is which at a glance.

## Brand personality

Exact, unshowy, quietly confident. It states what it measured and declines to claim the rest. The tone is a good colleague's: direct, specific, no salesmanship. Where every competitor says the AI will handle it, this one says the opposite and shows its work.

## Anti-references

Confirmed with the user, all four:

- **Not another SaaS template.** No hero-metric block (big number, small label, repeat). No grid of identical icon-heading-text cards. No gradient text.
- **Not terminal-hacker.** No phosphor green on black, no fake blinking prompt, no monospace as a personality. Monospace is for code and identifiers only. This is the obvious trap for a Git tool and it is the first-order reflex.
- **Not glass and haze.** No decorative backdrop-filter, no ambient halos. Effects earn a specific moment or they do not ship.
- **Not timid.** The inverse risk, and the one the user named last: a correct page nobody remembers. Commit to the structural device and the type scale.

Second-order check: for a Git tool that is *not* terminal-dark, the next reflex is editorial-typographic (display serif, ruled columns, mono metadata). Also rejected. The lane here is instrument-like: a measuring device, not a magazine.

## Motion policy

Concentrated on the two moments that carry meaning, per the user: a case arriving, and a hunk being decided. Nothing ambient, no page-load choreography, no scroll-triggered section reveals. 150-250ms, ease-out. Every transition has a `prefers-reduced-motion` alternative, and no content is gated behind a reveal.

## Accessibility

Body text ≥4.5:1, large text ≥3:1, verified rather than assumed. State is never carried by colour alone: settled, waiting and decided each have a word as well as a hue. Every control reachable and visible by keyboard.

## Identity constraints

The site has shipped brand colours; identity preservation wins over any fresh palette. Purple `#8B5CF6` / `#7C3AED` is the brand, green `#10B981` reads settled, amber `#fbbf24` reads waiting on you, ground is `#0c0c1a`. Inter for everything structural, JetBrains Mono for code and identifiers.
