import { groupByDomain, removeFromShelf, removeDomain, applyOrder, moveDomain } from './shelf.js';
import { stashedTab } from './stash.js';

const grid = document.getElementById('grid');
const folder = document.getElementById('folder');
const empty = document.getElementById('empty');
const back = document.getElementById('back');
const header = document.querySelector('header');
const heading = document.getElementById('heading');
const closeAll = document.getElementById('close-all');
const actions = document.getElementById('actions');
const cacheTabs = document.getElementById('cache-tabs');
const masthead = document.getElementById('masthead');
const count = document.getElementById('count');
const clearDock = document.getElementById('clear-dock');
const keepOpenButton = document.getElementById('keep-open');

// The same page runs in the side panel and as each window's pinned home tab.
const isPanel = !new URLSearchParams(location.search).has('home');
if (!isPanel) document.body.classList.add('home');

let shelf = [];
let order = [];
let keepOpen = false;
let dragging = null;
let openDomain = null;
// Where focus should land after the next render, as { key, index }. Renders rebuild every node, so focus is
// carried over by key (domain for tiles, URL for rows), falling back to the same position.
let restoreFocus = null;

function favicon(url, size) {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`);
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// The background owns all shelf writes (it serializes them with docking), so changes go to it as messages.
async function removeFromDock(urls, closeTabs) {
  const res = await chrome.runtime.sendMessage({ type: 'remove', urls, closeTabs });
  if (res?.error) throw new Error(res.error);
}

// Takes items off the shelf and closes their stashed tabs, so nothing is left behind in the group.
async function removeItems(next) {
  await removeFromDock(shelf.filter((i) => !next.includes(i)).map((i) => i.url), true);
}

async function openItem(item) {
  // New-tab pages are never shelved, so a blank one would be left behind: reuse it or close it.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const blank = active?.url === 'chrome://newtab/';
  const tab = await stashedTab(item);
  if (tab) {
    await chrome.tabs.ungroup(tab.id);
    if (tab.windowId !== active.windowId) await chrome.tabs.move(tab.id, { windowId: active.windowId, index: -1 });
    await chrome.tabs.update(tab.id, { active: true });
    if (blank) await chrome.tabs.remove(active.id);
  } else if (blank) {
    await chrome.tabs.update(active.id, { url: item.url });
  } else {
    await chrome.tabs.create({ url: item.url });
  }
  await removeFromDock([item.url], false);
  // Opening a tab is usually the end of a trip to the panel, so it gets out of the way unless told to stay.
  // window.close() in a side panel closes the panel.
  if (isPanel && !keepOpen) window.close();
}

// Tiles in the grid or rows in the open folder: whatever the arrow keys move between.
function navItems() {
  return [...(openDomain ? folder.querySelectorAll('.row') : grid.querySelectorAll('.tile'))];
}

function render() {
  const focused = document.activeElement?.dataset.key ? document.activeElement : null;
  const prior = restoreFocus ?? (focused && { key: focused.dataset.key, index: navItems().indexOf(focused) });
  restoreFocus = null;

  const groups = applyOrder(groupByDomain(shelf), order);
  const current = groups.find((g) => g.domain === openDomain);
  // A folder that dropped back to one item turns back into an app, so leave the folder view.
  if (!current || current.kind === 'app') openDomain = null;

  empty.hidden = groups.length > 0;
  grid.hidden = openDomain !== null;
  folder.hidden = openDomain === null;
  header.hidden = openDomain === null;
  actions.hidden = openDomain !== null;
  clearDock.hidden = groups.length === 0;
  masthead.hidden = isPanel || openDomain !== null;
  count.textContent = shelf.length ? `${shelf.length} ${shelf.length === 1 ? 'tab' : 'tabs'} docked` : '';
  cacheTabs.hidden = !shelf.some((i) => i.tabId != null);
  heading.textContent = openDomain ?? '';
  keepOpenButton.setAttribute('aria-pressed', String(keepOpen));

  if (openDomain) {
    folder.replaceChildren(...current.items.map(folderRow));
  } else {
    grid.replaceChildren(...groups.map(tile));
  }

  if (prior) {
    const items = navItems();
    (items.find((n) => n.dataset.key === prior.key) ?? items[Math.min(prior.index, items.length - 1)])?.focus();
  }
}

function openFolder(domain) {
  openDomain = domain;
  restoreFocus = { key: null, index: 0 };
  render();
}

function leaveFolder() {
  restoreFocus = { key: openDomain, index: 0 };
  openDomain = null;
  render();
}

function tile(group) {
  const [first] = group.items;
  // Images are draggable on their own, which would drag the favicon URL instead of the tile.
  const icon = el('div', { className: 'icon' }, [el('img', { src: favicon(first.url, 32), alt: '', draggable: false })]);
  if (group.kind === 'folder') icon.append(el('span', { className: 'badge', textContent: group.items.length }));

  const node = el('button', {
    className: `tile ${group.kind}`,
    title: group.kind === 'app' ? first.title : `${group.items.length} tabs from ${group.domain}`,
  }, [icon, el('span', { className: 'label', textContent: group.domain })]);
  node.dataset.key = group.domain;

  node.addEventListener('click', () => {
    if (group.kind === 'app') {
      openItem(first).catch(console.error);
    } else {
      openFolder(group.domain);
    }
  });

  // A sibling of the tile button rather than a child, since buttons can't nest.
  const remove = el('button', {
    className: 'remove tile-remove',
    textContent: '×',
    title: group.kind === 'app' ? 'Remove from dock' : `Remove all ${group.items.length} tabs`,
  });
  remove.addEventListener('click', () => removeItems(removeDomain(shelf, group.domain)).catch(console.error));
  const wrap = el('div', { className: 'tile-wrap', draggable: true }, [node, remove]);
  wrap.dataset.domain = group.domain;
  wrap.addEventListener('dragstart', (e) => {
    dragging = group.domain;
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('dragend', () => {
    dragging = null;
    wrap.classList.remove('dragging');
    clearDropMarkers();
  });
  wrap.addEventListener('dragover', (e) => {
    if (!dragging || dragging === group.domain) return;
    e.preventDefault();
    clearDropMarkers();
    wrap.classList.add(dropsAfter(e, wrap) ? 'drop-after' : 'drop-before');
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragging || dragging === group.domain) return;
    const shown = [...grid.querySelectorAll('.tile-wrap')].map((w) => w.dataset.domain);
    const next = moveDomain(shown, dragging, group.domain, dropsAfter(e, wrap));
    chrome.storage.local.set({ order: next }).catch(console.error);
  });
  return wrap;
}

function dropsAfter(e, wrap) {
  const box = wrap.getBoundingClientRect();
  return e.clientX > box.left + box.width / 2;
}

function clearDropMarkers() {
  grid.querySelectorAll('.drop-before, .drop-after').forEach((w) => w.classList.remove('drop-before', 'drop-after'));
}

function folderRow(item) {
  const { pathname, search } = new URL(item.url);
  const remove = el('button', { className: 'remove', textContent: '×', title: 'Remove from dock' });
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeItems(removeFromShelf(shelf, item.url)).catch(console.error);
  });

  const row = el('div', { className: 'row', title: item.url, tabIndex: 0, role: 'button' }, [
    el('img', { src: favicon(item.url, 16), alt: '' }),
    el('div', { className: 'text' }, [
      el('div', { className: 'title', textContent: item.title }),
      el('div', { className: 'meta', textContent: `${pathname}${search} · ${ago(item.shelvedAt)}` }),
    ]),
    remove,
  ]);
  row.dataset.key = item.url;
  row.addEventListener('click', () => openItem(item).catch(console.error));
  return row;
}

closeAll.addEventListener('click', () => {
  removeItems(removeDomain(shelf, openDomain)).catch(console.error);
});

back.addEventListener('click', leaveFolder);

// The home tab is a tab, not the panel, so keeping it open means nothing there.
keepOpenButton.hidden = !isPanel;
keepOpenButton.addEventListener('click', () => {
  chrome.storage.local.set({ keepOpen: !keepOpen }).catch(console.error);
});

cacheTabs.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'cache' }).catch(console.error);
});

// Clearing can close a lot of live tabs with no undo, so it asks first, with Cancel focused.
const confirmClear = document.getElementById('confirm-clear');
const confirmCancel = document.getElementById('confirm-cancel');
function askClear(asking) {
  confirmClear.hidden = !asking;
  cacheTabs.classList.toggle('asking', asking);
  clearDock.classList.toggle('asking', asking);
  if (asking) {
    document.getElementById('confirm-text').textContent =
      `Remove all ${shelf.length} ${shelf.length === 1 ? 'tab' : 'tabs'} from the dock and close them?`;
    confirmCancel.focus();
  } else {
    clearDock.focus();
  }
}
clearDock.addEventListener('click', () => askClear(true));
confirmCancel.addEventListener('click', () => askClear(false));
confirmClear.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  askClear(false);
});
document.getElementById('confirm-ok').addEventListener('click', () => {
  confirmClear.hidden = true;
  cacheTabs.classList.remove('asking');
  clearDock.classList.remove('asking');
  removeItems([]).catch(console.error);
});

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (openDomain && ['Escape', 'Backspace', 'ArrowLeft'].includes(e.key)) {
    e.preventDefault();
    leaveFolder();
    return;
  }

  const items = navItems();
  const at = items.indexOf(document.activeElement);
  const cols = openDomain ? 1 : getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const step = { ArrowDown: cols, ArrowUp: -cols, ...(openDomain ? {} : { ArrowRight: 1, ArrowLeft: -1 }) }[e.key];
  if (step !== undefined) {
    e.preventDefault();
    // Nothing selected yet: the first arrow press selects the first item rather than moving.
    const next = at === -1 ? 0 : Math.max(0, Math.min(items.length - 1, at + step));
    items[next]?.focus();
    return;
  }
  if (at === -1) return;

  const key = items[at].dataset.key;
  if (e.key === 'Delete') {
    e.preventDefault();
    restoreFocus = { key: null, index: at };
    const next = openDomain ? removeFromShelf(shelf, key) : removeDomain(shelf, key);
    removeItems(next).catch(console.error);
  } else if (openDomain && (e.key === 'Enter' || e.key === ' ')) {
    // Tiles are buttons and handle Enter themselves; rows are divs.
    e.preventDefault();
    const item = shelf.find((i) => i.url === key);
    if (item) openItem(item).catch(console.error);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.shelf || changes.order || changes.keepOpen)) return;
  if (changes.shelf) shelf = changes.shelf.newValue ?? [];
  if (changes.order) order = changes.order.newValue ?? [];
  if (changes.keepOpen) keepOpen = changes.keepOpen.newValue ?? false;
  render();
});

({ shelf = [], order = [], keepOpen = false } = await chrome.storage.local.get(['shelf', 'order', 'keepOpen']));
render();

if (isPanel) {
  // A freshly opened panel has keyboard focus; select the first tile so the arrow keys and Enter work at once.
  navItems()[0]?.focus();

  // Tell the background this window's panel is open, so the shortcut knows to close it.
  const { id: windowId } = await chrome.windows.getCurrent();
  const connect = () => {
    const port = chrome.runtime.connect({ name: 'panel' });
    // The service worker was stopped or restarted; check in with the new one.
    port.onDisconnect.addListener(connect);
    port.postMessage({ windowId });
  };
  connect();
}
