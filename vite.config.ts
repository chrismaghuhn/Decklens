// ==================== Vite Configuration ====================
// Builds DeckLens with proper module bundling
// Source: decklens-audit-report-v4.3.md L550-603

import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'path';
import type { IncomingMessage } from 'http';

/**
 * Mirrors public/_redirects rewrites for Vite dev server.
 * In production, Cloudflare Pages handles these via _redirects.
 */
function decklensSpaRewrites(): Plugin {
  return {
    name: 'decklens-spa-rewrites',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, _res, next) => {
        const url = req.url || '';
        const path = url.split('?')[0];

        if (path.startsWith('/decks/id/')) {
          req.url = '/deck-editor.html' + (url.includes('?') ? '?' + url.split('?')[1] : '');
        } else if (path === '/decks/public' || path === '/decks/public/') {
          req.url = '/decks-public.html';
        } else if (path.startsWith('/d/')) {
          req.url = '/deck-public.html';
        } else if (path === '/dashboard' || path === '/dashboard/') {
          req.url = '/dashboard-hub.html';
        } else if (path === '/dashboard/executive' || path === '/dashboard/executive/') {
          req.url = '/executive-dashboard.html';
        } else if (path === '/dashboard/growth' || path === '/dashboard/growth/') {
          req.url = '/growth-dashboard.html';
        } else if (path === '/dashboard/technical' || path === '/dashboard/technical/') {
          req.url = '/technical-dashboard.html';
        } else if (path === '/dashboard/community' || path === '/dashboard/community/') {
          req.url = '/community-dashboard.html';
        } else if (path === '/dashboard/public' || path === '/dashboard/public/') {
          req.url = '/public-dashboard.html';
        } else if (path === '/deckhub' || path.startsWith('/deckhub/')) {
          req.url = '/deckhub.html' + (url.includes('?') ? '?' + url.split('?')[1] : '');
        } else if (path === '/simulator' || path === '/simulator/' || path.startsWith('/simulator/')) {
          req.url = '/rules-engine.html';
        }
        // /play route disabled - WIP
        // else if (path === '/play' || path === '/play/' || path.startsWith('/play/')) {
        //   req.url = '/play-vs-bot.html';
        // }

        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const deckProxyTarget = env.VITE_DECK_PROXY_TARGET?.trim();

  return {
    root: '.',
    // Use absolute paths so URL rewrites (e.g. /decks/id/xxx → deck-editor.html) work correctly
    base: '/',
    publicDir: 'public',
    plugins: [decklensSpaRewrites()],
    build: {
      outDir: 'dist',
      rollupOptions: {
        external: ['fs', 'path'],
        input: {
          index: resolve(__dirname, 'index.html'),
          mtg: resolve(__dirname, 'mtg.html'),
          yugioh: resolve(__dirname, 'yugioh.html'),
          community: resolve(__dirname, 'community.html'),
          decks: resolve(__dirname, 'decks.html'),
          deckEditor: resolve(__dirname, 'deck-editor.html'),
          decksPublic: resolve(__dirname, 'decks-public.html'),
          deckPublic: resolve(__dirname, 'deck-public.html'),
          dashboardHub: resolve(__dirname, 'dashboard-hub.html'),
          executiveDashboard: resolve(__dirname, 'executive-dashboard.html'),
          growthDashboard: resolve(__dirname, 'growth-dashboard.html'),
          technicalDashboard: resolve(__dirname, 'technical-dashboard.html'),
          communityDashboard: resolve(__dirname, 'community-dashboard.html'),
          publicDashboard: resolve(__dirname, 'public-dashboard.html'),
          deckhub: resolve(__dirname, 'deckhub.html'),
          rulesEngine: resolve(__dirname, 'rules-engine.html'),
          // playVsBot: resolve(__dirname, 'play-vs-bot.html'), // WIP - not ready
          // trainBot: resolve(__dirname, 'train-bot.html'), // WIP - not ready
        },
      },
      // SECURITY: Disable sourcemaps in production
      sourcemap: mode === 'development',
      minify: mode === 'production' ? 'esbuild' : false,
      target: 'esnext',
    },
    server: {
      port: 3000,
      open: true,
      proxy: deckProxyTarget
        ? {
            '/api': {
              target: deckProxyTarget,
              changeOrigin: true,
              secure: true,
            },
          }
        : undefined,
    },
    preview: {
      port: 5000,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@mtg/game-engine': resolve(__dirname, 'packages/game-engine/src/index.ts'),
        '@mtg/bot-core': resolve(__dirname, 'packages/bot-core/src/index.ts'),
        '@mtg/bot-ml': resolve(__dirname, 'packages/bot-ml/src/index.ts'),
        '@mtg/card-data': resolve(__dirname, 'packages/card-data/src/index.ts'),
        '@mtg': resolve(__dirname, 'src/mtg'),
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
  };
});
