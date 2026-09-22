import { defineConfig } from 'vitest/config';
export default defineConfig({
  server: { host: '127.0.0.1' },
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'], coverage: { provider: 'v8', include: ['server/**/*.ts', 'src/**/*.ts'], exclude: ['server/index.ts', 'src/main.ts'], thresholds: { lines: 80 }, reporter: ['text', 'json-summary', 'html'] } },
});
