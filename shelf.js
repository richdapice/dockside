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

// Domains the user has arranged keep their saved position; any other domain goes in front, newest first,
// so a tab you just left is easy to find.
export function applyOrder(groups, order) {
  const rank = new Map(order.map((d, i) => [d, i]));
  const placed = groups.filter((g) => rank.has(g.domain)).sort((a, b) => rank.get(a.domain) - rank.get(b.domain));
  return [...groups.filter((g) => !rank.has(g.domain)), ...placed];
}

// Builds the new saved order from what's on screen, which also drops domains that left the shelf.
export function moveDomain(domains, dragged, target, after) {
  const rest = domains.filter((d) => d !== dragged);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}
