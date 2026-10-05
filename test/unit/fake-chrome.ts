/**
 * A small in-memory fake of the parts of the `chrome` extension API that
 * tab_listener.js uses, for fast unit tests without a browser.
 *
 * The fake models a world of windows ({id, type, focused}) and tabs ({id,
 * windowId, active}). The `chrome.*` API methods read and mutate that world and
 * fire the events Chrome would fire in response (e.g. `tabs.update(id, {active:
 * true})` fires `tabs.onActivated`). The helper methods on FakeChrome
 * (`activateTab`, `focusWindow`, `closeTab`, `pressShortcut`, ...) play the
 * user, or the browser itself, and do the same.
 *
 * Like in Chrome, everything is asynchronous: API methods return promises that
 * resolve a moment after their effect took place, and event listeners are
 * invoked from a separate task, never synchronously from whatever fired the
 * event. `settle()` waits until all of that has died down.
 *
 * Use `restartWorker()` to simulate the service worker being terminated and
 * woken up again: `storage.session` survives, listeners do not, and the module
 * is evaluated afresh.
 */

import { asTuple, type Tuple } from '../tuple.ts';

const WINDOW_ID_NONE = -1;

/** Makes every module evaluation unique, across FakeChrome instances too (ES modules are cached by URL). */
let workerCount = 0;

type FakeWindow = { id: number; type: string; focused: boolean };
type FakeTab = { id: number; windowId: number; active: boolean };
type FakeTabSnapshot = FakeTab & { index: number };
type FakeWindowSnapshot = FakeWindow & { tabs?: FakeTabSnapshot[] };
type WindowFilter = { windowTypes?: string[] };
// Listeners of different events take different arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = { fn: (...args: any[]) => unknown; filter?: WindowFilter };
type TabQuery = {
  active?: boolean;
  windowId?: number;
  currentWindow?: boolean;
  lastFocusedWindow?: boolean;
};

/** A `chrome.*.onSomething` event. */
class FakeEvent {
  listeners: Listener[] = [];

  env: FakeChrome;

  constructor(env: FakeChrome) {
    this.env = env;
  }

  addListener(fn: Listener['fn'], filter?: WindowFilter) {
    this.listeners.push(filter ? { fn, filter } : { fn });
  }

  removeListener(fn: Listener['fn']) {
    this.listeners = this.listeners.filter((l) => l.fn !== fn);
  }

  hasListener(fn: Listener['fn']) {
    return this.listeners.some((l) => l.fn === fn);
  }

  /** Invokes all current listeners, asynchronously. */
  fire(...args: unknown[]) {
    for (const listener of this.listeners) {
      const listenerArgs = this.argsFor(listener.filter, args);
      this.env.schedule(() => {
        // The worker may have been restarted in the meantime.
        return this.listeners.includes(listener) ? listener.fn(...listenerArgs) : undefined;
      });
    }
  }

  /** Hook for events that deliver different arguments depending on the listener's filter. */
  argsFor(_filter: WindowFilter | undefined, args: unknown[]): unknown[] {
    return args;
  }
}

/**
 * `windows.onFocusChanged` takes a `{windowTypes}` filter. Focus moving to a
 * window that does not match is reported as WINDOW_ID_NONE.
 */
class FakeFocusEvent extends FakeEvent {
  override argsFor(filter: WindowFilter | undefined, [windowId]: unknown[]): unknown[] {
    const window = this.env.windows.get(windowId as number);
    if (filter?.windowTypes && window && !filter.windowTypes.includes(window.type)) {
      return [WINDOW_ID_NONE];
    }
    return [windowId];
  }
}

/** A `chrome.storage.*` area. Values are copied on the way in and out. */
class FakeStorageArea {
  env: FakeChrome;
  /** The stored items; survives worker restarts. */
  data: Record<string, unknown> = {};

  constructor(env: FakeChrome) {
    this.env = env;
  }

  /**
   * @param keys Keys to read; an object also provides defaults for missing keys.
   */
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    if (keys == null) {
      Object.assign(result, this.data);
    } else if (typeof keys === 'string' || Array.isArray(keys)) {
      for (const key of [keys].flat()) {
        if (key in this.data) result[key] = this.data[key];
      }
    } else {
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = key in this.data ? this.data[key] : fallback;
      }
    }
    const copy = structuredClone(result);
    return this.env.call(() => copy, this.env.storageGetDelay);
  }

  set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(items));
    return this.env.call(() => undefined);
  }
}

