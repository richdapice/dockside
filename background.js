import { shelvable, addToShelf, domainOf } from './shelf.js';
import {
  inStash, stashTab, stashedTab, closeStashed, stashGroupIds, stashGroupIn, adoptStashGroup, retitleStash,
  isStashTitle, ifGone,
} from './stash.js';

// Wait before shelving so a tab the user just closed (or bounced straight back to) is left alone.
const SETTLE_MS = 500;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  seedLastActive();
  ensureHomeEverywhere().catch(console.error);
  relinkStash();
});
// Each open side panel keeps a port to us, so the shortcut knows which windows have one open without awaiting
// anything (sidePanel.open() needs the shortcut's user gesture, which an await can lose).
const panels = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  let windowId = null;
  port.onMessage.addListener((msg) => {
    windowId = msg.windowId;
    panels.add(windowId);
  });
  port.onDisconnect.addListener(() => {
    if (windowId !== null) panels.delete(windowId);
  });
});

// The shortcut opens the panel, or closes it if it's already open.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-panel' || !tab) return;
  const { windowId } = tab;
  if (panels.has(windowId)) chrome.sidePanel.close({ windowId }).catch(console.error);
  else chrome.sidePanel.open({ windowId }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  seedLastActive();
  ensureHomeEverywhere().catch(console.error);
  relinkStash();
});

// Tabs already active at install or browser startup never fire onActivated, so record them up front;
// otherwise the first tab left in each window would never be shelved. Runs on the activations queue so it can't
// overwrite an activation recorded meanwhile.
function seedLastActive() {
  activations = activations.then(async () => {
    const active = await chrome.tabs.query({ active: true });
    await chrome.storage.session.set({ lastActive: Object.fromEntries(active.map((t) => [t.windowId, t.id])) });
  }).catch(console.error);
}

const HOME_URL = chrome.runtime.getURL('panel.html?home');

// Shelving leaves a window with only the current tab, and closing that would close the window. Every normal
// window keeps a pinned launcher tab, which is never shelved, so the window survives. If it's closed, it comes back.
chrome.windows.onCreated.addListener((win) => ensureHome(win.id), { windowTypes: ['normal'] });
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  if (!isWindowClosing) ensureHome(windowId);
});
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => ensureHome(oldWindowId));

async function ensureHomeEverywhere() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  windows.forEach((win) => ensureHome(win.id));
}

// Serialized so overlapping events (e.g. startup plus a restored window) can't add two homes to one window.
let homes = Promise.resolve();
function ensureHome(windowId) {
  homes = homes.then(() => addHomeIfMissing(windowId)).catch(console.error);
}

async function addHomeIfMissing(windowId) {
  // The window may have closed before we got to it.
  const win = await chrome.windows.get(windowId, { populate: true }).catch(ifGone);
  // Extension pages can't load in incognito windows (spanning mode).
  if (!win || win.type !== 'normal' || win.incognito) return;
  // A tab created moments ago may only have pendingUrl set.
  if (win.tabs.some((t) => (t.url || t.pendingUrl) === HOME_URL)) return;
  await chrome.tabs.create({ windowId, url: HOME_URL, pinned: true, index: 0, active: false });
}

// Both stores are read-modify-write and events can arrive back to back, so each gets its own serial queue.
let activations = Promise.resolve();
let shelving = Promise.resolve();

chrome.tabs.onActivated.addListener((info) => {
  activations = activations.then(() => recordActivation(info)).catch(console.error);
  shelving = shelving.then(() => unstashIfShelved(info.tabId)).catch(console.error);
});

// Closing a shelved tab from inside the expanded group takes it off the shelf. A whole window closing doesn't:
// those items stay and reopen from their URL.
chrome.tabs.onRemoved.addListener((tabId, { isWindowClosing }) => {
  if (!isWindowClosing) shelving = shelving.then(() => forget(tabId)).catch(console.error);
});

// The chip's count follows tabs joining or leaving the group, closing, or moving to another window.
chrome.tabs.onUpdated.addListener((tabId, { groupId }, tab) => {
  if (groupId !== undefined) retitleSoon(tab.windowId);
});
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  if (!isWindowClosing) retitleSoon(windowId);
});
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => retitleSoon(oldWindowId));

function retitleSoon(windowId) {
  shelving = shelving.then(() => retitleStash(windowId)).catch(console.error);
}

// Docked pages can still navigate (redirects, single-page apps). Each item follows its tab's URL, so the dock
// reopens what the tab really shows, and after an extension reload or browser restart the group and its tabs can
// still be matched to the dock by URL instead of being left behind for a second group.
chrome.tabs.onUpdated.addListener((tabId, { url }) => {
  if (url) shelving = shelving.then(() => follow(tabId, url)).catch(console.error);
});

