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
          decks: resolve(__dirname, 'decks.html'),
          deckEditor: resolve(__dirname, 'deck-editor.html'),
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
