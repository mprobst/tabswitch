/**
 * End-to-end test harness: launches a real Chromium with the extension under
 * test plus a small "driver" extension (test/driver-ext) that has the "tabs"
 * permission and is used to create, activate and inspect tabs and windows.
 *
 * Requirements (tests are skipped if they're missing):
 *  - An X display on which window focus works (headless Chromium reports every
 *    window as focused, which makes it useless here). Use Xvfb, e.g.
 *    `xvfb-run -a npm run test:e2e`.
 *  - `xdotool`, to send real key presses: extension keyboard shortcuts are
 *    handled by the browser UI and don't fire for synthetic CDP key events.
 *  - A Chromium / Chrome for Testing build (branded Chrome ignores
 *    --load-extension). Defaults to Playwright's bundled Chromium; override
 *    with CHROME_PATH.
 *
 * EXT_DIR overrides the extension directory, e.g. to run the same tests
 * against an older build for comparison.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = process.env.EXT_DIR ?? path.resolve(here, '../..');
const DRIVER_DIR = path.resolve(here, '../driver-ext');
const XDOTOOL = process.env.XDOTOOL ?? 'xdotool';

/** Returns a reason why e2e tests can't run here, or undefined if they can. */
export function skipReason() {
  if (!process.env.DISPLAY) return 'no DISPLAY; run under xvfb-run';
  try {
    execFileSync(XDOTOOL, ['version'], { stdio: 'ignore' });
  } catch {
    return `xdotool not found (${XDOTOOL})`;
  }
  return undefined;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `fn` until it returns a truthy value or `timeout` ms pass. Returns the
 * last value either way, so callers can assert on it and get a useful diff.
 */
export async function waitFor(fn, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let value;
  while (true) {
    value = await fn();
    if (value || Date.now() > deadline) return value;
    await sleep(50);
  }
}

/**
 * Waits until `fn()` returns the same value for `quiet` ms, i.e. the browser
 * and the extension's event handlers have settled.
 */
export async function settle(fn, quiet = 300, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let last = JSON.stringify(await fn());
  let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(50);
    const now = JSON.stringify(await fn());
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quiet) {
      break;
    }
  }
  return JSON.parse(last);
}

export class Browser {
  static async launch({ extDir = EXT_DIR, targetScript } = {}) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-e2e-'));
    const extensions = `${extDir},${DRIVER_DIR}`;
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      executablePath: process.env.CHROME_PATH || undefined,
      viewport: null,
      args: [
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=800,600',
      ],
    });
    const b = new Browser(ctx, userDataDir, targetScript);
    await b.init();
    return b;
  }

  constructor(ctx, userDataDir, targetScript) {
    this.ctx = ctx;
    this.userDataDir = userDataDir;
    this.targetScript = targetScript;
    /** Service worker versions by id, as reported by the CDP ServiceWorker domain. */
    this.versions = new Map();
  }

  async init() {
    const isDriver = (w) => w.url().endsWith('/driver.js');
    this.driver = this.ctx.serviceWorkers().find(isDriver);
    while (!this.driver) {
      const w = await this.ctx.waitForEvent('serviceworker');
      if (isDriver(w)) this.driver = w;
    }
    const page = this.ctx.pages()[0];
    this.cdp = await this.ctx.newCDPSession(page);
    this.cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
      for (const v of e.versions) this.versions.set(v.versionId, v);
    });
    await this.cdp.send('ServiceWorker.enable');
    // Wait for the extension under test to have started, too.
    await waitFor(() => this.targetVersion()?.runningStatus === 'running', 5000);
    // The initial about:blank tab gets the first window; give the extension
    // a moment to see it.
    await sleep(300);
  }

  /** The (running or stopped) service worker version of the extension under test. */
  targetVersion() {
    for (const v of this.versions.values()) {
      if (v.scriptURL.endsWith('/' + this.targetScript)) return v;
    }
    return undefined;
  }

  /** Evaluates `fn(arg)` in the driver extension's service worker. */
  drv(fn, arg) {
    return this.driver.evaluate(fn, arg);
  }

  /**
   * Stops the service worker of the extension under test, as Chrome does after
   * ~30s of inactivity. In-memory state is lost; the next event restarts it.
   */
  async stopTarget() {
    const v = await waitFor(() => this.targetVersion());
    await this.cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
    const stopped = await waitFor(() => this.targetVersion()?.runningStatus === 'stopped', 5000);
    if (!stopped) throw new Error('service worker did not stop');
  }

  isTargetRunning() {
    return this.targetVersion()?.runningStatus === 'running';
  }

  /** Sends real key presses to the focused X window, e.g. 'ctrl+q' or 'ctrl+q ctrl+q'. */
  key(combo) {
    execFileSync(XDOTOOL, ['key', '--delay', process.env.KEY_DELAY ?? '20', ...combo.split(' ')]);
  }

  async close() {
    await this.ctx.close();
    fs.rmSync(this.userDataDir, { recursive: true, force: true });
  }

  // ---- Tab and window helpers (all via the driver extension) ----

  /** Opens a new normal window with `n` tabs and focuses it. */
  async newWindow(n = 1, { type = 'normal', focused = true } = {}) {
    return this.drv(
      async ({ n, type, focused }) => {
        const urls = Array.from({ length: n }, (_, i) => `data:text/html,tab${i}`);
        const w = await chrome.windows.create({ url: urls, type, focused });
        return { windowId: w.id, tabIds: w.tabs.map((t) => t.id) };
      },
      { n, type, focused },
    );
  }

  /** Opens a new tab in the given window (not activated unless `active`). */
  async newTab(windowId, { active = false, url = 'data:text/html,tab' } = {}) {
    return this.drv(
      async ({ windowId, active, url }) => (await chrome.tabs.create({ windowId, active, url })).id,
      { windowId, active, url },
    );
  }

  /** Like a user clicking on a tab: focuses its window and activates it. */
  async activate(tabId) {
    await this.drv(async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    }, tabId);
    await this.idle();
  }

  async focusWindow(windowId) {
    await this.drv((windowId) => chrome.windows.update(windowId, { focused: true }), windowId);
    await this.idle();
  }

  async closeTab(tabId) {
    await this.drv((tabId) => chrome.tabs.remove(tabId), tabId);
    await this.idle();
  }

  /** Returns {windowId, tabId} of the active tab in the focused window. */
  async current() {
    return this.drv(async () => {
      const wins = await chrome.windows.getAll({ populate: true });
      const focused = wins.filter((w) => w.focused);
      if (focused.length !== 1) return { windowId: null, tabId: null, focusedCount: focused.length };
      const tab = focused[0].tabs.find((t) => t.active);
      return { windowId: focused[0].id, tabId: tab?.id ?? null };
    });
  }

  /** Waits for focus/activation state to stop changing. */
  idle() {
    return settle(() => this.current(), 200);
  }

  /** Presses the shortcut and waits for the result to settle. */
  async pressAndSettle(combo) {
    this.key(combo);
    return settle(() => this.current(), 300);
  }
}
