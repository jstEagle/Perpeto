/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Design tokens (packages/design-tokens) and brand assets live outside this
// app; allow Vite to read them from the repository root.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: false, fs: { allow: [repoRoot] } },
  preview: { port: 5181 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
