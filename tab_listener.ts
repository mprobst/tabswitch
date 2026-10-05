/**
 * Switch Tabs: toggle between the most recently used tabs.
 *
 * The extension keeps a most-recently-used (MRU) list of tab IDs, most recent
 * first. Each tab appears at most once, so closing tabs just removes them from
 * the list and the next-most-recent tab takes over.
 */

/** Tab IDs, most recently used first. Each ID appears at most once. */
let mru: number[] = [];

/** Upper bound on remembered tabs; anything older is irrelevant for toggling. */
const MAX_ENTRIES = 100;

/**
 * Loads the MRU list from session storage.
 *
 * MV3 service workers are terminated after ~30s of inactivity, so the list must
 * survive restarts of the worker. `storage.session` is the right scope for
 * that: it lives exactly as long as the browser session, which is also how
 * long tab IDs are valid (Chrome reassigns tab IDs after a restart).
 *
 * Every event handler awaits `ready` before touching `mru`, because the event
 * that woke up the worker is dispatched before this load completes.
 */
const ready: Promise<void> = (async () => {
  const stored = await chrome.storage.session.get({ mru: [] });
  const loaded: number[] = Array.isArray(stored['mru']) ? stored['mru'] : [];
  // Drop tabs that were closed while we weren't looking.
  const existing = new Set((await chrome.tabs.query({})).map(t => t.id));
  mru = loaded.filter(id => existing.has(id));
  console.log('loaded MRU list with', mru.length, 'tabs');
})();

function save() {
  chrome.storage.session.set({ mru }).catch(e => console.error('saving MRU failed', e));
}

/** Moves (or adds) the given tab to the front of the MRU list. */
function touch(tabId: number) {
  const i = mru.indexOf(tabId);
  if (i === 0) return;
  if (i > 0) mru.splice(i, 1);
  mru.unshift(tabId);
  if (mru.length > MAX_ENTRIES) mru.length = MAX_ENTRIES;
  save();
}

/** Removes the given tab from the MRU list. */
function forget(tabId: number) {
  const i = mru.indexOf(tabId);
  if (i < 0) return;
  mru.splice(i, 1);
  save();
}

/** Records the active tab of the given window as most recently used. */
async function touchActiveTabOf(windowId: number) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id !== undefined) touch(tab.id);
}

/**
 * Returns the active tab in the last focused *normal* window, i.e. the tab the
 * user is looking at, ignoring popups, picture-in-picture windows, devtools etc.
 */
async function currentTabId(): Promise<number | undefined> {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    return win.tabs?.find(t => t.active)?.id;
  } catch (e) {
    return undefined;  // no normal windows open
  }
}

/**
 * A tab was activated. Only count it as "used" if it happened in the focused
 * window: activations in background windows (e.g. Chrome picking a neighbour
 * after a tab closes there) aren't something the user looked at. If the window
 * gets focused later, onFocusChanged records the tab then.
 */
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  const win = await chrome.windows.get(windowId).catch(() => undefined);
  if (win?.focused && win.type === 'normal') touch(tabId);
});

/**
 * Focusing a window doesn't fire onActivated, so record its active tab here.
 * The filter restricts this to normal windows; focus moving to anything else
 * (a Meet picture-in-picture or popup window, devtools, another application)
 * arrives as WINDOW_ID_NONE and is ignored.
 */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await ready;
  await touchActiveTabOf(windowId);
}, { windowTypes: ['normal'] });

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  forget(tabId);
});

/** Prerendering and similar mechanisms can swap a tab's ID; keep its MRU slot. */
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ready;
  const i = mru.indexOf(removedTabId);
  if (i < 0) return;
  mru.splice(i, 1, addedTabId);
  // The new ID may already have been recorded (e.g. it was activated before
  // this event arrived); keep only its most recent slot.
  const dup = mru.indexOf(addedTabId, i + 1);
  if (dup >= 0) mru.splice(dup, 1);
  save();
});

/**
 * Switches to the previously used tab, the main action of this extension.
 *
 * Rather than trusting that the head of the MRU list is the current tab, ask
 * Chrome what is actually active, so a missed or spurious event can't make the
 * toggle go to the wrong place (or nowhere).
 */
async function activatePreviousTab() {
  await ready;
  const current = await currentTabId();
  if (current !== undefined) touch(current);

  for (const tabId of [...mru]) {
    if (tabId === current) continue;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      forget(tabId);  // closed without us noticing
      continue;
    }
    try {
      // Activate first, then focus the window. Use the tab's *current* window,
      // since tabs can be moved between windows after we saw them.
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      console.log('switching to tab', tabId, 'failed, trying the next one', e);
      continue;
    }
    // Record the switch right away instead of waiting for onActivated /
    // onFocusChanged, so that a quick second key press toggles back.
    touch(tabId);
    return;
  }
  console.log('no previous tab to switch to');
}

/**
 * Key presses are handled one at a time. Otherwise a quick double press runs
 * two switches concurrently that both start from the same current tab and
 * end up in the same place, instead of toggling there and back.
 */
let switching: Promise<void> = Promise.resolve();

chrome.commands.onCommand.addListener((command: string) => {
  if (command !== 'previous-tab') {
    console.error('unknown command', command);
    return;
  }
  switching = switching.then(activatePreviousTab).catch(e => console.error('switching tabs failed', e));
});

/**
 * Seeds the list with the visible tab whenever the worker starts, so the
 * shortcut works right after the extension is installed, updated or
 * re-enabled (all of which clear session storage). The visible tab is by
 * definition the most recently used one, so this is also right on any other
 * wake-up.
 */
async function seed() {
  await ready;
  const current = await currentTabId();
  if (current !== undefined) touch(current);
}
seed();

export { };
