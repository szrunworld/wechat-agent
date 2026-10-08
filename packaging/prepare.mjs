// Prepares apps/desktop/main/build/resources before electron-builder runs:
//   helpers/ocr   the Vision OCR helper, from packages/recognition/ocr (lane C's
//                 prebuilt binary when present, else compiled here with swiftc)
//   renderer/     lane F's built renderer (apps/desktop/renderer/dist) when present
// Writes manifest.json saying what went in. Never fails the build for a missing
// optional input; the manifest and SPIKE.md record the gap.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(repo, 'apps', 'desktop', 'main');
const out = join(project, 'build', 'resources');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'helpers'), { recursive: true });

const manifest = { preparedAt: new Date().toISOString(), helpers: {}, renderer: 'placeholder' };

// OCR helper
const ocrDir = join(repo, 'packages', 'recognition', 'ocr');
const prebuilt = join(ocrDir, 'ocr');
const source = join(ocrDir, 'ocr.swift');
const target = join(out, 'helpers', 'ocr');
if (existsSync(prebuilt)) {
  cpSync(prebuilt, target);
  manifest.helpers.ocr = { from: 'packages/recognition/ocr/ocr (prebuilt)' };
} else if (existsSync(source)) {
  const which = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (which.status === 0) {
    const r = spawnSync('swiftc', ['-O', source, '-o', target], { encoding: 'utf8' });
    manifest.helpers.ocr = r.status === 0
      ? { from: 'packages/recognition/ocr/ocr.swift (compiled by prepare.mjs)' }
      : { missing: `swiftc failed: ${(r.stderr || '').trim().slice(0, 500)}` };
  } else {
    manifest.helpers.ocr = { missing: 'swiftc not found (install Xcode Command Line Tools)' };
  }
} else {
  manifest.helpers.ocr = { missing: 'packages/recognition/ocr/ocr.swift not found' };
}

// Renderer (lane F)
const rendererDist = join(repo, 'apps', 'desktop', 'renderer', 'dist');
if (existsSync(join(rendererDist, 'index.html'))) {
  cpSync(rendererDist, join(out, 'renderer'), { recursive: true });
  manifest.renderer = 'apps/desktop/renderer/dist';
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('[prepare] ' + JSON.stringify(manifest));