export class FakeChrome {
  windows = new Map<number, FakeWindow>();
  /** All tabs; the order within a window is the tab order. */
  tabs: FakeTab[] = [];
  /** Window IDs, most recently focused first. */
  focusOrder: number[] = [];
  nextTabId = 1;
  nextWindowId = 1001;

  /**
   * Artificial latency (ms) of `storage.*.get`, to reproduce the race where
   * the event that woke the worker arrives before storage was loaded.
   */
  storageGetDelay = 0;
  /** Exceptions thrown by event listeners. Tests should assert this stays empty. */
  errors: unknown[] = [];
  /** Number of in-flight API calls and event deliveries. */
  pending = 0;

  storage = { session: new FakeStorageArea(this), sync: new FakeStorageArea(this) };
  onActivated = new FakeEvent(this);
  onRemoved = new FakeEvent(this);
  onReplaced = new FakeEvent(this);
  onFocusChanged = new FakeFocusEvent(this);
  onCommand = new FakeEvent(this);
  onStartup = new FakeEvent(this);
  onInstalled = new FakeEvent(this);
  events: FakeEvent[] = [
    this.onActivated,
    this.onRemoved,
    this.onReplaced,
    this.onFocusChanged,
    this.onCommand,
    this.onStartup,
    this.onInstalled,
  ];

  /**
   * The object to install as `globalThis.chrome`. It only implements the
   * subset of the API that the extension uses, hence the loose type.
   */
  chrome: Record<string, unknown>;

  constructor() {
    this.chrome = {
      storage: this.storage,
      tabs: {
        query: (q?: TabQuery) => this.call(() => this.queryTabs(q)),
        get: (id: number) => this.call(() => this.snapshotTab(this.tab(id))),
        update: (id: number, props?: { active?: boolean }) =>
          this.call(() => this.updateTab(id, props)),
        onActivated: this.onActivated,
        onRemoved: this.onRemoved,
        onReplaced: this.onReplaced,
      },
      windows: {
        WINDOW_ID_NONE,
        get: (id: number, opts?: { populate?: boolean }) =>
          this.call(() => this.snapshotWindow(this.window(id), opts?.populate)),
        getLastFocused: (opts?: { populate?: boolean } & WindowFilter) =>
          this.call(() => this.lastFocused(opts)),
        update: (id: number, props?: { focused?: boolean }) =>
          this.call(() => this.updateWindow(id, props)),
        onFocusChanged: this.onFocusChanged,
      },
      commands: { onCommand: this.onCommand },
      runtime: { onStartup: this.onStartup, onInstalled: this.onInstalled },
    };
  }

  // ---- Service worker lifecycle ----

  /** Makes this the global `chrome`. */
  install() {
    // The fake only implements part of the chrome API, so it can't be
    // type-checked against the real `typeof chrome`; cast it.
    globalThis.chrome = this.chrome as unknown as typeof chrome;
  }

  /** Drops all listeners, as if the service worker was terminated. */
  stopWorker() {
    for (const event of this.events) event.listeners = [];
  }

  /**
   * Starts the worker: evaluates the module afresh, so it registers its
   * listeners and starts loading its state from storage. The returned promise
   * resolves when the module is evaluated, not when it finished loading. The
   * event that wakes up a real worker is dispatched after this point, so fire
   * it (e.g. with `activateTab`) after awaiting this and before `settle()`.
   *
   * @param moduleUrl URL of the module (a file: URL).
   */
  async startWorker(moduleUrl: string) {
    this.install();
    await import(`${moduleUrl}?worker=${++workerCount}`);
  }

  /** Stops and starts the worker. Storage and the world persist. */
  async restartWorker(moduleUrl: string) {
    this.stopWorker();
    await this.startWorker(moduleUrl);
  }

  // ---- Settling ----

