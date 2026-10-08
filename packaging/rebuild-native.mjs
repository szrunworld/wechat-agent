// Rebuilds the native modules the main process needs against the Electron
// ABI and stages them for the bundle. See SQLITE-ABI.md.
//
// Why a separate stage: the better-sqlite3 binary in the repo's node_modules is
// built for the Node ABI (tsx tests, lane B's suite). The packaged app runs on
// Electron's embedded Node, whose NODE_MODULE_VERSION differs, so the same .node
// file fails to load. We never rebuild node_modules in place; instead the
// module is copied to apps/desktop/main/build/native and rebuilt there with
// node-gyp against Electron's headers (the same invocation @electron/rebuild
// makes; from source, because better-sqlite3 ships no prebuilt binary for this
// Electron ABI). @electron/rebuild itself is not used: its dependency walker
// also finds the hoisted copy in the repo's node_modules and rebuilds that one
// too, which breaks every Node-side test. The result is verified by actually
// opening a database inside Electron,
// and copied to build/resources/native/<module> so electron-builder's
// extraResources puts it at Contents/Resources/native/<module> (outside the
// asar, where dlopen can read it; not under a node_modules/ directory, which
// electron-builder's file matcher always excludes). The main process loads it
// from there with better-sqlite3's `nativeBinding` option, so the `bindings`
// lookup package is not shipped (apps/desktop/main/src/native-sqlite.ts).
//
//   node packaging/rebuild-native.mjs            # standalone
//   REBUILD_NATIVE_FORCE=1 node packaging/rebuild-native.mjs
// prepare.mjs calls rebuildNative() during `npm run package`.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(repo, 'apps', 'desktop', 'main');
const stage = join(project, 'build', 'native');
const resourcesOut = join(project, 'build', 'resources');

/** Modules to rebuild and the files each one needs at run time (JS wrapper + the addon; no sources, deps or test addon). */
const MODULES = [
  { name: 'better-sqlite3', ship: ['package.json', 'LICENSE', 'lib', 'build/Release/better_sqlite3.node'] },
];

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function electronVersion() { return readJson(join(repo, 'node_modules', 'electron', 'package.json')).version; }
/** The Electron executable (the `electron` package resolves to its path). */
function electronBinary() {
  return createRequire(join(repo, 'package.json'))('electron');
}

