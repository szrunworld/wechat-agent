// Bundles the Electron entry points. The sandboxed preload cannot require
// workspace packages, and the main process must not resolve TS at run time,
// so both are bundled to CommonJS with electron left external.
// better-sqlite3 (native, used by @wechat-agent/ledger) is not bundled: the
// alias routes it through src/native-sqlite.ts, which loads the copy rebuilt
// for Electron's ABI from build/resources/node_modules (packaging/SQLITE-ABI.md).
// The ledger reads its migrations from `../migrations/` relative to
// import.meta.url, which a CommonJS bundle does not have; it is defined here as
// the bundle's own file URL and the SQL files are copied next to dist/ (shipped
// inside the asar by electron-builder.yml, present in the dev tree too).
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
rmSync('migrations', { recursive: true, force: true });
cpSync('../../../packages/ledger/migrations', 'migrations', { recursive: true });
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, logLevel: 'info', legalComments: 'none' };
await build({
  ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs',
  alias: { 'better-sqlite3': './src/native-sqlite.ts' },
  define: { 'import.meta.url': '__bundleFileUrl' },
  banner: { js: 'const __bundleFileUrl = require("node:url").pathToFileURL(__filename).href;' },
});
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
