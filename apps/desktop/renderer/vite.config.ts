import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The renderer is loaded by the Electron shell from a file:// URL, so assets are relative.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
