import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'components/**/*.test.tsx', 'tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', '.next/**'],
    globals: false,
  },
});
