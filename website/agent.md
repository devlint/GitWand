---
layout: page
title: "GitWand for agents — WebMCP git tools, no install"
description: "A WebMCP page that hands any browsing agent two read-only git tools. One explains a failing git command, the other resolves a conflicted file with GitWand's deterministic engine. Runs in the tab, no server, no API key."
head:
  - - meta
    - property: og:title
      content: GitWand for agents — callable git tools over WebMCP
  - - meta
    - property: og:description
      content: Two read-only git tools any agent can call straight from the page. Deterministic conflict resolution, no model in the loop, no install.
  - - script
    - type: application/ld+json
    - |
      {
        "@context": "https://schema.org",
        "@type": "WebAPI",
        "name": "GitWand agent tools",
        "description": "Read-only git tools exposed to browsing agents over the W3C WebMCP standard. Nothing is uploaded: the tools execute in the visitor's browser tab.",
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
