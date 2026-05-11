import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'GitWand',
  description: "Git's magic wand — smart conflict resolution & native Git client",
  base: '/',

  sitemap: {
    hostname: 'https://gitwand.devlint.fr',
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    // Open Graph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'GitWand' }],
    ['meta', { property: 'og:image', content: 'https://gitwand.devlint.fr/og-image.png' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    // Twitter / X
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://gitwand.devlint.fr/og-image.png' }],
    // Misc
    ['meta', { name: 'theme-color', content: '#7c3aed' }],
    // Google Search Console verification
    ['meta', { name: 'google-site-verification', content: 'hskwXWiX9CPY24yjaZt8QOYTh0uEQ4VMErKVRiZO7n4' }],
    // Agent discovery — RFC 8288 Link relations (HTML <link> fallback for static hosting)
    ['link', { rel: 'api-catalog', href: '/.well-known/api-catalog', type: 'application/linkset+json' }],
    ['link', { rel: 'service-doc', href: '/guide/mcp', type: 'text/html', title: 'GitWand MCP Server Guide' }],
    ['link', { rel: 'service-doc', href: '/reference/core-api', type: 'text/html', title: 'GitWand Core API Reference' }],
    // WebMCP — expose site tools to AI agents via the browser (navigator.modelContext)
    ['script', {}, `
(function () {
  if (typeof navigator === 'undefined' || !navigator.modelContext) return;
  var ac = new AbortController();
  var signal = ac.signal;

  navigator.modelContext.registerTool({
    name: 'search_gitwand_docs',
    description: 'Search the GitWand documentation for guides, API reference, CLI commands, and blog articles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' }
      },
      required: ['query']
    },
    execute: function (args) {
      var url = 'https://gitwand.devlint.fr/?q=' + encodeURIComponent(args.query);
      return Promise.resolve({ url: url, hint: 'Navigate to this URL to view search results.' });
    },
    signal: signal
  });

  navigator.modelContext.registerTool({
    name: 'get_gitwand_mcp_install',
    description: 'Get the installation instructions and configuration snippet for GitWand MCP server.',
    inputSchema: { type: 'object', properties: {} },
    execute: function () {
      return Promise.resolve({
        npm: 'npx @gitwand/mcp',
        mcpConfig: { command: 'npx', args: ['@gitwand/mcp'] },
        serverCard: 'https://gitwand.devlint.fr/.well-known/mcp/server-card.json',
        guide: 'https://gitwand.devlint.fr/guide/mcp'
      });
    },
    signal: signal
  });

  navigator.modelContext.registerTool({
    name: 'navigate_to_gitwand_section',
    description: 'Get the URL for a GitWand documentation section.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['getting-started', 'desktop', 'cli', 'ai', 'mcp', 'vscode', 'conflict-resolution', 'core-api', 'config', 'cli-commands', 'changelog', 'blog'],
          description: 'Documentation section to navigate to'
        }
      },
      required: ['section']
    },
    execute: function (args) {
      var routes = {
        'getting-started': '/guide/getting-started',
        'desktop': '/guide/desktop',
        'cli': '/guide/cli',
        'ai': '/guide/ai',
        'mcp': '/guide/mcp',
        'vscode': '/guide/vscode',
        'conflict-resolution': '/guide/conflict-resolution',
        'core-api': '/reference/core-api',
        'config': '/reference/config',
        'cli-commands': '/reference/cli-commands',
        'changelog': '/changelog',
        'blog': '/blog/'
      };
      var path = routes[args.section] || '/';
      return Promise.resolve({ url: 'https://gitwand.devlint.fr' + path });
    },
    signal: signal
  });
})();
`],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/core-api' },
      { text: 'Blog', link: '/blog/' },
      { text: "What's new", link: '/changelog' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Desktop App', link: '/guide/desktop' },
            { text: 'CLI', link: '/guide/cli' },
            { text: 'AI integrations', link: '/guide/ai' },
            { text: 'MCP Server', link: '/guide/mcp' },
            { text: 'VS Code Extension', link: '/guide/vscode' },
            { text: 'Conflict Resolution', link: '/guide/conflict-resolution' },
            { text: 'LLM Fallback', link: '/guide/llm-fallback' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Core API', link: '/reference/core-api' },
            { text: 'Configuration', link: '/reference/config' },
            { text: 'CLI Commands', link: '/reference/cli-commands' },
          ],
        },
      ],
      '/blog/': [
        {
          text: 'Blog',
          items: [
            { text: 'All articles', link: '/blog/' },
            { text: 'Why we made LLM resolution opt-in (v2.5)', link: '/blog/v2-5-llm-fallback' },
            { text: 'Hooks, workspaces & agent sessions (v2.7–v2.8)', link: '/blog/agent-sessions-automations-v2-8' },
            { text: 'The state of merge conflict resolution in 2026', link: '/blog/state-of-merge-conflict-resolution-2026' },
            { text: 'Claude Code + GitWand: AI agents & merges', link: '/blog/claude-code-gitwand-ai-agents' },
            { text: 'Auto-merge failure modes', link: '/blog/auto-merge-failure-modes' },
            { text: 'Splitting a commit by hunks (v1.7.0)', link: '/blog/split-commit-by-hunks' },
            { text: 'Worktrees, submodules & auto-update', link: '/blog/worktrees-submodules-auto-update' },
            { text: 'Why I built another Git client', link: '/blog/why-i-built-another-git-client' },
            { text: 'Automatic merge conflict resolution', link: '/blog/automatic-merge-conflict-resolution' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/devlint/GitWand' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 <a href="https://github.com/devlint" target="_blank">Devlint</a>',
    },
  },
})
