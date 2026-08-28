import { defineConfig } from 'vitepress'
import { extractFaq } from './seo'
import { fileURLToPath } from 'node:url'


export default defineConfig({
  title: 'GitWand',
  description: "Git's magic wand — smart conflict resolution & native Git client",
  base: '/',

  // The generated sitemap advertised /features.html while every canonical tag
  // points at /features — two URL forms for one page, which is the mismatch the
  // canonical block below exists to avoid. cleanUrls makes VitePress emit the
  // extensionless form everywhere, sitemap included. GitHub Pages already serves
  // /foo as /foo.html with a 200 and no redirect, which is what this requires.
  cleanUrls: true,

  vite: {
    resolve: {
      alias: {
        // Point at the TypeScript source rather than packages/core/dist.
        // deploy-website.yml runs `pnpm install` and builds the site directly,
        // with no `pnpm --filter @gitwand/core build` step, so dist/ does not
        // exist in CI. Same reasoning as apps/desktop/vite.config.ts.
        '@gitwand/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        // Mark Node built-ins external so Rollup can parse packages/core's
        // node adapter (structural/parsers/adapters/node.ts) without trying to
        // resolve it. The adapter is behind a dynamic import reached only when
        // env === "node", which never happens in a browser, so it is dead code
        // here. Without this, the build fails on `createRequire` from
        // node:module. Same fix as apps/desktop/vite.config.ts.
        external: (id: string) => id.startsWith('node:'),
      },
    },
  },

  sitemap: {
    hostname: 'https://gitwand.app',
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    // Open Graph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'GitWand' }],
    ['meta', { property: 'og:image', content: 'https://gitwand.app/og-image.png' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    // Twitter / X
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://gitwand.app/og-image.png' }],
    // Misc
    ['meta', { name: 'theme-color', content: '#7c3aed' }],
    // Google Search Console verification
    ['meta', { name: 'google-site-verification', content: 'hskwXWiX9CPY24yjaZt8QOYTh0uEQ4VMErKVRiZO7n4' }],
    // Agent discovery — RFC 8288 Link relations (HTML <link> fallback for static hosting)
    ['link', { rel: 'api-catalog', href: '/.well-known/api-catalog', type: 'application/linkset+json' }],
    ['link', { rel: 'service-doc', href: '/guide/mcp', type: 'text/html', title: 'GitWand MCP Server Guide' }],
    ['link', { rel: 'service-doc', href: '/reference/core-api', type: 'text/html', title: 'GitWand Core API Reference' }],
    // WebMCP — expose site tools to AI agents via the browser.
    // The spec puts the entry point on document.modelContext; Chrome 150
    // deprecated navigator.modelContext but kept it as an ALIAS to the same
    // object, with removal announced. So: prefer document, fall back to
    // navigator, and register ONCE. Registering on both would duplicate every
    // tool on the versions that still expose both names.
    ['script', {}, `
(function () {
  var mc = (typeof document !== 'undefined' && document.modelContext) ||
           (typeof navigator !== 'undefined' && navigator.modelContext) || null;
  if (!mc) return;
  var ac = new AbortController();
  var opts = { signal: ac.signal };

  mc.registerTool({
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
      var url = 'https://gitwand.app/?q=' + encodeURIComponent(args.query);
      return Promise.resolve({ url: url, hint: 'Navigate to this URL to view search results.' });
    },
  }, opts);

  mc.registerTool({
    name: 'get_gitwand_mcp_install',
    description: 'Get the installation instructions and configuration snippet for GitWand MCP server.',
    inputSchema: { type: 'object', properties: {} },
    execute: function () {
      return Promise.resolve({
        npm: 'npx @gitwand/mcp',
        mcpConfig: { command: 'npx', args: ['@gitwand/mcp'] },
        serverCard: 'https://gitwand.app/.well-known/mcp/server-card.json',
        guide: 'https://gitwand.app/guide/mcp'
      });
    },
  }, opts);

  mc.registerTool({
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
      return Promise.resolve({ url: 'https://gitwand.app' + path });
    },
  }, opts);
})();
`],
  ],

  // Every page gets a self-referencing canonical URL (and matching og:url), which is what
  // Search Console's "Duplicate without user-selected canonical" flag is asking for — without
  // it, Google has to guess between whatever URL variants (with/without trailing slash, with/
  // without .html) happen to serve the same content. A page that already sets its own
  // `rel: canonical` in frontmatter (e.g. a post cross-posted from elsewhere, pointing back at
  // the original) is left alone instead of getting a conflicting second canonical tag.
  transformPageData(pageData) {
    const hasOwnCanonical = (pageData.frontmatter.head || []).some(
      ([tag, attrs]: [string, Record<string, string>]) => tag === 'link' && attrs?.rel === 'canonical'
    )

    const canonicalUrl = `https://gitwand.app/${pageData.relativePath}`
      .replace(/\/?index\.md$/, '/')
      .replace(/\.md$/, '')

    pageData.frontmatter.head ??= []
    // A page that already declares its own canonical (a post cross-posted from
    // elsewhere, pointing back at the original) keeps it — but it still gets the
    // structured data below. An earlier version of this returned here, which
    // silently left that one page with no JSON-LD at all.
    if (!hasOwnCanonical) {
      pageData.frontmatter.head.push(
        ['link', { rel: 'canonical', href: canonicalUrl }],
        ['meta', { property: 'og:url', content: canonicalUrl }],
      )
    }

    // ── Structured data, generated rather than hand-maintained ────────────────
    // Only the home page carried JSON-LD before this. Two schemas are worth
    // emitting site-wide, and both are fully derivable from page data, so they
    // belong here instead of in 30-odd frontmatter blocks that would drift.
    const SECTIONS: Record<string, string> = {
      guide: 'Guide',
      reference: 'Reference',
      compare: 'Compare',
      blog: 'Blog',
      fix: 'Fix a conflict',
    }
    const [segment] = pageData.relativePath.split('/')
    const section = SECTIONS[segment]

    // BreadcrumbList — tells Google the site's shape and earns the breadcrumb
    // trail in the SERP instead of a bare URL. Emitted on every page below the
    // root; the home page is the trail's own first item.
    if (section) {
      const isSectionIndex = /(^|\/)index\.md$/.test(pageData.relativePath)
      const itemListElement: unknown[] = [
        { '@type': 'ListItem', position: 1, name: 'GitWand', item: 'https://gitwand.app/' },
        { '@type': 'ListItem', position: 2, name: section, item: `https://gitwand.app/${segment}/` },
      ]
      if (!isSectionIndex) {
        itemListElement.push({
          '@type': 'ListItem',
          position: 3,
          name: pageData.title || pageData.frontmatter.title,
          item: canonicalUrl,
        })
      }
      pageData.frontmatter.head.push([
        'script',
        { type: 'application/ld+json' },
        JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement }),
      ])
    }

    // BlogPosting — every post already has a title, description and date in its
    // frontmatter; without this markup Google has to infer authorship and
    // publication date, and answer engines cite the post without attribution.
    // Skipped when the page declares an external canonical: claiming a BlogPosting
    // at this URL would contradict the canonical, which says the original lives
    // somewhere else. The breadcrumb above is navigational and stays either way.
    if (segment === 'blog' && !hasOwnCanonical && !/(^|\/)index\.md$/.test(pageData.relativePath)) {
      const date = pageData.frontmatter.date
      pageData.frontmatter.head.push([
        'script',
        { type: 'application/ld+json' },
        JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: pageData.frontmatter.title || pageData.title,
          description: pageData.frontmatter.description || pageData.description,
          url: canonicalUrl,
          mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
          ...(date ? { datePublished: new Date(date).toISOString().slice(0, 10) } : {}),
          image: 'https://gitwand.app/og-image.png',
          author: { '@type': 'Organization', name: 'Devlint', url: 'https://github.com/devlint' },
          publisher: {
            '@type': 'Organization',
            name: 'GitWand',
            url: 'https://gitwand.app/',
            logo: { '@type': 'ImageObject', url: 'https://gitwand.app/logo.svg' },
          },
          isPartOf: { '@type': 'Blog', name: 'GitWand Blog', url: 'https://gitwand.app/blog/' },
        }),
      ])
    }

    // FAQPage — the /compare/* pages and /guide/llm-fallback each end in an
    // "## FAQ" section of "### question" + answer. Those are exactly the blocks
    // that win featured snippets on "gitwand vs X" / "is GitWand free" queries,
    // and they were shipping as plain prose. Parsed from the source file so the
    // markup can never drift from the visible copy.
    const faq = extractFaq(pageData.filePath)
    if (faq.length) {
      pageData.frontmatter.head.push([
        'script',
        { type: 'application/ld+json' },
        JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map((qa) => ({
            '@type': 'Question',
            name: qa.q,
            acceptedAnswer: { '@type': 'Answer', text: qa.a },
          })),
        }),
      ])
    }
  },

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      {
        text: 'Product',
        items: [
          { text: 'Features', link: '/features' },
          { text: 'Conflict engine', link: '/conflict-engine' },
          { text: 'AI & agents', link: '/ai-agents' },
          { text: 'Compare', link: '/compare/' },
        ],
      },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Fix a conflict', link: '/fix/' },
      { text: 'Reference', link: '/reference/core-api' },
      { text: 'Blog', link: '/blog/' },
      { text: "What's new", link: '/changelog' },
      { text: "Sponsoring", link: 'https://github.com/sponsors/devlint' },
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
      '/fix/': [
        {
          text: 'Fix a Git conflict',
          items: [
            { text: 'All guides', link: '/fix/' },
            { text: 'Merge conflict in a file', link: '/fix/merge-conflict-in-file' },
            { text: 'Lockfile conflicts', link: '/fix/package-lock-json-merge-conflict' },
            { text: 'Rebase repeats the same conflict', link: '/fix/rebase-same-conflict-every-commit' },
            { text: 'git rerere explained', link: '/fix/git-rerere' },
          ],
        },
      ],
      '/compare/': [
        {
          text: 'Compare',
          items: [
            { text: 'All comparisons', link: '/compare/' },
            { text: 'vs GitKraken', link: '/compare/gitwand-vs-gitkraken' },
            { text: 'vs Fork', link: '/compare/gitwand-vs-fork' },
            { text: 'vs Sublime Merge', link: '/compare/gitwand-vs-sublime-merge' },
            { text: 'vs GitHub Desktop', link: '/compare/gitwand-vs-github-desktop' },
            { text: 'vs GitButler', link: '/compare/gitwand-vs-gitbutler' },
          ],
        },
      ],
      '/blog/': [
        {
          text: 'Blog',
          items: [
            { text: 'All articles', link: '/blog/' },
            { text: 'Best Git GUI clients in 2026', link: '/blog/best-git-gui-clients-2026' },
            { text: 'From four tools to one', link: '/blog/from-four-tools-to-one' },
            { text: 'Why GitWand is Rust, not Electron', link: '/blog/why-gitwand-is-rust-not-electron' },
            { text: 'PR Review 2.0 + secrets scanner (v3.5)', link: '/blog/v3-5-pr-review-2-secrets-scanner' },
            { text: 'Integrated terminal + one-click AI tasks (v3.2)', link: '/blog/v3-2-integrated-terminal-ai-tasks' },
            { text: 'Changes tree view + interactive rebase fix (v2.23)', link: '/blog/v2-23-changes-tree-view' },
            { text: 'Scratch worktree + rebase/cherry-pick predictor (v2.20)', link: '/blog/v2-20-scratch-worktree-conflict-predictor' },
            { text: 'GitHub & Azure DevOps sign-in, cross-fork PRs (v2.19)', link: '/blog/v2-19-github-oauth-azure' },
            { text: 'Forge completeness: inline discussions, CI checks (v2.14)', link: '/blog/v2-14-forge-completeness' },
            { text: 'AI code review in your PR diff (v2.13)', link: '/blog/v2-13-ai-inline-suggestions' },
            { text: 'GitHub, GitLab & Bitbucket support (v2.10)', link: '/blog/v2-10-forge-integrations' },
            { text: "Launchpad: cross-repo dashboard (v2.9)", link: '/blog/v2-9-launchpad' },
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
