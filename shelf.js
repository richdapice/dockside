// Pure shelf logic, shared by the service worker and the side panel. No chrome.* here so it runs under node:test.

export function domainOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

// Pinned, audible, and already-grouped tabs (the user's own groups, or already shelved) are left where they are;
// non-web pages can't be meaningfully reopened. Incognito tabs would be written to disk in storage.local.
export function shelvable(tab) {
  return !tab.incognito && !tab.pinned && !tab.audible && (tab.groupId ?? -1) === -1 && /^https?:\/\//.test(tab.url ?? '');
}

// Newest first. Shelving a URL that's already there moves it to the front instead of duplicating it.
export function addToShelf(shelf, tab, now) {
  const item = { url: tab.url, title: tab.title || tab.url, domain: domainOf(tab.url), shelvedAt: now, tabId: tab.id };
  return [item, ...shelf.filter((i) => i.url !== tab.url)];
}

export function removeFromShelf(shelf, url) {
  return shelf.filter((i) => i.url !== url);
}

export function removeDomain(shelf, domain) {
  return shelf.filter((i) => i.domain !== domain);
}

// One entry per domain, ordered by its most recently shelved item. A single item is an app; more is a folder.
export function groupByDomain(shelf) {
  const groups = new Map();
  for (const item of shelf) {
    if (!groups.has(item.domain)) groups.set(item.domain, []);
    groups.get(item.domain).push(item);
  }
  return [...groups].map(([domain, items]) => ({ domain, items, kind: items.length === 1 ? 'app' : 'folder' }));
}

// Pinned domains ({ domain: index }) sit at their index; the rest fill the gaps in the order given (newest first).
// A pin past the end lands at the end. Pins for domains not in the dock take no space, and apply again if the
// domain comes back.
export function arrange(groups, pins) {
  const pinned = groups.filter((g) => g.domain in pins).sort((a, b) => pins[a.domain] - pins[b.domain]);
  const rest = groups.filter((g) => !(g.domain in pins));
  const out = [];
  while (pinned.length || rest.length) {
    const due = pinned.length && (pins[pinned[0].domain] <= out.length || !rest.length);
    out.push(due ? pinned.shift() : rest.shift());
  }
  return out;
}

// Pins a domain at an index. A pin already there moves one along, which can push the next one along, and so on.
export function pinAt(pins, domain, index) {
  const next = { ...pins };
  delete next[domain];
  for (let d = domain, at = index; d; at++) {
    const clash = Object.keys(next).find((k) => k !== d && next[k] === at);
    next[d] = at;
    d = clash;
  }
  return next;
}

export function unpin(pins, domain) {
  const next = { ...pins };
  delete next[domain];
  return next;
}

// The on-screen order after a drag, used to find the index the dragged domain was dropped at.
export function moveDomain(domains, dragged, target, after) {
  const rest = domains.filter((d) => d !== dragged);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}
