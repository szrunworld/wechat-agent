// Electron main process (lane G). Owns the window, the menu-bar item, the
// single-instance lock, the quit flow and the IPC gateway. The application
// service behind the gateway is the ports Fake until lane E's real one is
// wired in at integration time (see createService).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { ApplicationService, AppSnapshot } from '@wechat-agent/ports';
import { FakeApplicationService, sampleSnapshots, type SnapshotKey } from '@wechat-agent/ports/fakes';
import { CALL_CHANNEL, SNAPSHOT_CHANNEL } from './channels.ts';
import { createCallGateway } from './gateway.ts';
import { CLOSE_HINT, decideClose } from './lifecycle.ts';
import { quitPrompt, runQuitFlow } from './quit.ts';
import { shellStatus, STATUS_LABEL, trayToggle } from './status.ts';

const APP_NAME = 'WeChat Agent';
const startedAt = Date.now();
// Spike mode: never show a window, measure time to first paint, write a
// screenshot of the placeholder, then quit. Used by packaging/measure-startup.sh.
const spikeOut = process.env.WECHAT_AGENT_SPIKE_OUT;
const spike = Boolean(spikeOut);
let readyToShowMs = -1;

// The user data directory is fixed so upgrades and reinstalls keep the ledger
// (方案 E08): ~/Library/Application Support/WeChat Agent/
app.setName(APP_NAME);
// WECHAT_AGENT_USER_DATA is only for packaging/verify-install.sh and the spike, which
// must not touch the real ledger directory.
app.setPath('userData', process.env.WECHAT_AGENT_USER_DATA || join(app.getPath('appData'), APP_NAME));

function createService(): ApplicationService {
  // Integration swaps this for lane E's ApplicationService; nothing else changes.
  const key = process.env.WECHAT_AGENT_FAKE_SNAPSHOT as SnapshotKey | undefined;
  return new FakeApplicationService(key && key in sampleSnapshots ? key : 'ready_idle');
}

interface ShellState { closeHintShown: boolean }
const statePath = () => join(app.getPath('userData'), 'shell-state.json');
function readShellState(): ShellState {
  try { return { closeHintShown: false, ...JSON.parse(readFileSync(statePath(), 'utf8')) }; } catch { return { closeHintShown: false }; }
}
function writeShellState(state: ShellState): void {
  try { mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 }); writeFileSync(statePath(), JSON.stringify(state), { mode: 0o600 }); } catch { /* best effort */ }
}

function rendererEntry(): string {
  // Lane F's built renderer when present (dev tree or packaged resources); else the placeholder.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'renderer', 'index.html')]
    : [join(__dirname, '..', 'build', 'renderer', 'index.html'), join(__dirname, '..', '..', 'renderer', 'dist', 'index.html')];
  for (const file of candidates) if (existsSync(file)) return file;
  return join(__dirname, '..', 'renderer-placeholder', 'index.html');
}

function probeSocket(path: string | undefined): Promise<unknown> {
  if (!path) return Promise.resolve({ skipped: 'WECHAT_AGENT_SPIKE_SOCKET not set' });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = connect(path);
    socket.setTimeout(3000, () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
    socket.on('error', (error) => resolve({ ok: false, error: error.message }));
    socket.on('connect', () => socket.write('ping\n'));
    socket.on('data', (data) => { socket.end(); resolve({ ok: data.toString().trim() === 'pong', reply: data.toString().trim(), ms: Date.now() - t0 }); });
  });
}

function probeHelper(image: string): Promise<unknown> {
  const helper = app.isPackaged ? join(process.resourcesPath, 'helpers', 'ocr') : join(__dirname, '..', 'build', 'resources', 'helpers', 'ocr');
  if (!existsSync(helper)) return Promise.resolve({ skipped: `no helper at ${helper}` });
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(helper, [image], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: error.message, stderr: String(stderr).slice(0, 300) });
      let words = -1;
      try { words = (JSON.parse(stdout) as unknown[]).length; } catch { /* not JSON */ }
      resolve({ ok: words >= 0, words, ms: Date.now() - t0, helper });
    });
  });
}

class Shell {
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private snapshot: AppSnapshot | null = null;
  private quitting = false;
  private quitInProgress = false;
  private state = readShellState();
  constructor(private readonly service: ApplicationService) {}

