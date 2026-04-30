const esbuild = require('esbuild');
const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  // Native + WASM-loading modules must remain external so they resolve their
  // own platform-specific assets at runtime instead of being inlined by esbuild.
  external: ['vscode', 'better-sqlite3', 'libsodium-wrappers'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes...');
  });
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
