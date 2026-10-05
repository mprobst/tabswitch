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
import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type CDPSession,
  type TestInfo,
  type Worker,
} from '@playwright/test';

/** A service worker version, as reported by the CDP ServiceWorker domain. */
type WorkerVersion = {
  versionId: string;
  scriptURL: string;
  runningStatus: 'stopped' | 'starting' | 'running' | 'stopping';
};

/** Result of `Browser.current()`: the active tab of the focused window. */
export type Current =
  | { windowId: number; tabId: number | null }
  | { windowId: null; tabId: null; focusedCount: number };

/** A window as returned by `Browser.newWindow()`. */
export type NewWindow = { windowId: number; tabIds: number[] };

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = process.env.EXT_DIR ?? path.resolve(here, '../..');
const DRIVER_DIR = path.resolve(here, '../driver-ext');
const XDOTOOL = process.env.XDOTOOL ?? 'xdotool';

/**
 * How long to give the extension's event handlers after Chrome's state has
 * changed. There is no black-box way to tell that the extension is done
 * handling an event (its handlers make further async API calls), so actions
 * that the next step depends on wait this long after their effect is visible.
 */
const HANDLER_GRACE_MS = 150;

/**
 * How long a value must stay unchanged in `expectToSettle`. Long enough for
 * the extension to (wrongly) act on an event, e.g. close a tab it shouldn't.
 */
const STABLE_MS = 300;

/** Returns a reason why e2e tests can't run here, or undefined if they can. */
export function skipReason(): string | undefined {
  if (!process.env.DISPLAY) return 'no DISPLAY; run under xvfb-run';
  try {
    execFileSync(XDOTOOL, ['version'], { stdio: 'ignore' });
  } catch {
    return `xdotool not found (${XDOTOOL})`;
  }
  return undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Asserts that `fn()` reaches `expected` (a value or asymmetric matcher, as
 * for `toEqual`) and then keeps it for `stableFor` ms.
 *
 * `expect.poll` alone passes as soon as the value matches once, which proves
 * nothing for "the extension leaves this alone" checks (it may not have acted
 * yet) and misses overshooting (e.g. switching one tab too far).
 */
export async function expectToSettle(fn: () => Promise<unknown>, expected: unknown, options: SettleOptions) {
  // A boxed step reports failures at the caller's line, not in here.
  await base.step(`expect ${options.message} to settle`, () => settleAndHold(fn, expected, options), { box: true });
}

type SettleOptions = { message: string; stableFor?: number; timeout?: number };

async function settleAndHold(
  fn: () => Promise<unknown>,
  expected: unknown,
  { message, stableFor = STABLE_MS, timeout }: SettleOptions,
) {
  await expect.poll(fn, { message, timeout }).toEqual(expected);
  const until = Date.now() + stableFor;
  while (Date.now() < until) {
    await sleep(50);
    expect(await fn(), `${message} (matched, but then changed)`).toEqual(expected);
  }
}

/**
 * Playwright Test `test` with a fresh browser per test, as the `b` fixture.
 * On failure, the extension's console output and the final tab and window
 * state are attached to the test report.
 */
export function extensionTest(targetScript: string) {
  return base.extend<{ b: Browser }>({
    // eslint-disable-next-line no-empty-pattern
    b: async ({}, use, testInfo) => {
      const b = await Browser.launch({ targetScript });
      try {
        await use(b);
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) await b.attachDiagnostics(testInfo);
        await b.close();
      }
    },
  });
}

export class Browser {
  static async launch({ extDir = EXT_DIR, targetScript }: { extDir?: string; targetScript: string }): Promise<Browser> {
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
    try {
      await b.init();
    } catch (e) {
      await b.close();
      throw e;
    }
    return b;
  }

  ctx: BrowserContext;
  userDataDir: string;
  targetScript: string;
  /** Service worker versions by id, as reported by the CDP ServiceWorker domain. */
  versions = new Map<string, WorkerVersion>();
  /** Console output of the extensions' service workers. */
  logs: string[] = [];
  /** The driver extension's service worker; set by `init()`. */
  driver!: Worker;
  /** A CDP session; set by `init()`. */
  cdp!: CDPSession;

