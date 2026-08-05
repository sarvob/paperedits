// Bundle the Electron main, preload, and renderer with esbuild.
// - main/preload: CJS for Node (electron kept external; node builtins external)
// - renderer: browser IIFE (talks to main only through the preload bridge)
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['src/renderer/renderer.ts'],
  outfile: 'dist/renderer.js',
  platform: 'browser',
  format: 'iife',
});

await cp('src/renderer/index.html', 'dist/index.html');
await cp('src/renderer/styles.css', 'dist/styles.css');

console.log('desktop build complete → dist/');
