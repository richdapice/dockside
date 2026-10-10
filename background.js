import { shelvable, addToShelf } from './shelf.js';
import { inStash, stashTab, stashedTab, STASH_TITLE, LEGACY_STASH_TITLE } from './stash.js';

// Wait before shelving so a tab the user just closed (or bounced straight back to) is left alone.
const SETTLE_MS = 500;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  seedLastActive().catch(console.error);
  ensureHomeEverywhere().catch(console.error);
  relinkStash();
});
// Opening a side panel that's already open leaves keyboard focus on the page, so after opening, the panel is asked
// to take focus itself.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'focus-launcher' || !tab) return;
  // open() has to run inside the shortcut's user gesture, so nothing may be awaited before it.
  chrome.sidePanel.open({ windowId: tab.windowId })
    .then(() => chrome.runtime.sendMessage({ type: 'focus-launcher', windowId: tab.windowId }))
    .catch((e) => {
      // A panel that was just opened hasn't loaded its listener yet; it gets focus from being opened anyway.
      if (!e.message.includes('Receiving end does not exist')) console.error(e);
    });
});

chrome.runtime.onStartup.addListener(() => {
  seedLastActive().catch(console.error);
  ensureHomeEverywhere().catch(console.error);
  relinkStash();
});

// Tabs already active at install or browser startup never fire onActivated, so record them up front;
// otherwise the first tab left in each window would never be shelved.
async function seedLastActive() {
  const active = await chrome.tabs.query({ active: true });
  await chrome.storage.session.set({ lastActive: Object.fromEntries(active.map((t) => [t.windowId, t.id])) });
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
  // windows.get rejects when the window closed before we got to it; nothing to do then.
  const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
  if (!win || win.type !== 'normal') return;
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

async function forget(tabId) {
  const { shelf = [] } = await chrome.storage.local.get('shelf');
  if (shelf.some((i) => i.tabId === tabId)) {
    await chrome.storage.local.set({ shelf: shelf.filter((i) => i.tabId !== tabId) });
  }
}

// Clicking a tab in the expanded group means the user wants it back.
async function unstashIfShelved(tabId) {
  // tabs.get rejects if the tab closed right after activating.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !(await inStash(tab))) return;
  await chrome.tabs.ungroup(tabId);
  await forget(tabId);
  const [group] = await chrome.tabGroups.query({ windowId: tab.windowId, title: STASH_TITLE });
  if (group) await chrome.tabGroups.update(group.id, { collapsed: true });
}

// Tab ids don't survive a browser restart, but Chrome restores the stash groups. Drop every stored id (an old id
// could now belong to an unrelated tab) and re-attach items to restored stash tabs by URL.
function relinkStash() {
  shelving = shelving.then(async () => {
    for (const g of await chrome.tabGroups.query({ title: LEGACY_STASH_TITLE })) {
      await chrome.tabGroups.update(g.id, { title: STASH_TITLE });
    }
    const groups = await chrome.tabGroups.query({ title: STASH_TITLE });
    const unclaimed = (await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })))).flat();
    const { shelf = [] } = await chrome.storage.local.get('shelf');
    const next = shelf.map((item) => {
      const i = unclaimed.findIndex((t) => t.url === item.url);
      return { ...item, tabId: i === -1 ? null : unclaimed.splice(i, 1)[0].id };
    });
    // Skip the write when nothing moved, so this read-modify-write can't clobber a shelf change made meanwhile.
    if (next.some((item, i) => item.tabId !== shelf[i].tabId)) await chrome.storage.local.set({ shelf: next });
  }).catch(console.error);
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

async function shelve(tabId) {
  // tabs.get rejects when the tab is gone, which here means the user closed it during the settle window.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active || !shelvable(tab)) return;

  const { shelf = [] } = await chrome.storage.local.get('shelf');
  const replaced = shelf.find((i) => i.url === tab.url && i.tabId !== tab.id);
  await chrome.storage.local.set({ shelf: addToShelf(shelf, tab, Date.now()) });
  await stashTab(tab);

  // The same page shelved twice keeps only the newer tab, so the stash doesn't fill with duplicates.
  const old = replaced && (await stashedTab(replaced));
  if (old) await chrome.tabs.remove(old.id);
}