  constructor(ctx: BrowserContext, userDataDir: string, targetScript: string) {
    this.ctx = ctx;
    this.userDataDir = userDataDir;
    this.targetScript = targetScript;
    ctx.on('console', (m) => {
      const url = m.location().url;
      if (url.startsWith('chrome-extension://')) this.logs.push(`[${m.type()}] ${path.basename(url)}: ${m.text()}`);
    });
  }

  async init() {
    this.driver = await this.serviceWorker((w) => w.url().endsWith('/driver.js'), 'the test driver extension');
    const page = this.ctx.pages()[0];
    this.cdp = await this.ctx.newCDPSession(page);
    this.cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
      for (const v of e.versions) this.versions.set(v.versionId, v as WorkerVersion);
    });
    await this.cdp.send('ServiceWorker.enable');
    await expect
      .poll(() => this.targetVersion()?.runningStatus, {
        message: `service worker of the extension under test (${this.targetScript}) starts`,
        timeout: 10_000,
      })
      .toBe('running');
    // The browser's initial window and tab; let the extension see them.
    await expect.poll(() => this.current(), { message: 'the initial window has focus' }).toMatchObject({
      windowId: expect.any(Number),
    });
    await this.waitForHandlers();
  }

  /** Returns the service worker matching `predicate`, waiting for it to start if needed. */
  private async serviceWorker(predicate: (w: Worker) => boolean, what: string): Promise<Worker> {
    // Checking the existing workers and subscribing happen in the same tick,
    // so a worker can't start in between unnoticed.
    const existing = this.ctx.serviceWorkers().find(predicate);
    if (existing) return existing;
    try {
      return await this.ctx.waitForEvent('serviceworker', { predicate, timeout: 10_000 });
    } catch (e) {
      throw new Error(`service worker of ${what} did not start`, { cause: e });
    }
  }

  /** The (running or stopped) service worker version of the extension under test. */
  targetVersion(): WorkerVersion | undefined {
    for (const v of this.versions.values()) {
      if (v.scriptURL.endsWith('/' + this.targetScript)) return v;
    }
    return undefined;
  }

  /** Evaluates `fn(arg)` in the driver extension's service worker. */
  drv<R>(fn: () => R | Promise<R>): Promise<R>;
  drv<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  drv(fn: (arg?: any) => unknown, arg?: unknown): Promise<unknown> {
    // The overloads above give callers precise types; Playwright's own
    // generics can't express the optional argument.
    return this.driver.evaluate(fn, arg);
  }

  /**
   * Stops the service worker of the extension under test, as Chrome does after
   * ~30s of inactivity. In-memory state is lost; the next event restarts it.
   */
  async stopTarget() {
    const v = this.targetVersion();
    if (!v) throw new Error(`no service worker found for ${this.targetScript}`);
    await this.cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
    await expect
      .poll(() => this.targetVersion()?.runningStatus, {
        message: `service worker of the extension under test (${this.targetScript}) stops`,
        timeout: 5_000,
      })
      .toBe('stopped');
  }

  /** Sends real key presses to the focused X window, e.g. 'ctrl+q' or 'ctrl+q ctrl+q'. */
  key(combo: string) {
    execFileSync(XDOTOOL, ['key', '--delay', process.env.KEY_DELAY ?? '20', ...combo.split(' ')]);
  }

  /** Attaches the extensions' console output and the tab and window state to the test report. */
  async attachDiagnostics(testInfo: TestInfo) {
    await testInfo.attach('extension console', { body: this.logs.join('\n'), contentType: 'text/plain' });
    try {
      const windows = await this.drv(() => chrome.windows.getAll({ populate: true }));
      await testInfo.attach('windows', { body: JSON.stringify(windows, null, 2), contentType: 'application/json' });
    } catch (e) {
      await testInfo.attach('windows', { body: `could not query windows: ${e}`, contentType: 'text/plain' });
    }
  }

  async close() {
    await this.ctx.close();
    fs.rmSync(this.userDataDir, { recursive: true, force: true });
  }

  // ---- Tab and window helpers (all via the driver extension) ----

  /** Opens a new window with `n` tabs and waits for it to have focus (if `focused`). */
  async newWindow(
    n = 1,
    { type = 'normal', focused = true }: { type?: 'normal' | 'popup'; focused?: boolean } = {},
  ): Promise<NewWindow> {
    const w = await this.drv(
      async ({ n, type, focused }: { n: number; type: 'normal' | 'popup'; focused: boolean }): Promise<NewWindow> => {
        const urls = Array.from({ length: n }, (_, i) => `data:text/html,tab${i}`);
        const w = await chrome.windows.create({ url: urls, type, focused });
        return { windowId: w!.id!, tabIds: w!.tabs!.map((t) => t.id!) };
      },
      { n, type, focused },
    );
    if (focused) await this.reached({ windowId: w.windowId }, `new ${type} window ${w.windowId} has focus`);
    return w;
  }

  /** Opens a new tab in the given window (not activated unless `active`). */
  async newTab(
    windowId: number,
    { active = false, url = 'data:text/html,tab' }: { active?: boolean; url?: string } = {},
  ): Promise<number> {
    const tabId = await this.drv(
      async ({ windowId, active, url }: { windowId: number; active: boolean; url: string }) =>
        (await chrome.tabs.create({ windowId, active, url })).id!,
      { windowId, active, url },
    );
    if (active) await this.reached({ tabId }, `new tab ${tabId} is active`);
    return tabId;
  }

  /** Like a user clicking on a tab: focuses its window and activates it. */
  async activate(tabId: number) {
    const windowId = await this.drv(async (tabId: number) => {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      return tab.windowId;
    }, tabId);
    await this.reached({ windowId, tabId }, `tab ${tabId} is active in focused window ${windowId}`);
  }

  async focusWindow(windowId: number) {
    await this.drv((windowId: number) => chrome.windows.update(windowId, { focused: true }), windowId);
    await this.reached({ windowId }, `window ${windowId} has focus`);
  }

  async closeTab(tabId: number) {
    await this.drv((tabId: number) => chrome.tabs.remove(tabId), tabId);
    await expect
      .poll(() => this.drv(async (id: number) => (await chrome.tabs.query({})).some((t) => t.id === id), tabId), {
        message: `tab ${tabId} is closed`,
      })
      .toBe(false);
    await this.waitForHandlers();
  }

  /** Returns {windowId, tabId} of the active tab in the focused window. */
  async current(): Promise<Current> {
    return this.drv(async (): Promise<Current> => {
      const wins = await chrome.windows.getAll({ populate: true });
      const focused = wins.filter((w) => w.focused);
      if (focused.length !== 1) return { windowId: null, tabId: null, focusedCount: focused.length };
      const tab = focused[0].tabs?.find((t) => t.active);
      return { windowId: focused[0].id!, tabId: tab?.id ?? null };
    });
  }

  /**
   * Waits until the focused window / active tab match `partial`, then gives
   * the extension time to handle the events.
   */
  private async reached(partial: Partial<Current>, message: string) {
    await expect.poll(() => this.current(), { message }).toMatchObject(partial);
    await this.waitForHandlers();
  }

  /**
   * Gives the extension's event handlers time to finish, after the effect of
   * an action has become visible (see HANDLER_GRACE_MS).
   */
  waitForHandlers() {
    return sleep(HANDLER_GRACE_MS);
  }

  /**
   * Asserts that the focused window / active tab end up matching `partial`
   * and stay that way, e.g. after pressing the shortcut.
   */
  async expectCurrent(partial: Partial<Current>, message = 'active tab in the focused window') {
    await base.step(
      `expect ${message} to settle`,
      () => settleAndHold(() => this.current(), expect.objectContaining(partial), { message }),
      { box: true },
    );
  }
}
