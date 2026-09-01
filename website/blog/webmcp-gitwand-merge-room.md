---
title: "What WebMCP is, and how GitWand built (as far as we can tell) the first Git tool on it"
description: "MCP needs a server and a host app. WebMCP puts the tools on the page itself, callable by any agent already browsing it. What the spec actually does, and how GitWand's new /agent page uses three WebMCP tools to turn a Git conflict into a shared Merge Room for humans and agents."
date: 2026-09-01
head:
  - - meta
    - property: og:title
      content: "What WebMCP is, and how GitWand built (as far as we can tell) the first Git tool on it"
  - - meta
    - property: og:description
      content: "MCP needs a server and a host app. WebMCP puts the tools on the page itself, callable by any agent already browsing it. Here's how GitWand's Merge Room uses it."
  - - meta
    - name: twitter:title
      content: "What WebMCP is, and how GitWand built the first Git tool on it"
---

# What WebMCP is, and how GitWand built (as far as we can tell) the first Git tool on it

We just shipped [gitwand.app/agent](/agent), a page that exposes three Git tools directly to any agent browsing it, no install, no API key, no server. It runs on WebMCP, a spec that's barely a few months old. This post is two things at once: an explanation of what WebMCP actually is (it is not "MCP but in the browser," the mental model most people reach for first), and a walkthrough of what we built on top of it for the [WebMCP Challenge](https://webmcp.devpost.com/).

---

## MCP needs a server. WebMCP doesn't.

The Model Context Protocol, the one most people mean when they say "MCP," is a client-server protocol. Somewhere there's a server process, usually a small binary or a `npx` command, that speaks JSON-RPC over stdio or HTTP. A host application (Claude Code, Claude Desktop, an IDE) launches or connects to that server and exposes its tools to a model. `@gitwand/mcp` is exactly this shape: `claude mcp add gitwand -- npx -y @gitwand/mcp`, and five tools show up.

That model is great for a developer who deliberately installs a tool into their agent's toolbox. It's the wrong shape for a website that wants to say "an agent visiting this page can act on it." There's no server to run, no binary to install, and the whole point is that the capability should exist the moment the page loads, for whichever agent happens to be looking at it.

That's the gap [WebMCP](https://webmachinelearning.github.io/webmcp/) fills. It's a W3C Web Machine Learning Community Group draft that puts an MCP-shaped tool registry directly on the page, reachable through a browser API instead of a network connection. A page calls `document.modelContext.registerTool({ name, description, inputSchema, execute })`, and from that point on, any agent operating in that browser tab, an in-app browser like ChatGPT's, or a WebMCP-enabled build of Chrome, can see and call that tool. No server. No protocol handshake. The tool *is* the page.

A few details worth knowing if you're building on it:

- **The entry point moved.** Early drafts put the registry on `navigator.modelContext`. The spec relocated it to `document.modelContext` on 27 May 2026, the reasoning being that tools belong to a document, not a global navigator object. Chrome 150 deprecated the old location but kept it as an alias to the same underlying object, so you register once and detect which surface exists rather than trying both (registering twice would just double-register every tool).
- **`execute` returns MCP-style content blocks**, `{ content: [{ type: 'text', text: '...' }] }`. The spec doesn't require this exact shape, it will serialize whatever your function resolves to, but MCP clients already know how to parse it, so there's no reason to invent something else.
- **Cancellation is an options argument, not a tool property.** `registerTool(tool, { signal })`, not `{ ...tool, signal }`. Miss that and the tool can never be unregistered, because `ModelContextTool` simply has no `signal` member to read.
- **Most browsers today have none of this.** WebMCP is new enough that "graceful when absent" isn't an edge case, it's the common case. A page that only works with `document.modelContext` present is a page that's broken for almost everyone visiting it.

That last point shaped the whole design of what we built.

---

## What we built: a Merge Room, not a calculator

[/agent](/agent) exposes three tools, backed by the same `@gitwand/core` engine that powers the desktop app, the CLI, and `@gitwand/mcp`:

