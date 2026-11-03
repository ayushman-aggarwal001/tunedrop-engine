import { defineConfig } from 'vite';

export default defineConfig({
  base: '/tunedrop-engine/',
  build: {
    outDir: 'dist',
    target: 'esnext'
  }
});