  /** Runs `fn` as an asynchronous task, tracking it for `settle()`. */
  schedule(fn: () => unknown) {
    this.pending++;
    setTimeout(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => this.errors.push(e))
        .finally(() => this.pending--);
    }, 0);
  }

  /**
   * Runs an API call: `fn` takes effect immediately, but the promise only
   * settles after `delay` ms. Errors thrown by `fn` become rejections.
   */
  call<T>(fn: () => T, delay = 0): Promise<T> {
    let result: T | undefined,
      error: unknown,
      failed = false;
    try {
      result = fn();
    } catch (e) {
      error = e;
      failed = true;
    }
    this.pending++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.pending--;
        if (failed) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve(result as T);
        }
      }, delay);
    });
  }

  /**
   * Waits until no API calls or event deliveries are in flight, i.e. until the
   * extension has reacted to everything that happened so far. Everything the
   * extension does in between those calls happens in microtasks, so it is
   * complete once no call is pending at a task boundary.
   */
  async settle() {
    const deadline = Date.now() + 5000;
    let idleRounds = 0;
    while (idleRounds < 2) {
      if (Date.now() > deadline) {
        throw new Error(`settle() timed out, ${this.pending} calls pending`);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      idleRounds = this.pending === 0 ? idleRounds + 1 : 0;
    }
  }

  // ---- World lookups ----

  tab(id: number): FakeTab {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  }

  window(id: number): FakeWindow {
    const window = this.windows.get(id);
    if (!window) throw new Error(`No window with id: ${id}`);
    return window;
  }

  tabsOf(windowId: number): FakeTab[] {
    return this.tabs.filter((t) => t.windowId === windowId);
  }

  snapshotTab(tab: FakeTab): FakeTabSnapshot {
    return { ...tab, index: this.tabsOf(tab.windowId).indexOf(tab) };
  }

  snapshotWindow(window: FakeWindow, populate = false): FakeWindowSnapshot {
    const copy: FakeWindowSnapshot = { ...window };
    if (populate) copy.tabs = this.tabsOf(window.id).map((t) => this.snapshotTab(t));
    return copy;
  }

  /** The window that has focus (of any type), if any. */
  focusedWindow(): FakeWindow | undefined {
    return [...this.windows.values()].find((w) => w.focused);
  }

  /** What the user is looking at: the focused window and its active tab, if any. */
  current(): { windowId: number; tabId: number | undefined } | undefined {
    const window = this.focusedWindow();
    if (!window) return undefined;
    return { windowId: window.id, tabId: this.tabsOf(window.id).find((t) => t.active)?.id };
  }

  // ---- Implementations of the chrome.* calls ----

  queryTabs(q: TabQuery = {}) {
    const lastFocused = this.focusOrder.find((id) => this.windows.has(id));
    return this.tabs
      .filter((t) => q.active === undefined || t.active === q.active)
      .filter((t) => q.windowId === undefined || t.windowId === q.windowId)
      .filter((t) => !q.currentWindow || t.windowId === lastFocused)
      .filter((t) => !q.lastFocusedWindow || t.windowId === lastFocused)
      .map((t) => this.snapshotTab(t));
  }

  updateTab(id: number, props: { active?: boolean } = {}) {
    const tab = this.tab(id);
    if (props.active) this.activate(tab);
    return this.snapshotTab(tab);
  }

  updateWindow(id: number, props: { focused?: boolean } = {}) {
    const window = this.window(id);
    if (props.focused) this.focus(window.id);
    return this.snapshotWindow(window);
  }

  lastFocused({ populate = false, windowTypes }: { populate?: boolean } & WindowFilter = {}) {
    for (const id of this.focusOrder) {
      const window = this.windows.get(id);
      if (window && (!windowTypes || windowTypes.includes(window.type))) {
        return this.snapshotWindow(window, populate);
      }
    }
    throw new Error('No last-focused window');
  }

  // ---- State changes that fire events ----

  /** Makes the tab the active one of its window. Fires onActivated if that changed it. */
  activate(tab: FakeTab) {
    if (tab.active) return;
    const previous = this.tabsOf(tab.windowId).find((t) => t.active);
    for (const t of this.tabsOf(tab.windowId)) t.active = false;
    tab.active = true;
    this.onActivated.fire({ tabId: tab.id, windowId: tab.windowId, previousTabId: previous?.id });
  }

  /** Gives the window focus. Fires onFocusChanged if that changed it. */
  focus(windowId: number) {
    if (this.window(windowId).focused) return;
    for (const w of this.windows.values()) w.focused = w.id === windowId;
    this.focusOrder = [windowId, ...this.focusOrder.filter((id) => id !== windowId)];
    this.onFocusChanged.fire(windowId);
  }

  // ---- Helpers: the user, or the browser, doing things ----

  /**
   * Opens a window with the given number of tabs; the first one is active. Like
   * a real new window, it takes focus unless `focused` is false.
   */
  addWindow<const N extends number = 1>({
    type = 'normal',
    tabs = 1 as N,
    focused = true,
  }: { type?: string; tabs?: N; focused?: boolean } = {}): {
    windowId: number;
    tabIds: Tuple<number, N>;
  } {
    const windowId = this.nextWindowId++;
    this.windows.set(windowId, { id: windowId, type, focused: false });
    this.focusOrder.push(windowId);
    const tabIds: number[] = [];
    for (let i = 0; i < tabs; i++) {
      const tab = { id: this.nextTabId++, windowId, active: i === 0 };
      this.tabs.push(tab);
      tabIds.push(tab.id);
    }
    if (tabIds[0] !== undefined) this.onActivated.fire({ tabId: tabIds[0], windowId });
    if (focused) this.focus(windowId);
    return { windowId, tabIds: asTuple(tabIds, tabs) };
  }

  /** Opens a tab at the end of the window; it becomes active if `active` is set. */
  addTab(windowId: number, { active = false }: { active?: boolean } = {}): number {
    this.window(windowId);
    const tab = { id: this.nextTabId++, windowId, active: false };
    this.tabs.push(tab);
    if (active) this.activate(tab);
    return tab.id;
  }

  /** The user selects a tab in its window's tab strip. Does not change window focus. */
  activateTab(tabId: number) {
    this.activate(this.tab(tabId));
  }

  /** The user focuses a window. */
  focusWindow(windowId: number) {
    this.focus(windowId);
  }

  /** The user switches to another application: no browser window has focus. */
  blurAll() {
    for (const w of this.windows.values()) w.focused = false;
    this.onFocusChanged.fire(WINDOW_ID_NONE);
  }

  /** Closes a tab. If it was active, Chrome activates its right (else left) neighbour. */
  closeTab(tabId: number) {
    const tab = this.tab(tabId);
    const siblings = this.tabsOf(tab.windowId);
    if (siblings.length === 1) return this.closeWindow(tab.windowId);
    const i = siblings.indexOf(tab);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.onRemoved.fire(tabId, { windowId: tab.windowId, isWindowClosing: false });
    const neighbour = siblings[i + 1] ?? siblings[i - 1];
    if (tab.active && neighbour) this.activate(neighbour);
  }

  /** Closes a window and its tabs. If it had focus, the previously focused window gets it. */
  closeWindow(windowId: number) {
    const window = this.window(windowId);
    for (const tab of this.tabsOf(windowId)) {
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      this.onRemoved.fire(tab.id, { windowId, isWindowClosing: true });
    }
    this.windows.delete(windowId);
    this.focusOrder = this.focusOrder.filter((id) => id !== windowId);
    if (!window.focused) return;
    const next = this.focusOrder[0];
    if (next !== undefined) {
      this.focus(next);
    } else {
      this.onFocusChanged.fire(WINDOW_ID_NONE);
    }
  }

  /**
   * Moves a tab to the end of another window, where it becomes active. If it
   * was active in its old window, that window activates a neighbour.
   */
  moveTab(tabId: number, windowId: number) {
    const tab = this.tab(tabId);
    this.window(windowId);
    const siblings = this.tabsOf(tab.windowId);
    const i = siblings.indexOf(tab);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    const neighbour = siblings[i + 1] ?? siblings[i - 1];
    if (tab.active && neighbour) {
      tab.active = false;
      this.activate(neighbour);
    }
    tab.windowId = windowId;
    tab.active = false;
    this.tabs.push(tab);
    this.activate(tab);
  }

  /**
   * Swaps a tab's ID, as prerendering does, and fires onReplaced. The new ID
   * may also be reported as activated (if the tab was active), either `after`
   * onReplaced or `before` it. In the latter case onReplaced arrives late
   * enough for the extension to have processed the activation already.
   * @returns The new tab ID.
   */
  replaceTab(
    oldId: number,
    { activation = 'none' }: { activation?: 'none' | 'before' | 'after' } = {},
  ): number {
    const tab = this.tab(oldId);
    const newId = this.nextTabId++;
    tab.id = newId;
    const activated = { tabId: newId, windowId: tab.windowId };
    if (activation === 'before') {
      this.onActivated.fire(activated);
      this.after(20, () => this.onReplaced.fire(newId, oldId));
    } else {
      this.onReplaced.fire(newId, oldId);
      if (activation === 'after') this.onActivated.fire(activated);
    }
    return newId;
  }

  /** Runs `fn` after a delay, counting as in flight for `settle()` meanwhile. */
  after(ms: number, fn: () => void) {
    this.pending++;
    setTimeout(() => {
      this.pending--;
      fn();
    }, ms);
  }

  /** The user presses the extension's keyboard shortcut. */
  pressShortcut(command = 'previous-tab') {
    this.onCommand.fire(command);
  }
}
