---
layout: home

hero:
  name: GitWand
  text: Git's magic wand
  tagline: A fast, native Git client with built-in smart conflict resolution
  image:
    src: /logo.svg
    alt: GitWand
  actions:
    - theme: brand
      text: Download
      link: https://github.com/devlint/GitWand/releases
    - theme: alt
      text: Documentation
      link: /guide/getting-started

features:
  - icon: ⚡
    title: Native Git Client
    details: Built with Tauri 2 and Vue 3. Lightweight, fast, and covers the full daily workflow — staging, commits, branches, push/pull, DAG graph, diff viewer with syntax highlighting.
  - icon: 🧠
    title: Smart Conflict Resolution
    details: 8 resolution patterns with composite confidence scoring. Automatically resolves trivial merge conflicts so you can focus on the ones that matter.
  - icon: 🖥️
    title: Cross-Platform
    details: Desktop app for macOS, Linux, and Windows. CLI for automation and CI pipelines. VS Code extension for inline resolution without leaving your editor.
  - icon: 📄
    title: Format-Aware
    details: Specialized resolvers for JSON and Markdown files. Configurable merge policies via .gitwandrc — prefer-ours, prefer-theirs, prefer-safety, or strict.
---
