let lastTabIds: chrome.tabs.TabActiveInfo[] = [];
loadLastTabIds();

/**
 * loadLastTabIds loads the list of tabs from persistent storage.
 *
 * This extension persists the list of tabs across browser restarts, so that
 * switching works after a Chrome restart.
 */
async function loadLastTabIds() {
  const storage = await chrome.storage.sync.get({ 'lastTabIds': '[]' });
  lastTabIds = JSON.parse(storage['lastTabIds'] ?? '[]');
  console.log('loaded lastTabIds, got', lastTabIds);
  cleanUpTabs();
}

/** Persists the list of tab IDs to storage. */
function saveLastTabIds() {
  chrome.storage.sync.set({ 'lastTabIds': JSON.stringify(lastTabIds) });
  console.log('stored', lastTabIds.length, 'tabs.');
}

/** tabActivated records that the given tab is now the most recently used tab. */
function tabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
  console.log('activated tab', activeInfo);
  if (lastTabIds.length > 0 && lastTabIds[lastTabIds.length - 1].tabId == activeInfo.tabId) {
    console.log('same tab as last');
    return;
  }
  lastTabIds.push(activeInfo);
  saveLastTabIds();
}

/**
 * Focusing windows is handled differently from switching tabs by Chrome
 * (there's no additional tab activated event); we need to record both
 * operations so that switching tabs across windows works.
 */
async function windowFocused() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTabs.length !== 1) {
    return;  // e.g. a developer tools window that has no tabs
  }
  const activeTab = activeTabs[0];
  if (!activeTab.id) {
    return;
  }
  tabActivated({ tabId: activeTab.id, windowId: activeTab.windowId })
}

/** Removes tabs from our list when they are removed (e.g. closed). */
function tabRemoved(tabId: number) {
  for (let i = lastTabIds.length - 1; i >= 0; i--) {
    if (lastTabIds[i].tabId === tabId) {
      lastTabIds.splice(i, 1);
    }
  }
}

/** cleanUpTabs removes stale entries from `lastTabIds`, i.e. tabs that no longer exist. */
async function cleanUpTabs() {
  let removed = 0;
  for (let i = lastTabIds.length - 1; i >= 0; i--) {
    const someTabId = lastTabIds[i];
    let tab;
    try {
      tab = await chrome.tabs.get(someTabId.tabId);
    } catch (e) {
      console.log('previous tab no longer exists at', i, ', removing.');
      lastTabIds.splice(i, 1);
      removed++;
    }
  }
  console.log('cleanUpTabs: removed', removed, 'tabs.');
}

/**
 * activatePreviousTab switches to the previously used tab, it's the main
 * action of this extension.
 */
async function activatePreviousTab() {
  console.log('activate previous tab triggered. Have', lastTabIds.length, 'tabs');
  if (lastTabIds.length <= 1) {
    console.log('no previous tabs');
    return;
  }
  // Handle the case where a previous tab no longer exists by attempting to
  // switch to tabs in order, existing on first success.
  for (let i = lastTabIds.length - 2; i >= 0; i--) {
    const previousTab = lastTabIds[i];
    let tab;
    try {
      tab = await chrome.tabs.get(previousTab.tabId);
    } catch (e) {
      console.log('previous tab no longer exists at', i, ', removing.');
      lastTabIds.splice(i, 1);
      continue;
    }
    if (tab) {
      console.log('found tab, activating', i, previousTab.tabId);
      // Also focus the window, in case the tab is in a different (background)
      // window.
      chrome.windows.update(previousTab.windowId, { focused: true });
      chrome.tabs.update(previousTab.tabId, { active: true });
      return;
    }
  }
}

console.log('extension loading, adding listeners');
chrome.tabs.onActivated.addListener(tabActivated);
chrome.tabs.onRemoved.addListener(tabRemoved)
chrome.windows.onFocusChanged.addListener(windowFocused);
chrome.commands.onCommand.addListener((command: string) => {
  if (command !== 'previous-tab') {
    console.error('unknown command', command);
    return;
  }
  activatePreviousTab();
});
windowFocused();

export { };