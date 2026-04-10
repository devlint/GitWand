import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'GitWand',
  description: "Git's magic wand — smart conflict resolution & native Git client",
  base: '/GitWand/',

  head: [
    ['link', { rel: 'icon', href: '/GitWand/logo.svg' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/core-api' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Desktop App', link: '/guide/desktop' },
            { text: 'CLI', link: '/guide/cli' },
            { text: 'VS Code Extension', link: '/guide/vscode' },
            { text: 'Conflict Resolution', link: '/guide/conflict-resolution' },
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
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/devlint/GitWand' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Laurent Guitton',
    },
  },
})
