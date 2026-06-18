import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: './.vite_cache',
  publicDir: 'public',
  server: {
    port: 5174,
    strictPort: false
  },
  preview: {
    port: 4174,
    strictPort: false
  }
});
