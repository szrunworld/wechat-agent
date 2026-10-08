// Off-screen renders of every screen in every sample state, for docs/acceptance/ui
// (owned by lane H; the PNGs land in apps/desktop/renderer/acceptance first).
// Runs a Vite dev server against the Fake service and screenshots it with a
// headless Chrome. Nothing here touches WeChat or the user's screen.
//   npm run acceptance:render -w @wechat-agent/renderer
//   RENDER_BROWSER=/path/to/chrome to override the browser executable.
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { sampleSnapshots } from '@wechat-agent/ports/fakes';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../../../../docs/acceptance/ui/', import.meta.url));
const screens = ['W01', 'W02', 'W03', 'W04', 'W05', 'W06'] as const;
const states = Object.keys(sampleSnapshots);
/** One narrow (<900px, single column) render per screen, in its most loaded state. */
const narrow: Record<(typeof screens)[number], string> = { W01: 'platform_offline', W02: 'waiting_approval', W03: 'waiting_approval', W04: 'waiting_approval', W05: 'unknown_result', W06: 'ready_idle' };

const server = await createServer({ root, configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('vite did not report a port');
const base = `http://127.0.0.1:${address.port}/`;

const executablePath = process.env.RENDER_BROWSER;
const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true });
let count = 0;
try {
  const shoot = async (screen: string, state: string, width: number, height: number, suffix: string) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'zh-CN' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?screen=${screen}&state=${state}&panel=0`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-ready="true"]');
    await page.screenshot({ path: `${outDir}${screen}-${state}${suffix}.png`, fullPage: true });
    await context.close();
    if (errors.length) throw new Error(`${screen}/${state}: ${errors.join('; ')}`);
    count += 1;
  };
  for (const screen of screens) {
    for (const state of states) await shoot(screen, state, 1280, 900, '');
    await shoot(screen, narrow[screen], 800, 1000, '-narrow');
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`rendered ${count} screenshots into ${outDir}`);
