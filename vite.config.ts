import { defineConfig } from 'vite';

// The game folder and the converted assets are large: Vite must neither
// watch nor scan them.
const heavy = ['**/originalgame/**', '**/public/assets/**', '**/public/assets.tmp/**', '**/docs/**'];

export default defineConfig({
  server: {
    port: 5173,
    watch: { ignored: heavy },
  },
  optimizeDeps: { entries: ['index.html'] },
  // Compiled code goes into dist/app/ so it does not mix with the game assets (dist/assets/).
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, assetsDir: 'app' },
});
