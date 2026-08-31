---
layout: page
title: "GitWand Merge Room — a shared Git workspace for humans and agents"
description: "A WebMCP workspace where a browsing agent files Git conflicts and failures into a shared room. The deterministic engine settles every hunk that carries no decision; the ones where branches genuinely disagree wait for a human. Runs in the tab, no server, no API key."
head:
  - - meta
    - property: og:title
      content: GitWand Merge Room — humans decide, agents accelerate
  - - meta
    - property: og:description
      content: An agent files Git conflicts into a shared room, the engine settles what carries no decision, and you take the calls that matter. No model guesses at your code.
  - - script
    - type: application/ld+json
    - |
      {
        "@context": "https://schema.org",
        "@type": "WebAPI",
        "name": "GitWand Merge Room",
        "description": "A shared Git workspace exposed to browsing agents over the W3C WebMCP standard. Agents file conflicts and failures into a room on the page; the deterministic engine settles the hunks that carry no decision and a human decides the rest. Nothing is uploaded: everything executes in the visitor's browser tab.",
        "documentation": "https://gitwand.app/agent",
        "termsOfService": "https://github.com/devlint/GitWand/blob/main/LICENSE",
        "provider": {
          "@type": "Organization",
          "name": "GitWand",
          "url": "https://gitwand.app"
        },
        "potentialAction": [
          {
            "@type": "Action",
            "name": "parse_git_error",
            "description": "Explain a git command that failed. Takes the raw output of the failing command and returns the cause in plain language plus the commands that resolve it. Covers merge conflicts, rejected pushes, unrelated histories, detached HEAD, interrupted merge or rebase, and authentication failures. Read-only: never runs git.",
            "target": {
              "@type": "EntryPoint",
              "urlTemplate": "https://gitwand.app/agent",
              "actionPlatform": "https://webmachinelearning.github.io/webmcp/"
            }
          },
          {
            "@type": "Action",
            "name": "resolve_conflict",
            "description": "Resolve a file containing git conflict markers. Takes the full conflicted content and an optional file path, returns the merged result plus a per-hunk classification separating the conflicts that carried no decision from the ones needing a human. Deterministic patterns only, no model involved.",
            "target": {
              "@type": "EntryPoint",
              "urlTemplate": "https://gitwand.app/agent",
              "actionPlatform": "https://webmachinelearning.github.io/webmcp/"
            }
          },
          {
            "@type": "Action",
            "name": "list_cases",
            "description": "Read the current state of the Merge Room: every conflict and git error filed so far, which hunks the engine settled deterministically, which are still waiting on a human decision, and which the human has already decided. Takes no arguments.",
            "target": {
              "@type": "EntryPoint",
              "urlTemplate": "https://gitwand.app/agent",
              "actionPlatform": "https://webmachinelearning.github.io/webmcp/"
            }
          }
        ],
        "isRelatedTo": {
          "@type": "SoftwareApplication",
          "name": "@gitwand/mcp",
          "applicationCategory": "DeveloperApplication",
          "url": "https://gitwand.app/guide/mcp"
        }
      }
---

<AgentPage />
