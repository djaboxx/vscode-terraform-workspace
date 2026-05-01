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
    // Diagnosable failure output: in CI, also emit JUnit XML and surface
    // failures as GitHub-Actions annotations so PR reviewers see them inline.
    reporters: process.env.CI
      ? [
          ['default', { summary: false }],
          ['junit', { outputFile: 'coverage/junit.xml' }],
          ['github-actions'],
        ]
      : ['default'],
    // Surface slow tests so regressions are visible.
    slowTestThreshold: 500,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Skip surfaces that are either pure VS Code wiring (un-testable without
      // an extension host) or generated/declaration files. Keep this list
      // narrow — anything excluded here gets zero accountability.
      exclude: [
        'src/extension.ts',                     // pure VS Code activate() wiring
        'src/services.ts',                      // DI bootstrap
        'src/types/**',                         // type-only
        'src/views/**',                         // webview/tree UI — covered by vscode integration suite
        'src/chat/TerraformChatParticipant.ts', // chat participant — covered by vscode integration suite
        'src/agent/ProactiveAgent.ts',          // bg poller wired to vscode events
        'src/agent/AgentRunner.ts',             // wires lm.invokeTool — needs vscode host
        'src/tools/TerraformTools.ts',          // LM tool registration — covered by toolInvocation.test
        '**/*.d.ts',
      ],
      // Ratchet thresholds. These are set just below the current baseline so
      // any regression fails CI; raise them as new tests land. Goal: 70/65/60.
      // Current baseline (2026-04-30): lines 38.60 / stmts 37.56 / fns 42.48 / br 37.29.
      thresholds: {
        lines: 38,
        statements: 37,
        functions: 42,
        branches: 37,
      },
      reportOnFailure: true,
    },
  },
});