/** The ABI (NODE_MODULE_VERSION) and Node version of the Electron we package with, read from Electron itself. */
function electronAbi() {
  const r = spawnSync(electronBinary(), ['-e', 'process.stdout.write(JSON.stringify({ modules: process.versions.modules, node: process.versions.node, electron: process.versions.electron }))'],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (r.status !== 0) throw new Error(`cannot run Electron as node: ${r.error?.message ?? r.stderr}`);
  return JSON.parse(r.stdout);
}

function stampFile() { return join(stage, 'stamp.json'); }

function stageModule(name) {
  const src = join(repo, 'node_modules', name);
  const dst = join(stage, 'node_modules', name);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  // Source, binding.gyp, deps (SQLite amalgamation) and lib; not the Node-ABI build/.
  cpSync(src, dst, { recursive: true, filter: (p) => !p.includes(`${name}/build`) });
}

const HEADER_URL = 'https://www.electronjs.org/headers';
const GYP_DEV_DIR = join(homedir(), '.electron-gyp');

/** node-gyp rebuild of one staged module against Electron's headers; only touches the staged copy. */
function rebuild(version, name) {
  const bin = join(repo, 'node_modules', '.bin', 'node-gyp');
  const moduleDir = join(stage, 'node_modules', name);
  const args = ['rebuild', '--release', `--runtime=electron`, `--target=${version}`, `--arch=${process.arch}`, `--dist-url=${HEADER_URL}`, `--devdir=${GYP_DEV_DIR}`, '--build-from-source'];
  const t0 = Date.now();
  const r = spawnSync(bin, args, { encoding: 'utf8', cwd: moduleDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = `$ node-gyp ${args.join(' ')}  (cwd ${moduleDir})\n${r.stdout || ''}${r.stderr || ''}`;
  writeFileSync(join(stage, `rebuild-${name}.log`), log);
  if (r.status !== 0) throw new Error(`node-gyp failed for ${name} (exit ${r.status}); log: ${join(stage, `rebuild-${name}.log`)}\n${log.slice(-2000)}`);
  return Date.now() - t0;
}

/** sha256 of the repo's own (Node-ABI) addon, to prove the rebuild left it alone. */
function repoAddonDigest(name) {
  const file = join(repo, 'node_modules', name, 'build', 'Release', 'better_sqlite3.node');
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

/** Opens a database with the rebuilt binary inside Electron; the only proof that counts. */
function verify(name) {
  const binding = join(stage, 'node_modules', name, 'build', 'Release', 'better_sqlite3.node');
  const script = join(stage, 'verify.cjs');
  writeFileSync(script, `
    const Database = require(${JSON.stringify(join(repo, 'node_modules', name))});
    const db = new Database(':memory:', { nativeBinding: process.env.NATIVE_BINDING });
    const row = db.prepare('select sqlite_version() as v').get();
    db.close();
    process.stdout.write(JSON.stringify({ sqlite: row.v, modules: process.versions.modules, node: process.versions.node }));
  `);
  const r = spawnSync(electronBinary(), [script], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NATIVE_BINDING: binding } });
  if (r.status !== 0 || !r.stdout.startsWith('{')) throw new Error(`rebuilt ${name} does not load in Electron: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function ship(name, files, from) {
  const dst = join(resourcesOut, 'native', name);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of files) {
    const s = join(from, f);
    if (!existsSync(s)) throw new Error(`${name}: missing ${f} at ${s}`);
    cpSync(s, join(dst, f), { recursive: true });
  }
}

export function rebuildNative({ force = process.env.REBUILD_NATIVE_FORCE === '1', log = console.log } = {}) {
  const version = electronVersion();
  const abi = electronAbi();
  const names = MODULES.map((m) => m.name);
  const versions = Object.fromEntries(names.map((n) => [n, readJson(join(repo, 'node_modules', n, 'package.json')).version]));
  const want = { electron: version, modules: abi.modules, node: abi.node, arch: process.arch, modulesBuilt: versions };
  let stamp = existsSync(stampFile()) ? readJson(stampFile()) : null;
  const fresh = stamp && JSON.stringify({ ...stamp, builtMs: undefined, verified: undefined }) === JSON.stringify({ ...want, builtMs: undefined, verified: undefined })
    && names.every((n) => existsSync(join(stage, 'node_modules', n, 'build', 'Release', 'better_sqlite3.node')));
  if (force || !fresh) {
    log(`[rebuild-native] electron ${version} (node ${abi.node}, NODE_MODULE_VERSION ${abi.modules}); rebuilding ${names.join(', ')} from source`);
    mkdirSync(stage, { recursive: true });
    rmSync(stampFile(), { force: true });
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'wechat-agent-native-stage', private: true, dependencies: versions }, null, 2));
    const before = Object.fromEntries(names.map((n) => [n, repoAddonDigest(n)]));
    for (const n of names) stageModule(n);
    let builtMs = 0;
    for (const n of names) builtMs += rebuild(version, n);
    for (const n of names) {
      if (repoAddonDigest(n) !== before[n]) throw new Error(`${n}: the rebuild modified node_modules/${n} in the repo (Node-ABI copy); run npm rebuild ${n}`);
    }
    const verified = Object.fromEntries(names.map((n) => [n, verify(n)]));
    for (const n of names) {
      if (verified[n].modules !== abi.modules) throw new Error(`${n}: verified under NODE_MODULE_VERSION ${verified[n].modules}, expected ${abi.modules}`);
    }
    stamp = { ...want, builtMs, verified };
    writeFileSync(stampFile(), JSON.stringify(stamp, null, 2) + '\n');
    log(`[rebuild-native] built in ${builtMs} ms; verified in Electron: ${JSON.stringify(verified)}`);
  } else {
    log(`[rebuild-native] up to date for electron ${version} / NODE_MODULE_VERSION ${abi.modules} (built in ${stamp.builtMs} ms earlier)`);
  }
  for (const m of MODULES) ship(m.name, m.ship, join(stage, 'node_modules', m.name));
  const manifest = { electron: stamp.electron, node: stamp.node, modules: stamp.modules, arch: stamp.arch, builtFromSource: true, rebuilt: stamp.modulesBuilt, verified: stamp.verified, shipped: MODULES.map((m) => `native/${m.name}`) };
  writeFileSync(join(resourcesOut, 'native-modules.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(resourcesOut, { recursive: true });
  const manifest = rebuildNative();
  console.log('[rebuild-native] ' + JSON.stringify(manifest));
}
