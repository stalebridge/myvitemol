import { fileURLToPath, URL } from 'node:url';

export default {
  cacheDir: './.vite_cache',
  resolve: {
    alias: {
      molstar: fileURLToPath(new URL('../Vite_molstar/node_modules/molstar', import.meta.url))
    }
  },
  build: {
    assetsInlineLimit: 0
  },
  server: {
    port: 5174,
    strictPort: false
  },
  preview: {
    port: 4174,
    strictPort: false
  }
};
