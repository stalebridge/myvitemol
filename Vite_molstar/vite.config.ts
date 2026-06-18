import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'datas',
  cacheDir: './.vite_cache',
  server: {
    port: 5173,
    strictPort: false
  },
  preview: {
    port: 4173,
    strictPort: false
  }
});