  start(): void {
    const gateway = createCallGateway(this.service);
    ipcMain.handle(CALL_CHANNEL, (event, method: unknown, params: unknown) => {
      // Only our own window's main frame may call; nothing else is wired to this channel.
      if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) {
        return { ok: false, error: { code: 'blocked', message: 'unexpected IPC sender' } };
      }
      return gateway(method, params);
    });
    this.service.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.window?.webContents.send(SNAPSHOT_CHANNEL, snapshot);
      this.refreshTray();
    });
    if (!spike) this.createTray();
    this.createWindow();
  }

  private createWindow(): void {
    const win = new BrowserWindow({
      width: 1080, height: 760, minWidth: 720, minHeight: 520,
      show: false, title: APP_NAME,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
      // The renderer gets the current snapshot as soon as it can listen; later pushes follow the service.
      if (this.snapshot) win.webContents.send(SNAPSHOT_CHANNEL, this.snapshot);
      if (spike) setTimeout(() => void this.finishSpike(win), 400);
    });
    win.once('ready-to-show', () => { readyToShowMs = Date.now() - startedAt; if (!spike) win.show(); });
    win.on('close', (event) => {
      const decision = decideClose({ quitting: this.quitting, hintShown: this.state.closeHintShown });
      if (decision.action === 'allow') return;
      event.preventDefault();
      win.hide();
      if (decision.showHint) {
        this.state = { ...this.state, closeHintShown: true };
        writeShellState(this.state);
        if (Notification.isSupported()) new Notification({ title: APP_NAME, body: CLOSE_HINT }).show();
      }
    });
    win.on('closed', () => { this.window = null; });
    void win.loadFile(rendererEntry());
  }

  private async finishSpike(win: BrowserWindow): Promise<void> {
    const readyMs = readyToShowMs;
    try {
      mkdirSync(spikeOut!, { recursive: true });
      const image = await win.webContents.capturePage();
      const png = join(spikeOut!, 'placeholder.png');
      writeFileSync(png, image.toPNG());
      const report: Record<string, unknown> = { readyToShowMs: readyMs, loadedMs: Date.now() - startedAt - 400, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, packaged: app.isPackaged, renderer: rendererEntry() };
      // Spike probes (SPIKE.md §2): can the main process, as packaged, reach a Unix
      // socket under ~/Library and run the OCR helper from inside the bundle?
      report.socket = await probeSocket(process.env.WECHAT_AGENT_SPIKE_SOCKET);
      report.helper = await probeHelper(png);
      writeFileSync(join(spikeOut!, 'startup.json'), JSON.stringify(report, null, 2));
    } finally {
      this.quitting = true;
      app.exit(0);
    }
  }

  showWindow(): void {
    if (!this.window) this.createWindow();
    else { this.window.show(); this.window.focus(); }
  }

  private createTray(): void {
    const icon = nativeImage.createFromPath(join(__dirname, '..', 'renderer-placeholder', 'trayTemplate.png'));
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    this.tray.setToolTip(APP_NAME);
    this.tray.on('click', () => this.showWindow());
    this.refreshTray();
  }

  private refreshTray(): void {
    if (!this.tray) return;
    const status = this.snapshot ? shellStatus(this.snapshot) : 'offline';
    const toggle = trayToggle(status);
    const items: MenuItemConstructorOptions[] = [
      { label: `状态：${STATUS_LABEL[status]}`, enabled: false },
      { type: 'separator' },
      { label: '暂停', enabled: toggle === 'pause' && !this.quitInProgress, click: () => void this.toggleGate('app.pause') },
      { label: '恢复', enabled: toggle === 'resume' && !this.quitInProgress, click: () => void this.toggleGate('app.resume') },
      { label: '打开主窗口', click: () => this.showWindow() },
      { type: 'separator' },
      { label: this.quitInProgress ? '正在停止…' : '退出', enabled: !this.quitInProgress, click: () => void this.requestQuit() },
    ];
    this.tray.setTitle(STATUS_LABEL[status]);
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  private async toggleGate(method: 'app.pause' | 'app.resume'): Promise<void> {
    if (!this.snapshot) return;
    try {
      await this.service.call(method, { operationId: `tray:${method}:${Date.now()}`, expectedRevision: this.snapshot.revision });
    } catch (error) {
      dialog.showMessageBox({ type: 'warning', title: APP_NAME, message: method === 'app.pause' ? '暂停失败' : '恢复失败', detail: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  }

  /** Explicit quit: pause, wait for quiescence, then exit. Never fakes a cancel. */
  async requestQuit(): Promise<void> {
    if (this.quitInProgress) return;
    this.quitInProgress = true;
    this.refreshTray();
    const outcome = await runQuitFlow({ service: this.service, timeoutMs: 15_000 });
    const prompt = quitPrompt(outcome);
    if (prompt) {
      const { response } = await dialog.showMessageBox({
        type: 'warning', title: prompt.title, message: prompt.title, detail: prompt.body,
        buttons: ['仍然退出', '继续运行'], defaultId: 1, cancelId: 1,
      });
      if (response === 1) { this.quitInProgress = false; this.refreshTray(); return; }
    }
    this.quitting = true;
    app.quit();
  }

  beforeQuit(event: Electron.Event): void {
    // Cmd+Q and the dock's Quit arrive here; route them through the same flow.
    if (this.quitting || spike) return;
    event.preventDefault();
    void this.requestQuit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  const shell = new Shell(createService());
  app.on('second-instance', () => shell.showWindow());
  app.on('activate', () => shell.showWindow());
  app.on('window-all-closed', () => { /* stay in the menu bar */ });
  app.on('before-quit', (event) => shell.beforeQuit(event));
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  void app.whenReady().then(() => {
    if (spike && process.platform === 'darwin') app.dock?.hide();
    shell.start();
  });
}
