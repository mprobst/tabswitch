/**
 * Unit tests for the "previous tab" logic in tab_listener.js, against an
 * in-memory fake of the chrome APIs (see fake-chrome.ts). No browser needed;
 * run with `npm test`. The scenarios mirror those in test/e2e.
 *
 * Set TAB_LISTENER to the absolute path of a different tab_listener.js to run
 * the suite against another build.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FakeChrome } from './fake-chrome.ts';

const MODULE_URL = process.env.TAB_LISTENER
  ? pathToFileURL(resolve(process.env.TAB_LISTENER)).href
  : new URL('../../tab_listener.js', import.meta.url).href;

// The extension logs a lot; keep the test output readable.
if (!process.env.DEBUG) console.log = () => { };

describe('tab_listener', () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = new FakeChrome();
  });
  afterEach(async () => {
    await fake.settle();
    fake.stopWorker();
    Reflect.deleteProperty(globalThis, 'chrome');
    assert.deepEqual(fake.errors, [], 'event listeners threw');
  });

  /** Starts (or restarts) the service worker and waits for it to finish loading. */
  async function start() {
    await fake.restartWorker(MODULE_URL);
    await fake.settle();
  }

  /** The user selects a tab in the focused window. */
  async function activate(tabId: number) {
    fake.activateTab(tabId);
    await fake.settle();
  }

  /** Presses the shortcut and returns where the user ends up. */
  async function press() {
    fake.pressShortcut();
    await fake.settle();
    return fake.current();
  }

  test('toggles between the two most recent tabs', async () => {
    const w = fake.addWindow({ tabs: 3 });
    const [t1, t2] = w.tabIds;
    await start();
    await activate(t2);
    assert.deepEqual(await press(), { windowId: w.windowId, tabId: t1 });
    assert.deepEqual(await press(), { windowId: w.windowId, tabId: t2 });
    assert.deepEqual(await press(), { windowId: w.windowId, tabId: t1 });
  });

  test('works right after the extension was installed', async () => {
    // The extension is installed while the initial tab is active.
    const { windowId, tabIds: [initial] } = fake.addWindow();
    await start();
    const t1 = fake.addTab(windowId, { active: true });
    await fake.settle();
    assert.equal((await press())?.tabId, initial);
    assert.equal((await press())?.tabId, t1);
  });

  test('toggles after the service worker was restarted', async () => {
    const { tabIds: [, t2, t3] } = fake.addWindow({ tabs: 3 });
    await start();
    await activate(t2);
    await activate(t3);
    await start();
    // The key press is the event that wakes the worker up.
    assert.equal((await press())?.tabId, t2);
    assert.equal((await press())?.tabId, t3);
    assert.equal((await press())?.tabId, t2);
  });

  test('a key press that wakes the worker works while storage is slow', async () => {
    const { tabIds: [t1, t2] } = fake.addWindow({ tabs: 2 });
    await start();
    await activate(t2);
    fake.stopWorker();
    fake.storageGetDelay = 50;
    await fake.startWorker(MODULE_URL);
    fake.pressShortcut();
    await fake.settle();
    assert.equal(fake.current()?.tabId, t1);
  });

  test('a tab activation that wakes the worker keeps the history', async () => {
    const { tabIds: [, t2, t3] } = fake.addWindow({ tabs: 3 });
    await start();
    await activate(t2);
    fake.stopWorker();
    // Loading the list from storage takes a while, and the event that woke the
    // worker is dispatched in the meantime.
    fake.storageGetDelay = 50;
    await fake.startWorker(MODULE_URL);
    fake.activateTab(t3);
    await fake.settle();
    fake.storageGetDelay = 0;
    assert.equal((await press())?.tabId, t2);
    assert.equal((await press())?.tabId, t3);
    assert.equal((await press())?.tabId, t2);
  });

  test('switches across windows', async () => {
    const w1 = fake.addWindow();
    const w2 = fake.addWindow();
    await start();
    fake.focusWindow(w1.windowId);
    await fake.settle();
    fake.focusWindow(w2.windowId);
    await fake.settle();
    assert.deepEqual(await press(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    assert.deepEqual(await press(), { windowId: w2.windowId, tabId: w2.tabIds[0] });
  });

  test('skips a tab that was closed', async () => {
    const { tabIds: [t1, t2, t3] } = fake.addWindow({ tabs: 3 });
    await start();
    await activate(t2);
    await activate(t3);
    fake.closeTab(t2);
    await fake.settle();
    assert.equal((await press())?.tabId, t1);
  });

  test('skips a tab that was closed while the worker was not running', async () => {
    const { tabIds: [t1, t2, t3] } = fake.addWindow({ tabs: 3 });
    await start();
    await activate(t2);
    await activate(t3);
    fake.stopWorker();
    fake.closeTab(t2);  // nobody is listening
    await start();
    assert.equal((await press())?.tabId, t1);
  });

  test('closing a tab visited in between does not make "previous" the current tab', async () => {
    const { tabIds: [t1, t2, t3] } = fake.addWindow({ tabs: 3 });
    await start();
    await activate(t2);
    await activate(t3);
    await activate(t2);
    // Closing t3 does not change the active tab, t2.
    fake.closeTab(t3);
    await fake.settle();
    // History is t1, t2, t3, t2; with t3 gone the previous tab is t1.
    assert.equal((await press())?.tabId, t1);
  });

  test('closing the active tab', async () => {
    const { tabIds: [t1, t2, t3] } = fake.addWindow({ tabs: 3 });
    await start();
    await activate(t2);
    await activate(t3);
    fake.closeTab(t3);  // Chrome activates the neighbour, t2
    await fake.settle();
    assert.equal(fake.current()?.tabId, t2);
    assert.equal((await press())?.tabId, t1);
    assert.equal((await press())?.tabId, t2);
  });

  test('closing the only tab of a window goes back to the other window', async () => {
    const w1 = fake.addWindow({ tabs: 2 });
    const w2 = fake.addWindow();
    await start();
    fake.closeWindow(w2.windowId);
    await fake.settle();
    assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    fake.activateTab(w1.tabIds[1]);
    await fake.settle();
    assert.deepEqual(await press(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
  });

  test('ignores popup windows', async () => {
    const w = fake.addWindow({ tabs: 2 });
    const [t1, t2] = w.tabIds;
    await start();
    await activate(t2);
    // e.g. an OAuth or Meet picture-in-picture style window takes focus...
    fake.addWindow({ type: 'popup' });
    await fake.settle();
    // ...and the user goes back to the main window.
    fake.focusWindow(w.windowId);
    await fake.settle();
    assert.deepEqual(await press(), { windowId: w.windowId, tabId: t1 });
    assert.deepEqual(await press(), { windowId: w.windowId, tabId: t2 });
  });

  test('switches tabs in the main window while a popup has focus', async () => {
    const w = fake.addWindow({ tabs: 2 });
    const [t1, t2] = w.tabIds;
    await start();
    await activate(t2);
    fake.addWindow({ type: 'popup', tabs: 3 });
    await fake.settle();
    assert.deepEqual(await press(), { windowId: w.windowId, tabId: t1 });
  });

  test('ignores focus moving to another application', async () => {
    const { windowId, tabIds: [t1, t2] } = fake.addWindow({ tabs: 2 });
    await start();
    await activate(t2);
    fake.blurAll();
    await fake.settle();
    fake.focusWindow(windowId);
    await fake.settle();
    assert.deepEqual(await press(), { windowId, tabId: t1 });
  });

  test('ignores tab activations in background windows', async () => {
    const w1 = fake.addWindow({ tabs: 2 });
    const w2 = fake.addWindow({ tabs: 2 });
    await start();
    fake.focusWindow(w1.windowId);
    await fake.settle();
    await activate(w1.tabIds[1]);
    // Something activates a tab in the unfocused window (e.g. a tab closing
    // there). The user never looked at it.
    await activate(w2.tabIds[1]);
    assert.deepEqual(await press(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
  });

  test('records the active tab when a window is focused', async () => {
    const w1 = fake.addWindow({ tabs: 2 });
    const w2 = fake.addWindow({ tabs: 2 });
    await start();
    await activate(w2.tabIds[1]);
    fake.focusWindow(w1.windowId);
    await fake.settle();
    assert.deepEqual(await press(), { windowId: w2.windowId, tabId: w2.tabIds[1] });
  });

  test('follows a tab that was moved to another window', async () => {
    const w1 = fake.addWindow({ tabs: 2 });
    const w2 = fake.addWindow();
    const [t1, t2] = w1.tabIds;
    await start();
    fake.focusWindow(w1.windowId);
    await fake.settle();
    await activate(t2);
    fake.moveTab(t1, w2.windowId);
    await fake.settle();
    // Moving t1 activated it in w2, but w1 still has focus.
    assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: t2 });
    assert.deepEqual(await press(), { windowId: w2.windowId, tabId: t1 });
  });

  test('two key presses in quick succession toggle there and back', async () => {
    const { tabIds: [t1, t2] } = fake.addWindow({ tabs: 2 });
    await start();
    await activate(t2);
    fake.pressShortcut();
    fake.pressShortcut();
    await fake.settle();
    assert.equal(fake.current()?.tabId, t2);
    fake.pressShortcut();
    fake.pressShortcut();
    fake.pressShortcut();
    await fake.settle();
    assert.equal(fake.current()?.tabId, t1);
  });

  test('a replaced tab keeps its slot in the history', async () => {
    const { tabIds: [, t2, t3, t4] } = fake.addWindow({ tabs: 4 });
    await start();
    await activate(t2);
    await activate(t3);
    await activate(t4);
    const t3New = fake.replaceTab(t3);
    await fake.settle();
    assert.equal((await press())?.tabId, t3New);
    assert.equal((await press())?.tabId, t4);
  });

  test('a replaced tab keeps its slot when the replacement wakes the worker', async () => {
    const { tabIds: [, t2, t3, t4] } = fake.addWindow({ tabs: 4 });
    await start();
    await activate(t2);
    await activate(t3);
    await activate(t4);
    fake.stopWorker();
    await fake.startWorker(MODULE_URL);
    const t3New = fake.replaceTab(t3);
    await fake.settle();
    assert.equal((await press())?.tabId, t3New);
    assert.equal((await press())?.tabId, t4);
  });

  test('a replaced tab that is activated right after is not listed twice', async () => {
    const { tabIds: [t1, t2] } = fake.addWindow({ tabs: 2 });
    await start();
    await activate(t2);
    const t2New = fake.replaceTab(t2, { activation: 'after' });
    await fake.settle();
    assert.deepEqual(fake.storage.session.data.mru, [t2New, t1]);
    assert.equal((await press())?.tabId, t1);
    assert.equal((await press())?.tabId, t2New);
  });

  test('a replaced tab that was activated before the replacement is not listed twice', async () => {
    const { tabIds: [t1, t2] } = fake.addWindow({ tabs: 2 });
    await start();
    await activate(t2);
    const t2New = fake.replaceTab(t2, { activation: 'before' });
    await fake.settle();
    assert.deepEqual(fake.storage.session.data.mru, [t2New, t1]);
  });

  test('remembers at most 100 tabs, and they survive a restart', async () => {
    const { tabIds } = fake.addWindow({ tabs: 120 });
    await start();
    for (const id of tabIds) fake.activateTab(id);
    await fake.settle();
    const mru = fake.storage.session.data.mru;
    assert.equal(mru.length, 100);
    assert.equal(mru[0], tabIds[119]);
    assert.equal(mru[99], tabIds[20]);
    await start();
    assert.equal((await press())?.tabId, tabIds[118]);
    assert.equal((await press())?.tabId, tabIds[119]);
  });
});
