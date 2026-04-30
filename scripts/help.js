#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `npm run help` — print the runbook of available scripts.
 *
 * Mirrors the `make help` convention used across the portfolio: a single
 * canonical list of verbs (install, lint, test, coverage, build, package,
 * clean, docs) so contributors and CI invoke the same commands.
 */

const groups = [
  {
    name: 'Setup',
    items: [
      ['install',           'Install all dependencies (npm ci preferred in CI)'],
    ],
  },
  {
    name: 'Develop',
    items: [
      ['watch',             'Rebuild the extension bundle on change (esbuild)'],
      ['compile',           'Type-check the project with tsc --noEmit'],
      ['lint',              'Run ESLint over src/'],
      ['lint:fix',          'Run ESLint with --fix'],
      ['format',            'Format src/ and test/ with Prettier (if configured)'],
    ],
  },
  {
    name: 'Test',
    items: [
      ['test',              'Run all vitest tests'],
      ['test:unit',         'Run unit tests only (test/unit/**)'],
      ['test:integration',  'Run integration tests only (test/integration/**)'],
      ['test:watch',        'Run vitest in watch mode'],
      ['coverage',          'Run tests and emit a v8 coverage report'],
    ],
  },
  {
    name: 'Build & ship',
    items: [
      ['build',             'Build the production bundle (dist/extension.js)'],
      ['package',           'Produce a .vsix with vsce'],
      ['vscode:prepublish', 'Hook used by vsce; runs build'],
    ],
  },
  {
    name: 'Housekeeping',
    items: [
      ['clean',             'Remove dist/, coverage/, .vitest-cache/, *.vsix'],
      ['help',              'Show this list'],
    ],
  },
];

const allItems = groups.flatMap(g => g.items);
const pad = Math.max(...allItems.map(([k]) => k.length)) + 2;

console.log('Terraform Workspace — available npm scripts\n');
for (const group of groups) {
  console.log(`  ${group.name}`);
  for (const [name, desc] of group.items) {
    console.log(`    npm run ${name.padEnd(pad)}${desc}`);
  }
  console.log('');
}
console.log('Run any script with `npm run <name>`.');