async function follow(tabId, url) {
  if (!/^https?:\/\//.test(url)) return;
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  const item = shelf.find((i) => i.tabId === tabId);
  if (!item || item.url === url) return;
  // Landing on a page that's already docked keeps only this tab, as docking it twice would.
  const replaced = shelf.find((i) => i.url === url);
  const next = shelf
    .filter((i) => i !== replaced)
    .map((i) => (i === item ? { ...i, url, domain: domainOf(url) } : i));
  await chrome.storage.local.set({ shelf: next });
  const old = replaced && (await stashedTab(replaced));
  if (old) await chrome.tabs.remove(old.id);
}

async function forget(tabId) {
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  if (shelf.some((i) => i.tabId === tabId)) {
    await chrome.storage.local.set({ shelf: shelf.filter((i) => i.tabId !== tabId) });
  }
}

// Clicking a tab in the expanded group means the user wants it back.
async function unstashIfShelved(tabId) {
  // The tab may have closed right after activating.
  const tab = await chrome.tabs.get(tabId).catch(ifGone);
  if (!tab || !(await inStash(tab))) return;
  await chrome.tabs.ungroup(tabId);
  await forget(tabId);
  const group = await stashGroupIn(tab.windowId);
  if (group) await chrome.tabGroups.update(group.id, { collapsed: true });
}

// Tab ids change on a browser restart, and the stash group ids (in session storage) are lost on restart and on
// extension reload. Chrome restores the groups themselves, often after onStartup has already fired, so this also
// runs shortly after an untracked group with a stash title appears or changes.
let relinkTimer = null;
chrome.tabGroups.onCreated.addListener(relinkSoonIfStash);
chrome.tabGroups.onUpdated.addListener(relinkSoonIfStash);
function relinkSoonIfStash(group) {
  if (!isStashTitle(group.title)) return;
  stashGroupIds().then((ids) => {
    // Our own groups change title whenever the count does; those need no relink.
    if (ids.includes(group.id)) return;
    clearTimeout(relinkTimer);
    relinkTimer = setTimeout(relinkStash, 1000);
  }).catch(console.error);
}

function relinkStash() {
  shelving = shelving.then(relink).catch(console.error);
}

async function relink() {
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  const docked = new Set(shelf.map((i) => i.url));
  const titled = (await chrome.tabGroups.query({})).filter((g) => isStashTitle(g.title));
  for (const g of titled) {
    // Only adopt a group that holds docked pages, so a user's own group with a similar title stays theirs.
    const tabs = await chrome.tabs.query({ groupId: g.id });
    if (!tabs.some((t) => docked.has(t.url))) continue;
    await adoptStashGroup(g.id);
    await retitleStash(g.windowId);
  }

  // Items still linked to their live tab keep it. The rest claim a stash tab with the same URL, or lose their id
  // (an old id could now belong to an unrelated tab) and reopen from the URL.
  const live = await Promise.all(shelf.map(async (item) => {
    const tab = await stashedTab(item);
    return tab && tab.url === item.url ? tab : null;
  }));
  const claimed = new Set(live.filter(Boolean).map((t) => t.id));
  const unclaimed = (await Promise.all((await stashGroupIds()).map((id) => chrome.tabs.query({ groupId: id }))))
    .flat()
    .filter((t) => !claimed.has(t.id));
  const next = shelf.map((item, i) => {
    if (live[i]) return item;
    const j = unclaimed.findIndex((t) => t.url === item.url);
    return { ...item, tabId: j === -1 ? null : unclaimed.splice(j, 1)[0].id };
  });
  // Skip the write when nothing moved, to keep writes to a minimum.
  if (next.some((item, i) => item.tabId !== shelf[i].tabId)) await chrome.storage.local.set({ shelf: next });
}

async function recordActivation({ tabId, windowId }) {
  // The service worker can be killed between events, so the last active tab per window lives in session storage.
  const { lastActive = {} } = await chrome.storage.session.get('lastActive');
  const prev = lastActive[windowId];
  lastActive[windowId] = tabId;
  await chrome.storage.session.set({ lastActive });

  if (prev !== undefined && prev !== tabId) {
    setTimeout(() => {
      shelving = shelving.then(() => shelve(prev)).catch(console.error);
    }, SETTLE_MS);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // "Cache tabs" in the launcher.
  if (msg.type === 'cache') {
    shelving = shelving.then(cacheAll).catch(console.error);
    return;
  }
  // The launcher's removals go through the same queue as docking, so the two can't overwrite each other's writes.
  if (msg.type === 'remove') {
    const done = shelving.then(() => removeUrls(msg.urls, msg.closeTabs));
    shelving = done.catch(console.error);
    done.then(() => sendResponse({}), (e) => sendResponse({ error: e.message }));
    return true;
  }
});

// Closes every docked tab to free memory, keeping the items: with no tab, an item reopens from its URL, and the
// dock in storage.local survives a restart. The items are unlinked first so forget() doesn't drop them as their
// tabs close.
async function cacheAll() {
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  const live = shelf.filter((i) => i.tabId != null);
  if (!live.length) return;
  await chrome.storage.local.set({ shelf: shelf.map((i) => ({ ...i, tabId: null })) });
  await closeStashed(live);
}

async function removeUrls(urls, closeTabs) {
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  const gone = shelf.filter((i) => urls.includes(i.url));
  if (!gone.length) return;
  await chrome.storage.local.set({ shelf: shelf.filter((i) => !urls.includes(i.url)) });
  if (closeTabs) await closeStashed(gone);
}

async function shelve(tabId) {
  // A tab that's gone was closed by the user during the settle window.
  const tab = await chrome.tabs.get(tabId).catch(ifGone);
  if (!tab || tab.active || !shelvable(tab)) return;

  // Stash before writing the shelf, so the panel never shows an item whose tab isn't in the group yet, and a
  // failed stash leaves no item behind.
  await stashTab(tab);
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  const replaced = shelf.find((i) => i.url === tab.url && i.tabId !== tab.id);
  await chrome.storage.local.set({ shelf: addToShelf(shelf, tab, Date.now()) });

  // The same page shelved twice keeps only the newer tab, so the stash doesn't fill with duplicates.
  const old = replaced && (await stashedTab(replaced));
  if (old) await chrome.tabs.remove(old.id);
}
