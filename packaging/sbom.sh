#!/bin/bash
# Software bill of materials for a packaged build:
#   dist/sbom.cdx.json          CycloneDX from npm (the shell package and what it builds with)
#   dist/bundle-manifest.json   every file shipped in the .app with its sha256 and size,
#                               plus the Electron / Chromium / Node versions
#   packaging/sbom.sh [path/to/WeChat Agent.app]
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-dist/mac-arm64/WeChat Agent.app}"
mkdir -p dist
( cd .. && npm sbom --sbom-format cyclonedx --workspace apps/desktop/main --package-lock-only 2>/dev/null ) > dist/sbom.cdx.json \
  || ( cd .. && npm sbom --sbom-format cyclonedx --workspace apps/desktop/main ) > dist/sbom.cdx.json
echo "sbom: dist/sbom.cdx.json ($(node -e 'const s=require("./dist/sbom.cdx.json");console.log((s.components||[]).length)') components)"
if [ -d "$APP" ]; then
  node - "$APP" <<'JS'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = process.argv[2];
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile()) files.push({ path: path.relative(app, p), size: st.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') });
    else if (st.isSymbolicLink()) files.push({ path: path.relative(app, p), symlink: fs.readlinkSync(p) });
  }
})(app);
const versions = {};
const electronPkg = path.join(__dirname, '..', 'node_modules', 'electron', 'package.json');
if (fs.existsSync(electronPkg)) versions.electron = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
const manifestPath = path.join(app, 'Contents', 'Resources', 'manifest.json');
const prepared = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const out = { app: path.basename(app), generatedAt: new Date().toISOString(), versions, prepared, fileCount: files.length, totalBytes: files.reduce((a, f) => a + (f.size || 0), 0), files };
fs.writeFileSync('dist/bundle-manifest.json', JSON.stringify(out, null, 2) + '\n');
console.log(`sbom: dist/bundle-manifest.json (${files.length} files, ${(out.totalBytes / 1048576).toFixed(1)} MiB)`);
JS
else
  echo "sbom: no app at $APP; bundle manifest skipped"
fi
