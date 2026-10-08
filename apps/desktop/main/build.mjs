// Bundles the Electron entry points. The sandboxed preload cannot require
// workspace packages, and the main process must not resolve TS at run time,
// so both are bundled to CommonJS with electron left external.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, logLevel: 'info', legalComments: 'none' };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
