import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    globals: false,
    environment: 'node',
    // The extension code imports `vscode` at module load. Tests stub it via
    // an alias so logic-only modules can be exercised without spinning up the
    // VS Code test electron host.
    alias: {
      vscode: new URL('./test/unit/vscode.stub.ts', import.meta.url).pathname,
    },
  },
});
