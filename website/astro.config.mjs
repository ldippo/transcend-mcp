import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://ldippo.github.io',
  base: '/transcend-mcp',
  integrations: [
    starlight({
      title: 'transcend-mcp',
      description:
        'A code-intelligence MCP server for coding agents: a cheap static map of the repo plus live language-server navigation, bridged.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ldippo/transcend-mcp' },
        {
          icon: 'puzzle',
          label: 'transcend-harness',
          href: 'https://ldippo.github.io/transcend-harness/',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/ldippo/transcend-mcp/edit/main/website/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Start Here',
          items: [{ label: 'Getting Started', slug: 'getting-started' }],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The Two Layers', slug: 'concepts/two-layers' },
            { label: 'Orchestration Policy', slug: 'concepts/orchestration' },
            { label: 'Freshness & Staleness', slug: 'concepts/freshness' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Map Tools', slug: 'reference/map-tools' },
            { label: 'Nav Tools', slug: 'reference/nav-tools' },
            { label: 'The resolve Tool', slug: 'reference/resolve' },
            { label: 'Token Savings', slug: 'reference/metrics' },
            { label: 'Response Envelope', slug: 'reference/envelope' },
          ],
        },
        {
          label: 'Guides',
          items: [{ label: 'Adding a Language', slug: 'guides/add-a-language' }],
        },
        {
          label: 'Internals',
          items: [
            { label: 'Architecture', slug: 'internals/architecture' },
            { label: 'Node IDs', slug: 'internals/node-ids' },
          ],
        },
      ],
    }),
  ],
});
