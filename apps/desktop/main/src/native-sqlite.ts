// Loads better-sqlite3 built for Electron's ABI instead of the Node-ABI copy
// in the repo's node_modules. build.mjs aliases `better-sqlite3` to this file
// for the main-process bundle, so @wechat-agent/ledger's `import Database from
// 'better-sqlite3'` ends up here without lane B changing anything.
//
//   packaged   Contents/Resources/native/better-sqlite3   (extraResources, outside the asar)
//   dev        apps/desktop/main/build/resources/native/better-sqlite3
//
// Both are produced by packaging/rebuild-native.mjs; see packaging/SQLITE-ABI.md.
// The addon path is passed explicitly (`nativeBinding`), so better-sqlite3's
// `bindings` lookup never runs and nothing is resolved through node_modules.
// This file is not imported under tsx (tests resolve better-sqlite3 normally).
import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'build', 'resources');
const packageDir = join(root, 'native', 'better-sqlite3');
/** The rebuilt addon; exported so the spike report can name what it loaded. */
export const nativeBinding = join(packageDir, 'build', 'Release', 'better_sqlite3.node');

type DatabaseCtor = new (filename: string, options?: Record<string, unknown>) => object;
const Database = createRequire(join(root, 'package.json'))(packageDir) as DatabaseCtor & { prototype: object };

// better-sqlite3's constructor also works without `new`, so a plain function
// that injects nativeBinding and shares the prototype is a drop-in Database.
function ElectronDatabase(this: unknown, filename: string, options?: Record<string, unknown>): object {
  return new Database(filename, { ...(options ?? {}), nativeBinding });
}
ElectronDatabase.prototype = Database.prototype;
Object.setPrototypeOf(ElectronDatabase, Database);
Object.defineProperty(ElectronDatabase, 'name', { value: 'Database' });

export default ElectronDatabase;
