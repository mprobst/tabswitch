/**
 * End-to-end tests for the "previous tab" shortcut, in a real browser. See
 * harness.ts for requirements. Run with `xvfb-run -a npm run test:e2e`.
 */
import { expect } from '@playwright/test';
import { extensionTest, skipReason } from './harness.ts';

const SHORTCUT = 'ctrl+q';
const test = extensionTest('tab_listener.js');

test.describe('tabswitch', () => {
  const reason = skipReason();
  test.skip(reason !== undefined, reason);

  test('toggles between the two most recent tabs', async ({ b }) => {
    const {
      tabIds: [t1, t2],
    } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t2 });
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
  });

  test('works right after the extension was installed', async ({ b }) => {
    // The extension was installed while the browser's initial tab was active.
    const { windowId, tabId: initial } = await b.current();
    expect(windowId, 'exactly one focused window').not.toBeNull();
    const t1 = await b.newTab(windowId!, { active: true });
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: initial });
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
  });

  test('toggles after the service worker was suspended', async ({ b }) => {
    const {
      tabIds: [t1, t2],
    } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.stopTarget();
    // The key press is the event that wakes the worker up.
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
  });

  test('a tab activation that wakes the worker keeps the history', async ({ b }) => {
    const {
      tabIds: [t1, t2, t3],
    } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.stopTarget();
    await b.activate(t3); // wakes the worker
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t2 });
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t3 });
  });

  test('switches across windows', async ({ b }) => {
    const w1 = await b.newWindow(1);
    const w2 = await b.newWindow(1);
    await b.activate(w1.tabIds[0]);
    await b.activate(w2.tabIds[0]);
    b.key(SHORTCUT);
    await b.expectCurrent({ windowId: w1.windowId, tabId: w1.tabIds[0] });
    b.key(SHORTCUT);
    await b.expectCurrent({ windowId: w2.windowId, tabId: w2.tabIds[0] });
  });

  test('skips a closed tab', async ({ b }) => {
    const {
      tabIds: [t1, t2, t3],
    } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.activate(t3);
    await b.closeTab(t2);
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
  });

  test('closing a tab visited in between does not make "previous" the current tab', async ({
    b,
  }) => {
    const {
      tabIds: [t1, t2, t3],
    } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.activate(t3);
    await b.activate(t2);
    await b.closeTab(t3);
    // History is t1, t2, t3, t2; with t3 gone the previous tab is t1.
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
  });

  test('closing the active tab', async ({ b }) => {
    const {
      tabIds: [t1, t2, t3],
    } = await b.newWindow(3);
    await b.activate(t1);
    await b.activate(t2);
    await b.activate(t3);
    await b.closeTab(t3);
    await b.expectCurrent({ tabId: t2 }, 'Chrome activates the neighbour of the closed tab');
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t1 });
  });

  test('ignores popup windows', async ({ b }) => {
    const w = await b.newWindow(2);
    const [t1, t2] = w.tabIds;
    await b.activate(t1);
    await b.activate(t2);
    // e.g. an OAuth or Meet picture-in-picture style window takes focus...
    await b.newWindow(1, { type: 'popup' });
    // ...and the user goes back to the main window.
    await b.focusWindow(w.windowId);
    b.key(SHORTCUT);
    await b.expectCurrent({ windowId: w.windowId, tabId: t1 });
  });

  test('follows a tab that was moved to another window', async ({ b }) => {
    const w1 = await b.newWindow(2);
    const w2 = await b.newWindow(1);
    const [t1, t2] = w1.tabIds;
    await b.activate(t1);
    await b.activate(t2);
    await b.drv(({ t1, w2 }) => chrome.tabs.move(t1, { windowId: w2, index: -1 }), {
      t1,
      w2: w2.windowId,
    });
    // Moving t1 activated it in w2, but w1 still has focus.
    await b.expectCurrent({ windowId: w1.windowId, tabId: t2 });
    b.key(SHORTCUT);
    await b.expectCurrent({ windowId: w2.windowId, tabId: t1 });
  });

  test('ignores tab activations in background windows', async ({ b }) => {
    const w1 = await b.newWindow(2);
    const w2 = await b.newWindow(2);
    await b.activate(w2.tabIds[0]);
    await b.activate(w1.tabIds[0]);
    await b.activate(w1.tabIds[1]);
    // Something activates a tab in the unfocused window (e.g. a tab closing
    // there). The user never looked at it.
    await b.drv((id) => chrome.tabs.update(id, { active: true }), w2.tabIds[1]);
    await b.waitForHandlers();
    b.key(SHORTCUT);
    await b.expectCurrent({ windowId: w1.windowId, tabId: w1.tabIds[0] });
  });

  test('pressing the shortcut twice quickly returns to the starting tab', async ({ b }) => {
    const {
      tabIds: [t1, t2],
    } = await b.newWindow(2);
    await b.activate(t1);
    await b.activate(t2);
    b.key(`${SHORTCUT} ${SHORTCUT}`);
    await b.expectCurrent({ tabId: t2 });
    b.key(`${SHORTCUT} ${SHORTCUT} ${SHORTCUT}`);
    await b.expectCurrent({ tabId: t1 });
  });

  test('a long history survives a worker restart', async ({ b }) => {
    const {
      tabIds: [t1, t2, t3, t4],
    } = await b.newWindow(4);
    await b.activate(t1);
    // Lots of switching, e.g. a busy hour of work. This used to exceed the
    // storage.sync write and size quotas, silently dropping later saves.
    await b.drv(
      async ([t1, t2]) => {
        for (let i = 0; i < 150; i++) {
          await chrome.tabs.update(i % 2 ? t1 : t2, { active: true });
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      [t1, t2],
    );
    await b.activate(t3);
    await b.activate(t4);
    await b.stopTarget();
    b.key(SHORTCUT);
    await b.expectCurrent({ tabId: t3 });
  });
});
