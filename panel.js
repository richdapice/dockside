import { groupByDomain, removeFromShelf, removeDomain, arrange, pinAt, unpin, moveDomain } from './shelf.js';
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
let pins = {};
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

// A bar's visible buttons, left to right: the folder header's Back and Close all, or the footer's, which change
// with the dock and the Clear dock confirmation.
function barButtons(bar) {
  return [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
}

function render() {
  const focused = document.activeElement?.dataset.key ? document.activeElement : null;
  const prior = restoreFocus ?? (focused && { key: focused.dataset.key, index: navItems().indexOf(focused) });
  restoreFocus = null;

  const groups = arrange(groupByDomain(shelf), pins);
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
  cacheTabs.hidden = groups.length === 0;
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
  if (group.domain in pins) {
    const pin = el('button', { className: 'tile-pin', title: 'Pinned here. Click to unpin.', ariaLabel: `Unpin ${group.domain}` });
    pin.innerHTML = PIN_SVG;
    pin.addEventListener('click', () => savePins(unpin(pins, group.domain)));
    wrap.append(pin);
  }
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
    const index = moveDomain(shown, dragging, group.domain, dropsAfter(e, wrap)).indexOf(dragging);
    savePins(pinAt(pins, dragging, index));
  });
  return wrap;
}

const PIN_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" '
  + 'd="M10.2 1.3l4.5 4.5-1.4.6-2.6 2.6.4 3.4-1.3 1.3-2.9-2.9-3.6 3.6-.9-.9 3.6-3.6-2.9-2.9 1.3-1.3 3.4.4 2.6-2.6z"/></svg>';

function savePins(next) {
  chrome.storage.local.set({ pins: next }).catch(console.error);
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

  // In the folder header or the footer, ← → move between its buttons, and ↓ (header) or ↑ (footer) goes back to
  // the list. Esc in the header still leaves the folder, below.
  const bar = [header, actions].find((el) => el.contains(document.activeElement));
  if (bar) {
    const buttons = barButtons(bar);
    const b = buttons.indexOf(document.activeElement);
    const next = { ArrowLeft: b - 1, ArrowRight: b + 1 }[e.key];
    if (next !== undefined) {
      e.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, next))].focus();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (bar === header && e.key === 'ArrowDown') navItems()[0]?.focus();
      if (bar === actions && e.key === 'ArrowUp') navItems().at(-1)?.focus();
      return;
    }
    if (bar === actions) return;
  }

  if (openDomain && ['Escape', 'ArrowLeft'].includes(e.key)) {
    e.preventDefault();
    leaveFolder();
    return;
  }

  const items = navItems();
  const at = items.indexOf(document.activeElement);
  const cols = openDomain ? 1 : getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const step = { ArrowDown: cols, ArrowUp: -cols, ...(openDomain ? {} : { ArrowRight: 1, ArrowLeft: -1 }) }[e.key];
  // ↓ from the last row of tiles drops into the footer.
  if (!openDomain && e.key === 'ArrowDown' && at !== -1 && Math.floor(at / cols) === Math.floor((items.length - 1) / cols)) {
    e.preventDefault();
    barButtons(actions)[0]?.focus();
    return;
  }
  // ↑ from the first row of a folder goes up to Back and Close all.
  if (openDomain && e.key === 'ArrowUp' && at === 0) {
    e.preventDefault();
    barButtons(header)[0]?.focus();
    return;
  }
  if (step !== undefined) {
    e.preventDefault();
    // Nothing selected yet: the first arrow press selects the first item rather than moving.
    const next = at === -1 ? 0 : Math.max(0, Math.min(items.length - 1, at + step));
    items[next]?.focus();
    return;
  }
  if (at === -1) return;

  const key = items[at].dataset.key;
  // P pins the selected tile where it is, or unpins it.
  if (!openDomain && e.key === 'p') {
    e.preventDefault();
    restoreFocus = { key, index: at };
    savePins(key in pins ? unpin(pins, key) : pinAt(pins, key, at));
    return;
  }
  // Mac keyboards' delete key sends Backspace; Delete is fn+delete there and the Delete key elsewhere.
  if (e.key === 'Delete' || e.key === 'Backspace') {
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
  if (area !== 'local' || !(changes.shelf || changes.pins || changes.keepOpen)) return;
  if (changes.shelf) shelf = changes.shelf.newValue ?? [];
  if (changes.pins) pins = changes.pins.newValue ?? {};
  if (changes.keepOpen) keepOpen = changes.keepOpen.newValue ?? false;
  render();
});

({ shelf = [], pins = {}, keepOpen = false } = await chrome.storage.local.get(['shelf', 'pins', 'keepOpen']));
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
