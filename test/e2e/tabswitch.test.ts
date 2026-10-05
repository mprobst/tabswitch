/**
 * End-to-end tests for the "previous tab" shortcut, in a real browser. See
 * harness.ts for requirements. Run with `xvfb-run -a npm run test:e2e`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Browser, skipReason } from './harness.ts';

const SHORTCUT = 'ctrl+q';

describe('tabswitch', { skip: skipReason() }, () => {
  let b: Browser;
  beforeEach(async () => {
    b = await Browser.launch({ targetScript: 'tab_listener.js' });
  });
  afterEach(async () => {
    await b?.close();
  });

  test('toggles between the two most recent tabs', async () => {
    const { tabIds: [t1, t2] } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t2);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
  });

  test('works right after the extension was installed', async () => {
    // The extension was installed while the browser's initial tab was active.
    const { windowId, tabId: initial } = await b.current();
    assert.ok(windowId !== null, 'expected exactly one focused window');
    const t1 = await b.newTab(windowId, { active: true });
    await b.idle();
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, initial);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
  });

  test('toggles after the service worker was suspended', async () => {
    const { tabIds: [t1, t2] } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.stopTarget();
    // The key press is the event that wakes the worker up.
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
  });

  test('a tab activation that wakes the worker keeps the history', async () => {
    const { tabIds: [t1, t2, t3] } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.stopTarget();
    await b.activate(t3);  // wakes the worker
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t2);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t3);
  });

  test('switches across windows', async () => {
    const w1 = await b.newWindow(1);
    const w2 = await b.newWindow(1);
    await b.activate(w1.tabIds[0]);
    await b.activate(w2.tabIds[0]);
    assert.deepEqual(await b.pressAndSettle(SHORTCUT), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    assert.deepEqual(await b.pressAndSettle(SHORTCUT), { windowId: w2.windowId, tabId: w2.tabIds[0] });
  });

  test('skips a closed tab', async () => {
    const { tabIds: [t1, t2, t3] } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.activate(t3);
    await b.closeTab(t2);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
  });

  test('closing a tab visited in between does not make "previous" the current tab', async () => {
    const { tabIds: [t1, t2, t3] } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.activate(t3);
    await b.activate(t2);
    await b.closeTab(t3);
    // History is t1, t2, t3, t2; with t3 gone the previous tab is t1.
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
  });

  test('closing the active tab', async () => {
    const { tabIds: [t1, t2, t3] } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.activate(t3);
    await b.closeTab(t3);  // Chrome activates the neighbour, t2
    assert.equal((await b.current()).tabId, t2);
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t1);
  });

  test('ignores popup windows', async () => {
    const w = await b.newWindow(2);
    const [t1, t2] = w.tabIds;
    await b.activate(t1);
    await b.activate(t2);
    // e.g. an OAuth or Meet picture-in-picture style window takes focus...
    await b.newWindow(1, { type: 'popup' });
    await b.idle();
    // ...and the user goes back to the main window.
    await b.focusWindow(w.windowId);
    assert.deepEqual(await b.pressAndSettle(SHORTCUT), { windowId: w.windowId, tabId: t1 });
  });

  test('follows a tab that was moved to another window', async () => {
    const w1 = await b.newWindow(2);
    const w2 = await b.newWindow(1);
    const [t1, t2] = w1.tabIds;
    await b.activate(t1);
    await b.activate(t2);
    await b.drv(({ t1, w2 }) => chrome.tabs.move(t1, { windowId: w2, index: -1 }), { t1, w2: w2.windowId });
    await b.idle();
    // Moving t1 activated it in w2, but w1 still has focus.
    assert.deepEqual(await b.current(), { windowId: w1.windowId, tabId: t2 });
    assert.deepEqual(await b.pressAndSettle(SHORTCUT), { windowId: w2.windowId, tabId: t1 });
  });

  test('ignores tab activations in background windows', async () => {
    const w1 = await b.newWindow(2);
    const w2 = await b.newWindow(2);
    await b.activate(w2.tabIds[0]);
    await b.activate(w1.tabIds[0]);
    await b.activate(w1.tabIds[1]);
    // Something activates a tab in the unfocused window (e.g. a tab closing
    // there). The user never looked at it.
    await b.drv((id) => chrome.tabs.update(id, { active: true }), w2.tabIds[1]);
    await b.idle();
    assert.deepEqual(await b.pressAndSettle(SHORTCUT), { windowId: w1.windowId, tabId: w1.tabIds[0] });
  });

  test('pressing the shortcut twice quickly returns to the starting tab', async () => {
    const { tabIds: [t1, t2] } = await b.newWindow(2);
    await b.activate(t1);
    await b.activate(t2);
    assert.equal((await b.pressAndSettle(`${SHORTCUT} ${SHORTCUT}`)).tabId, t2);
    assert.equal((await b.pressAndSettle(`${SHORTCUT} ${SHORTCUT} ${SHORTCUT}`)).tabId, t1);
  });

  test('a long history survives a worker restart', async () => {
    const { tabIds: [t1, t2, t3, t4] } = await b.newWindow(4);
    await b.activate(t1);
    // Lots of switching, e.g. a busy hour of work. This used to exceed the
    // storage.sync write and size quotas, silently dropping later saves.
    await b.drv(async ([t1, t2]) => {
      for (let i = 0; i < 150; i++) {
        await chrome.tabs.update(i % 2 ? t1 : t2, { active: true });
        await new Promise((r) => setTimeout(r, 10));
      }
    }, [t1, t2]);
    await b.activate(t3);
    await b.activate(t4);
    await b.stopTarget();
    assert.equal((await b.pressAndSettle(SHORTCUT)).tabId, t3);
  });
});