- **`resolve_conflict`** takes a file with `<<<<<<<` / `=======` / `>>>>>>>` markers and returns it resolved. Hunks that carry no real decision, identical edits on both sides, whitespace, insertions at different positions, generated files, get resolved deterministically. Hunks where the two branches genuinely disagree are *not* resolved. The tool doesn't guess, it says so, with a pattern name, a confidence score, and the reason it declined.
- **`parse_git_error`** takes the raw stderr of a failing git command and returns the cause in plain language plus the exact commands that fix it: rejected pushes, unrelated histories, detached HEAD, a rebase stopped mid-conflict, and the handful of other states that only make sense once you've hit them.
- **`list_cases`** reads the room back. What's filed, what the engine settled, what's still waiting on a person, what that person has already decided.

That third tool is the one that changes the shape of the interaction. Without it, the first two are a calculator: paste something in, get an answer out, nothing persists. With it, an agent can file a conflict, ask the person at the page to pick a side on the one hunk that genuinely needs a human, walk away, and come back later to check whether a decision landed. The room is the shared state between the agent and the human, and it lives on the page, visible to both, not buried in a transcript neither of them can see the other half of.

That's also why every tool call *files into the room* instead of just returning a value. When `resolve_conflict` runs, the page updates in real time: settled hunks show green, the one ambiguous hunk shows two buttons, "Take ours" and "Take theirs," and a running counter at the top says something like "2 settled by the engine, 1 waiting on you." An agent calling the tool from a completely different surface, ChatGPT's in-app browser, say, produces a visible, interactive result on whatever screen the human has open. That's the part that only WebMCP makes possible: MCP tool calls happen inside the client, invisible to anyone not looking at the transcript. WebMCP tool calls happen *on the page*.

## What's deliberately missing

There is no tool that picks a side on a conflicted hunk. Not because it would be hard to build, the engine already has an `llm_proposed` pattern for exactly that in the desktop app, opt-in and off by default, but because the whole pitch of this page is a boundary between what's mechanical and what's a judgment call. Every tool description says it outright: *this tool cannot make that call*. If we shipped a fourth tool that let an agent guess at the ambiguous hunk, the room stops meaning anything, because "waiting on you" would just mean "waiting for whichever model gets there first."

## Degrading on purpose

Almost nobody visiting `/agent` today has a browser with `document.modelContext`. So the page doesn't gate anything behind it. There's a "File a case" panel that runs the exact same `execute` function a WebMCP call would run, wired to a couple of textareas and a button, so a person with an ordinary browser can paste a conflicted file and watch the same room fill up an agent would produce. The page also writes both tool contracts out as plain HTML and JSON-LD `WebAPI`/`potentialAction` markup, so the majority of visitors, human or crawler, who will never execute the registration script still get an accurate description of what the tools do.

If your browser has no WebMCP at all, the banner at the top says exactly that, in plain text, rather than pretending. Honesty about support is cheaper than a broken demo.

## Is this actually the first Git tool on WebMCP?

We can't audit every project entered in the [WebMCP Challenge](https://webmcp.devpost.com/), so we're not going to claim it with more confidence than we have. What we can say: we didn't find another Git-specific tool built on `document.modelContext`/`navigator.modelContext` when we went looking, and GitWand's own server-side MCP tool (`@gitwand/mcp`) predates this page by months, so the underlying resolution engine was already proven before we put a browser-native front door on it. If you know of an earlier one, we'd genuinely like to see it, open an issue.

## How this relates to `@gitwand/mcp`

WebMCP carries callable tools only, no resources, no prompts, no sampling. It's a narrower protocol than full MCP by design, which is exactly right for a zero-install front door: you get three tools and nothing to configure. For the real thing, working against your actual git repository on disk rather than pasted text, that's still `@gitwand/mcp`, five tools and three resources over stdio, wired into Claude Code with one command. `/agent` is the door; the MCP server is the house.

## Try it

Open [gitwand.app/agent](/agent) in a WebMCP-enabled Chrome build, or in ChatGPT's in-app browser, and ask the agent to check it out. Or just use the try-it panel by hand: paste a conflicted file, watch the room fill in, take a side on the one hunk that needs you.

The three tool contracts, full JSON schemas included, are documented at the bottom of the page and in the site's `WebAPI` structured data for anything that reads markup instead of running JavaScript.
