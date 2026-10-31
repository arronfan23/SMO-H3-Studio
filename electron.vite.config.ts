import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
    },
  },
  // Sandboxed preload scripts must remain CommonJS; the main process stays ESM.
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      lib: {
        formats: ['cjs'],
      },
      rolldownOptions: {
        output: {
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    publicDir: resolve(import.meta.dirname, 'public'),
    build: {
      outDir: 'dist/renderer',
    },
  },
});
