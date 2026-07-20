---
layout: page
title: GitWand — the Git client that actually resolves conflicts
description: GitWand is a free, open-source, native Git client that auto-resolves 95% of trivial merge conflicts with 8 deterministic patterns — no guessing, no hallucinations. Built with Tauri and Rust, with an MCP server for AI agents. macOS, Linux, Windows.
head:
  - - meta
    - property: og:title
      content: GitWand — the Git client that actually resolves conflicts
  - - meta
    - property: og:description
      content: Free, open-source, native Git client. Auto-resolves merge conflicts deterministically — no hallucinations — with an MCP server for your AI agents.
  - - script
    - type: application/ld+json
    - |
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "GitWand",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "macOS, Linux, Windows",
        "description": "A free, open-source, native Git client that auto-resolves 95% of trivial merge conflicts deterministically, with a per-hunk confidence score and full decision trace. Includes a CLI, a VS Code extension and an MCP server for AI agents.",
        "url": "https://gitwand.app",
        "downloadUrl": "https://github.com/devlint/GitWand/releases",
        "license": "https://opensource.org/licenses/MIT",
        "softwareVersion": "3.6.0",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "author": { "@type": "Organization", "name": "Devlint", "url": "https://github.com/devlint" }
      }
  - - script
    - type: application/ld+json
    - |
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
          { "@type": "Question", "name": "Is GitWand really free?", "acceptedAnswer": { "@type": "Answer", "text": "Yes, GitWand is fully open source under the MIT license. You can use, modify, and redistribute it freely." } },
          { "@type": "Question", "name": "How does smart conflict resolution work?", "acceptedAnswer": { "@type": "Answer", "text": "GitWand analyzes code semantics using 8 deterministic patterns orchestrated by a pattern registry with per-hunk confidence scoring. Trivial conflicts are resolved automatically; complex cases are surfaced with a full explanation trace." } },
          { "@type": "Question", "name": "What is the MCP server and why use it?", "acceptedAnswer": { "@type": "Answer", "text": "The MCP server exposes GitWand's engine to AI agents such as Claude Code, Cursor and Windsurf. It runs locally over stdio, with no API key or network access required." } },
          { "@type": "Question", "name": "Does GitWand work with any Git repository?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. GitWand works with any local Git repository regardless of hosting. The Pull Request view supports GitHub, GitLab, Bitbucket and Azure DevOps." } },
          { "@type": "Question", "name": "What sets GitWand apart from other Git clients?", "acceptedAnswer": { "@type": "Answer", "text": "A built-in deterministic resolution engine, native Tauri architecture (no Electron), three consistent interfaces (desktop, CLI, VS Code), and an MCP server for AI agent integration." } }
        ]
      }
---

<HomeLanding />
