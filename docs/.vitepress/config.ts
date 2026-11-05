import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

// The nav version comes from the root package.json — as a hand-maintained string
// it went stale on the very next release.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
) as { version: string };

const site = 'https://imap-mcp.ni-c.de';
const description = 'An MCP server for any IMAP mailbox: find the mail, read it, file it — with every message fenced as untrusted content and the write tools off unless you turn them on.';

export default defineConfig({
  title: 'imap-mcp',
  description,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: site },

  head: [
    // NOTE: head entries are NOT rewritten with `base` — keep these paths absolute
    // and correct by hand.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#4f46e5' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'imap-mcp' }],
    ['meta', { property: 'og:title', content: 'imap-mcp' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { property: 'og:image', content: `${site}/og.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${site}/og.png` }],
  ],

  themeConfig: {
    siteTitle: 'imap-mcp',

    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/tools', activeMatch: '/reference/' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: '/reference/changelog' },
          { text: 'Releases', link: 'https://github.com/ni-c/imap-mcp/releases' },
          { text: 'npm package', link: 'https://www.npmjs.com/package/@ni-c/imap-mcp' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is imap-mcp?', link: '/guide/' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Connecting clients', link: '/guide/clients' },
          ],
        },
        {
          text: 'Operating it',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Asking a person', link: '/guide/approval' },
            { text: 'Security', link: '/guide/security' },
            { text: 'FAQ & troubleshooting', link: '/guide/faq' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Tools', link: '/reference/tools' },
            { text: 'Environment variables', link: '/reference/environment' },
            { text: 'Changelog', link: '/reference/changelog' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/ni-c/imap-mcp' },
      {
        icon: {
          svg: '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.625 1.499c-2.32 0-4.354 1.203-5.625 3.03-1.271-1.827-3.305-3.03-5.625-3.03C3.129 1.499 0 4.253 0 8.249c0 4.275 3.068 7.847 5.828 10.227a33.14 33.14 0 0 0 5.616 3.876l.028.017.008.003-.001.003c.163.085.342.126.521.125.179.001.358-.041.521-.125l-.001-.003.008-.003.028-.017a33.14 33.14 0 0 0 5.616-3.876C20.932 16.096 24 12.524 24 8.249c0-3.996-3.129-6.75-6.375-6.75zm-.919 15.275a30.766 30.766 0 0 1-4.703 3.316l-.004-.002-.004.002a30.955 30.955 0 0 1-4.703-3.316c-2.677-2.307-5.047-5.298-5.047-8.523 0-2.754 2.121-4.5 4.125-4.5 2.06 0 3.914 1.479 4.544 3.684.143.495.596.797 1.086.796.49.001.943-.302 1.085-.796.63-2.205 2.484-3.684 4.544-3.684 2.004 0 4.125 1.746 4.125 4.5 0 3.225-2.37 6.216-5.048 8.523z"/></svg>',
        },
        link: 'https://github.com/sponsors/ni-c',
        ariaLabel: 'Sponsor',
      },
    ],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/ni-c/imap-mcp/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    outline: { level: [2, 3] },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Willi Thiel',
    },
  },

  markdown: {
    // The *-default variants darken comments enough to clear 4.5:1 against the
    // code background; plain github-light lands just under it.
    theme: { light: 'github-light-default', dark: 'github-dark-default' },
  },
});
