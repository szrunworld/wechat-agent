// Forward-only migrations from ../migrations/NNNN_name.sql. Each file runs in
// its own transaction and is recorded in schema_version; a file is never
// edited in place. A database whose version is above what this code ships
// is refused (newer_schema) instead of being read or rewritten.
import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LedgerUnavailableError } from '@wechat-agent/ports';

export interface Migration { version: number; name: string; sql: string }

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => FILE.test(f)).sort();
  const migrations = files.map((file) => {
    const [, version, name] = FILE.exec(file)!;
    return { version: Number(version), name, sql: readFileSync(`${dir}/${file}`, 'utf8') };
  });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new LedgerUnavailableError(`migration files are not contiguous at ${m.version}`);
  });
  return migrations;
}

export const MIGRATIONS: readonly Migration[] = loadMigrations();
export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS.length;

interface VersionRow { version: number; name: string }

function appliedVersions(db: Database): VersionRow[] {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`).get();
  if (!has) {
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    return [];
  }
  return db.prepare(`SELECT version, name FROM schema_version ORDER BY version`).all() as VersionRow[];
}

/** Applies pending migrations; returns the schema version now in the file. */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS, now = new Date().toISOString()): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new LedgerUnavailableError(`migration list is not contiguous at ${m.version}`);
  });
  const applied = appliedVersions(db);
  const current = applied.at(-1)?.version ?? 0;
  const supported = migrations.length;
  if (current > supported) throw new LedgerUnavailableError(`newer_schema: file is at ${current}, this build supports ${supported}`);
  for (const row of applied) {
    const expected = migrations[row.version - 1];
    if (!expected || expected.name !== row.name) {
      throw new LedgerUnavailableError(`migration_mismatch: version ${row.version} is ${row.name} in the file, ${expected?.name ?? 'missing'} in this build`);
    }
  }
  const record = db.prepare(`INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)`);
  for (const m of migrations.slice(current)) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, now);
    }).immediate();
  }
  return supported;
}

export function schemaVersionOf(db: Database): number {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`).get();
  if (!has) return 0;
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null };
  return row.v ?? 0;
}
