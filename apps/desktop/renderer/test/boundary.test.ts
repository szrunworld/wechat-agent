// The renderer stays on its side of the boundary: whitelist-only IPC and no Node.
import { IPC_METHODS } from '@wechat-agent/ports';
import { FakeApplicationService } from '@wechat-agent/ports/fakes';
import { describe, expect, it } from 'vitest';
import { makeCall } from '../src/service.ts';

const sources = import.meta.glob('../src/**/*.{ts,tsx,css}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('boundary', () => {
  it('rejects methods outside IPC_METHODS before they reach the service', async () => {
    const fake = new FakeApplicationService('ready_idle');
    const call = makeCall(fake);
    await expect((call as unknown as (m: string, p: unknown) => Promise<unknown>)('driver.act', {})).rejects.toThrow(/白名单/);
    expect(fake.calls).toEqual([]);
  });
  it('only calls whitelisted methods from source', () => {
    const used = new Set<string>();
    for (const src of Object.values(sources)) for (const m of src.matchAll(/call\('([a-z.A-Z]+)'/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(5);
    for (const m of used) expect(IPC_METHODS as readonly string[]).toContain(m);
  });
  it('has no Node imports or platform act parameters in the renderer sources', () => {
    const banned = [['node', ':'].join(''), ['child', 'process'].join('_'), "require('", 'snapshotId', 'imagePoint'];
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, src] of Object.entries(sources)) for (const b of banned) expect(src, `${file} contains ${b}`).not.toContain(b);
  });
});
