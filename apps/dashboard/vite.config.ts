import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * VITE VERSION IS PINNED TO 5.x DELIBERATELY.
 *
 * `vitest` in the backend workspace depends on Vite 5, which npm hoists to the workspace
 * root. If the frontend asks for Vite 6, npm installs a second nested copy — and then
 * `@vitejs/plugin-react` resolves against the hoisted 5 while this file's `defineConfig`
 * resolves against the nested 6. The two `Plugin` types are structurally incompatible and
 * the build fails with a twenty-line structural mismatch that says nothing about the actual
 * cause.
 *
 * One Vite major across the workspace avoids the whole class of problem. Revisit only when
 * vitest moves to Vite 6, and move both at once.
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },

  server: {
    port: 5173,
    strictPort: true,
    /**
     * Proxy the API in development.
     *
     * Same-origin requests in dev mean no CORS preflight on every call and, more usefully,
     * that the production and development request paths are identical — so a cookie or
     * header problem cannot hide behind a CORS difference until deployment.
     */
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/health': { target: 'http://localhost:4000', changeOrigin: true },
      '/realtime': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Split the heavy, rarely-changing dependencies into their own chunks.
         *
         * Recharts is the bulk of the bundle and changes only on dependency upgrades, so
         * keeping it separate means an application deploy invalidates a fraction of the cache
         * rather than all of it.
         */
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-charts': ['recharts'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
});
