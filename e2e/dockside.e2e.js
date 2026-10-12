// End-to-end tests: load the unpacked extension into Playwright's Chromium and drive real tabs, groups and the
// launcher page. The side panel itself can't be opened by automation, so the launcher is tested as a tab
// (panel.html behaves like the side panel; panel.html?home is the home tab).
// The keyboard shortcuts need real key presses, so they're checked by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const EXT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries an assertion until it passes, for state that settles asynchronously (docking waits half a second).
async function eventually(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await sleep(100);
    }
  }
}

const ICON = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="red"/></svg>');
let server;
let site;
// The same server under a second hostname, for a second "site".
let other;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    // /icon/ pages have a favicon; the rest get Chrome's generic globe.
    const icon = req.url.startsWith('/icon/') ? `<link rel="icon" href="data:image/svg+xml,${ICON}">` : '';
    res.end(`<title>Page ${req.url}</title>${icon}<div style="height:5000px">${req.url}</div>`);
  });
  await new Promise((r) => server.listen(0, r));
  site = `http://localhost:${server.address().port}`;
  other = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function launch(t, { profile, args = [] } = {}) {
  profile ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dockside-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [...args, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  t.after(() => ctx.close());
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  // Setup is done once the home tab exists; tab events before that would race it.
  await eventually(async () => assert.ok(await sw.evaluate(async () =>
    (await chrome.tabs.query({})).some((t) => (t.url || t.pendingUrl).endsWith('panel.html?home')))));
  const id = new URL(sw.url()).host;

  const b = {
    ctx, sw, profile,
    async visit(url) {
      const page = await ctx.newPage();
      await page.goto(url);
      await page.bringToFront();
      return page;
    },
    async panel(query = '', width = 340) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width, height: 500 });
      await page.goto(`chrome-extension://${id}/panel.html${query}`);
      await page.waitForSelector('#actions');
      await sleep(300);
      return page;
    },
    homePage: () => ctx.pages().find((p) => p.url().endsWith('panel.html?home')),
    // The dock as "path" (or "path*" while its live tab is linked), newest first.
    async dock() {
      const shelf = await sw.evaluate(async () => (await chrome.storage.local.get('shelf')).shelf ?? []);
      return shelf.map((i) => short(i.url) + (i.tabId == null ? '' : '*'));
    },
    async groups() {
      return sw.evaluate(async () => Promise.all((await chrome.tabGroups.query({})).map(async (g) => ({
        title: g.title, color: g.color, collapsed: g.collapsed,
        urls: (await chrome.tabs.query({ groupId: g.id })).map((t) => t.url),
      })))).then((gs) => gs.map((g) => ({ ...g, urls: g.urls.map(short).sort() })));
    },
    async stashGroups() {
      return (await b.groups()).filter((g) => g.color === 'grey' && /^⚓ \d+$/.test(g.title));
    },
    tabUrls: async () => (await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url))).map(short),
    tab: (url) => sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url), url),
    seed(urls) {
      const now = Date.now();
      const shelf = urls.map((url, i) => ({ url, title: url, domain: new URL(url).hostname, shelvedAt: now - i, tabId: null }));
      return sw.evaluate((shelf) => chrome.storage.local.set({ shelf }), shelf);
    },
  };
  return b;
}

function short(url) {
  if (url.startsWith(site)) return url.slice(site.length);
  if (url.startsWith(other)) return `127${url.slice(other.length)}`;
  return url.replace(/^https?:\/\//, '');
}

const focused = (page) => page.evaluate(() => document.activeElement.dataset.key || document.activeElement.id);
const tiles = (page) => page.$$eval('.tile-wrap', (ws) => ws.map((w) => w.dataset.domain + (w.querySelector('.tile-pin') ? '📌' : '')));

test('leaving a tab docks it into one collapsed ⚓ group, and it comes back without reloading', async (t) => {
  const b = await launch(t);
  const one = await b.visit(`${site}/one`);
  await one.evaluate(() => { window.mark = 'live'; scrollTo(0, 1234); });
  await b.visit(`${site}/two`);
  await b.visit(`${other}/other`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/two*', '/one*']));
  assert.deepEqual(await b.groups(), [{ title: '⚓ 2', color: 'grey', collapsed: true, urls: ['/one', '/two'] }]);

  // Opening the launcher tab docks /other too.
  const panel = await b.panel();
  await eventually(async () => assert.equal((await b.dock()).length, 3));
  await panel.click('[data-domain="localhost"] .tile');
  await panel.click(`.row[title="${site}/one"]`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['127/other*', '/two*']));
  assert.equal(await one.evaluate(() => window.mark), 'live', 'the page was reloaded');
  assert.equal(await one.evaluate(() => scrollY), 1234);
  assert.equal((await b.tab(`${site}/one`)).groupId, -1);

  // Clicking a tab inside the expanded group takes it out of the dock (and /one, left behind, docks again);
  // closing one there drops it.
  await b.sw.evaluate(async (url) => chrome.tabs.update((await chrome.tabs.query({ url })).at(0).id, { active: true }), `${other}/other`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/one*', '/two*']));
  await b.sw.evaluate(async (url) => chrome.tabs.remove((await chrome.tabs.query({ url })).at(0).id), `${site}/two`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/one*']));
  await eventually(async () => assert.equal((await b.stashGroups())[0].title, '⚓ 1'));
});

test('docking the same page twice keeps only the newer tab', async (t) => {
  const b = await launch(t);
  await b.visit(`${site}/dup`);
  await b.visit(`${site}/dup`);
  await b.visit(`${site}/x`);
  await eventually(async () => {
    assert.deepEqual(await b.dock(), ['/dup*']);
    assert.equal((await b.tabUrls()).filter((u) => u === '/dup').length, 1);
  });
});

test("tabs in the user's own groups never dock, and leaving the ⚓ group undocks", async (t) => {
  const b = await launch(t);
  for (const p of ['/a', '/b', '/c']) await b.visit(site + p);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/b*', '/a*']));

  await b.sw.evaluate(async (url) => chrome.tabs.ungroup((await chrome.tabs.query({ url })).at(0).id), `${site}/a`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/b*']));
  await b.sw.evaluate(async (url) => {
    const g = await chrome.tabs.group({ tabIds: [(await chrome.tabs.query({ url })).at(0).id] });
    await chrome.tabGroups.update(g, { title: 'Work', color: 'blue' });
  }, `${site}/b`);
  await eventually(async () => assert.deepEqual(await b.dock(), []));

  // Switching to /b in Work docks /c; leaving /b must not dock it.
  await b.sw.evaluate(async (url) => chrome.tabs.update((await chrome.tabs.query({ url })).at(0).id, { active: true }), `${site}/b`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/c*']));
  await b.visit(`${site}/d`);
  await sleep(1200);
  assert.deepEqual(await b.dock(), ['/c*']);
  assert.deepEqual((await b.groups()).find((g) => g.title === 'Work').urls, ['/b']);
});

test('the group chip counts its tabs, and old or look-alike groups are handled', async (t) => {
  const b = await launch(t);
  for (const p of ['/a', '/b', '/c', '/d']) await b.visit(site + p);
  await eventually(async () => assert.deepEqual(await b.stashGroups(), [{ title: '⚓ 3', color: 'grey', collapsed: true, urls: ['/a', '/b', '/c'] }]));

  // A group from an older version ("Docked") whose id was lost, as after an extension reload: adopted and retitled.
  await b.sw.evaluate(async () => {
    await chrome.storage.session.remove('stashGroups');
    const [g] = await chrome.tabGroups.query({});
    await chrome.tabGroups.update(g.id, { title: 'Docked' });
  });
  await eventually(async () => assert.equal((await b.stashGroups())[0]?.title, '⚓ 3'));

  // A user's group that only looks like ours is left alone, and new tabs still dock into ours.
  await b.sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    const g = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(g, { title: '⚓ 9', color: 'red' });
  }, `${site}/mine`);
  await sleep(1500);
  await b.visit(`${site}/e`);
  await eventually(async () => assert.equal((await b.stashGroups())[0].title, '⚓ 4'));
  const mine = { title: '⚓ 9', color: 'red', collapsed: false, urls: ['/mine'] };
  assert.deepEqual((await b.groups()).find((g) => g.color === 'red'), mine);

  // Removing everything (the launcher's Clear dock) closes our group only.
  const panel = await b.panel();
  await panel.click('#clear-dock');
  await panel.click('#confirm-ok');
  await eventually(async () => assert.deepEqual(await b.dock(), []));
  await eventually(async () => assert.deepEqual(await b.groups(), [mine]));
});

test('pages navigating inside the group never cause a second group', async (t) => {
  const b = await launch(t);
  for (let i = 0; i < 8; i++) await b.visit(`${site}/a${i}`);
  await eventually(async () => assert.equal((await b.dock()).length, 7));
  assert.equal((await b.stashGroups()).length, 1);

  // Every docked page navigates, then the group ids are lost (extension reload). A color change stands in for the
  // group events Chrome sends on restore, which trigger the relink.
  await b.sw.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) if (tab.groupId > 0) await chrome.tabs.update(tab.id, { url: `${tab.url}?moved` });
  });
  await eventually(async () => assert.ok((await b.dock()).every((i) => i.includes('?moved'))));
  await b.sw.evaluate(async () => {
    await chrome.storage.session.remove('stashGroups');
    const [g] = await chrome.tabGroups.query({});
    await chrome.tabGroups.update(g.id, { color: 'blue' });
    await chrome.tabGroups.update(g.id, { color: 'grey' });
  });
  await sleep(1800);
  await b.visit(`${site}/c1`);
  await b.visit(`${site}/c2`);
  await eventually(async () => assert.equal((await b.dock()).length, 9));
  const groups = await b.stashGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].urls.length, 9);
  assert.ok((await b.dock()).every((i) => i.endsWith('*')), 'every item is still linked to its tab');
});

test('docked tabs are relinked after a browser restart', async (t) => {
  const first = await launch(t);
  for (const p of ['/a', '/b', '/c']) await first.visit(site + p);
  await eventually(async () => assert.deepEqual(await first.dock(), ['/b*', '/a*']));
  await first.ctx.close();

  const b = await launch(t, { profile: first.profile, args: ['--restore-last-session'] });
  await eventually(async () => {
    assert.deepEqual(await b.stashGroups(), [{ title: '⚓ 2', color: 'grey', collapsed: true, urls: ['/a', '/b'] }]);
    assert.deepEqual(await b.dock(), ['/b*', '/a*']);
  }, 8000);
  // Linked to the restored tabs, not stale ids: opening one brings that tab out instead of loading a new one.
  // (Playwright starts on a blank tab, so /c isn't active and doesn't dock.)
  const panel = await b.panel();
  await panel.click('[data-domain="localhost"] .tile');
  await panel.click(`.row[title="${site}/a"]`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['/b*']));
  assert.equal((await b.tabUrls()).filter((u) => u === '/a').length, 1);
});

test('Unload tabs closes every docked tab, keeps it in the dock, and the dock survives a restart', async (t) => {
  const b = await launch(t);
  for (const p of ['/a', '/b', '/c', '/d']) await b.visit(site + p);
  await eventually(async () => assert.equal((await b.dock()).length, 3));
  // b loses its link and the group ids are lost; a stray grey ⚓ group holds a page the dock doesn't know. The
  // user's own groups, including a red one titled "Docked", must be left alone.
  await b.sw.evaluate(async ({ site }) => {
    const { shelf } = await chrome.storage.local.get('shelf');
    await chrome.storage.local.set({ shelf: shelf.map((i) => (i.url.endsWith('/b') ? { ...i, tabId: null } : i)) });
    await chrome.storage.session.remove('stashGroups');
    const groupOf = async (url, props) => {
      const tab = await chrome.tabs.create({ url, active: false });
      await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: [tab.id] }), props);
    };
    await groupOf(`${site}/stray`, { title: '⚓ 1', color: 'grey', collapsed: true });
    await groupOf(`${site}/work`, { title: 'Work', color: 'blue' });
    await groupOf(`${site}/myred`, { title: 'Docked', color: 'red' });
  }, { site });

  const panel = await b.panel();
  await eventually(async () => assert.equal((await b.dock()).length, 4));
  assert.ok(await panel.isVisible('#cache-tabs'));
  await panel.click('#cache-tabs');
  await eventually(async () => {
    assert.deepEqual((await b.dock()).sort(), ['/a', '/b', '/c', '/d', '/stray']);
    assert.deepEqual((await b.groups()).map((g) => g.title).sort(), ['Docked', 'Work']);
  });
  const open = await b.tabUrls();
  for (const p of ['/a', '/b', '/c', '/d', '/stray']) assert.ok(!open.includes(p), `${p} is still open`);
  assert.ok(open.includes('/work') && open.includes('/myred'));
  assert.ok(await panel.isVisible('#cache-tabs'));

  // Opening an unloaded item loads it fresh.
  await panel.click('[data-domain="localhost"] .tile');
  await panel.click(`.row[title="${site}/a"]`);
  await eventually(async () => assert.ok((await b.tabUrls()).includes('/a')));
  assert.ok(!(await b.dock()).includes('/a'));

  await b.ctx.close();
  const again = await launch(t, { profile: b.profile });
  assert.deepEqual((await again.dock()).sort(), ['/b', '/c', '/d', '/stray']);
});

test('Unload tabs pulls in open tabs too, even with an empty dock, but not ones that never dock', async (t) => {
  const b = await launch(t);
  await b.sw.evaluate(async ({ site }) => {
    for (const p of ['/x', '/y']) await chrome.tabs.create({ url: site + p, active: false });
    await chrome.tabs.create({ url: `${site}/pinned`, active: false, pinned: true });
    const mine = await chrome.tabs.create({ url: `${site}/mine`, active: false });
    await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: [mine.id] }), { title: 'Mine', color: 'blue' });
  }, { site });
  const panel = await b.panel();
  await b.seed([`${site}/old`]);
  await panel.click('#cache-tabs');
  await eventually(async () => assert.deepEqual(await b.dock(), ['/x', '/y', '/old']));
  const open = await b.tabUrls();
  assert.ok(!open.includes('/x') && !open.includes('/y'));
  assert.ok(open.includes('/pinned') && open.includes('/mine'), 'pinned tabs and your own groups stay');
  assert.ok(!panel.isClosed(), 'the tab you are on stays');
});

test('one ⚓ group per window, even when docking races a restart', async (t) => {
  const b = await launch(t);
  for (const p of ['/a', '/b', '/c']) await b.visit(site + p);
  await eventually(async () => assert.deepEqual((await b.stashGroups()).map((g) => g.title), ['⚓ 2']));

  // After a restart the group is back before Dockside has relinked it. A tab docked then joins it.
  await b.sw.evaluate(() => chrome.storage.session.remove('stashGroups'));
  await b.visit(`${site}/d`);
  await eventually(async () => assert.deepEqual(await b.stashGroups(), [{ title: '⚓ 3', color: 'grey', collapsed: true, urls: ['/a', '/b', '/c'] }]));

  // Or Chrome brings the old group back only after a new one was started: relinking folds them together.
  await b.sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    // Unlinked, like every item straight after a restart; relinking claims the tab by URL.
    const { shelf } = await chrome.storage.local.get('shelf');
    await chrome.storage.local.set({ shelf: [...shelf, { url, title: url, domain: 'localhost', shelvedAt: 0, tabId: null }] });
    await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: [tab.id] }), { title: '⚓ 1', color: 'grey' });
  }, `${site}/x`);
  await eventually(async () => assert.deepEqual(await b.stashGroups(), [{ title: '⚓ 4', color: 'grey', collapsed: true, urls: ['/a', '/b', '/c', '/x'] }]));
});

test('the home tab counts docked tabs and how many are still loaded', async (t) => {
  const b = await launch(t);
  const home = b.homePage();
  const count = () => home.textContent('#count');
  for (const p of ['/a', '/b', '/c']) await b.visit(site + p);
  await eventually(async () => assert.equal(await count(), '2 tabs docked · 2 loaded'));

  const panel = await b.panel();
  await eventually(async () => assert.equal(await count(), '3 tabs docked · 3 loaded'));
  await panel.click('#cache-tabs');
  await eventually(async () => assert.equal(await count(), '3 tabs docked · 0 loaded'));

  // A window closing leaves its docked tabs in the dock but closes them, without the dock changing.
  const win = await b.sw.evaluate((url) => chrome.windows.create({ url }), `${site}/w1`);
  await b.sw.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: win.id, url: `${site}/w2` });
  await eventually(async () => assert.equal(await count(), '4 tabs docked · 1 loaded'));
  await b.sw.evaluate((id) => chrome.windows.remove(id), win.id);
  await eventually(async () => assert.equal(await count(), '4 tabs docked · 0 loaded'));
  assert.equal((await b.dock()).length, 4);

  // Reloading counts afresh.
  await home.reload();
  await eventually(async () => assert.equal(await count(), '4 tabs docked · 0 loaded'));
});

test('Clear dock asks first, and the prompt follows the dock', async (t) => {
  const b = await launch(t);
  const urls = ['https://a.test/', 'https://b.test/', 'https://c.test/'];
  for (const [query, width] of [['', 340], ['?home', 1280]]) {
    await b.seed(urls);
    const p = await b.panel(query, width);
    await p.click('#clear-dock');
    assert.ok(await p.isVisible('#confirm-clear'));
    assert.equal(await p.textContent('#confirm-text'), 'Remove all 3 tabs from the dock and close them?');
    assert.equal(await focused(p), 'confirm-cancel');
    assert.ok(!(await p.isVisible('#clear-dock')) && !(await p.isVisible('#cache-tabs')));

    await p.keyboard.press('Escape');
    assert.ok(!(await p.isVisible('#confirm-clear')));
    assert.equal(await focused(p), 'clear-dock');
    await p.click('#clear-dock');
    await p.click('#confirm-cancel');
    assert.ok(!(await p.isVisible('#confirm-clear')));
    assert.equal((await b.dock()).length, 3);

    // The dock changing elsewhere while asking updates the count, and emptying it drops the prompt.
    await p.click('#clear-dock');
    await b.seed(urls.slice(1));
    await eventually(async () => assert.equal(await p.textContent('#confirm-text'), 'Remove all 2 tabs from the dock and close them?'));
    await b.seed([]);
    await eventually(async () => assert.ok(await p.isVisible('#empty')));
    assert.ok(!(await p.isVisible('#confirm-clear')) && !(await p.isVisible('#clear-dock')));
    assert.ok(await p.isVisible('#cache-tabs'), 'Unload tabs can still pull in open tabs');

    await b.seed(urls);
    await p.click('#clear-dock');
    await p.click('#confirm-ok');
    await eventually(async () => assert.deepEqual(await b.dock(), []));
    assert.ok(await p.isVisible('#empty'));
    assert.ok(!(await p.isVisible('#confirm-clear')));
    await p.close();
  }
});

test('dragging a tile pins it where it lands; the rest stay newest first', async (t) => {
  const b = await launch(t);
  await b.seed(['a', 'b', 'c', 'd', 'e', 'f'].map((d) => `https://${d}/`));
  const p = await b.panel();
  const pins = () => b.sw.evaluate(async () => (await chrome.storage.local.get('pins')).pins ?? {});
  assert.deepEqual(await tiles(p), ['a', 'b', 'c', 'd', 'e', 'f']);

  await p.dragAndDrop('[data-domain="f"]', '[data-domain="a"]', { targetPosition: { x: 5, y: 30 } });
  await eventually(async () => assert.deepEqual(await tiles(p), ['f📌', 'a', 'b', 'c', 'd', 'e']));
  await p.dragAndDrop('[data-domain="e"]', '[data-domain="c"]', { targetPosition: { x: 70, y: 30 } });
  await eventually(async () => assert.deepEqual(await tiles(p), ['f📌', 'a', 'b', 'c', 'e📌', 'd']));
  assert.deepEqual(await pins(), { f: 0, e: 4 });

  // A newly docked site goes first among the unpinned tiles.
  await b.sw.evaluate(async () => {
    const { shelf } = await chrome.storage.local.get('shelf');
    await chrome.storage.local.set({ shelf: [{ url: 'https://g/', title: 'g', domain: 'g', shelvedAt: Date.now() + 1000, tabId: null }, ...shelf] });
  });
  await eventually(async () => assert.deepEqual(await tiles(p), ['f📌', 'g', 'a', 'b', 'e📌', 'c', 'd']));

  await p.click('[data-domain="f"] .tile-pin');
  await eventually(async () => assert.deepEqual(await tiles(p), ['g', 'a', 'b', 'c', 'e📌', 'd', 'f']));
  await p.focus('[data-domain="b"] .tile');
  await p.keyboard.press('p');
  await eventually(async () => assert.deepEqual(await pins(), { e: 4, b: 2 }));
  assert.deepEqual(await tiles(p), ['g', 'a', 'b📌', 'c', 'e📌', 'd', 'f']);
  assert.equal(await focused(p), 'b');
  await p.keyboard.press('p');
  await eventually(async () => assert.deepEqual(await pins(), { e: 4 }));
});

test('tiles: tidy site names, a letter for sites with no icon, and the page title on hover or focus', async (t) => {
  const b = await launch(t);
  await b.visit(`${other}/icon/page`);
  await b.visit(`${site}/plain`);
  await eventually(async () => assert.deepEqual(await b.dock(), ['127/icon/page*']));
  await b.sw.evaluate(async () => {
    const { shelf } = await chrome.storage.local.get('shelf');
    const item = (url, title) => ({ url, title, domain: new URL(url).hostname, shelvedAt: 0, tabId: null });
    await chrome.storage.local.set({ shelf: [...shelf, item('https://m.youtube.com/watch', 'Cat video'),
      item('https://app.slack.com/client/1', 'general'), item('https://app.slack.com/client/2', 'random')] });
  });
  const p = await b.panel();
  // Opening the launcher tab docks /plain.
  await eventually(async () => assert.deepEqual(
    (await p.$$eval('.tile .label', (ls) => ls.map((l) => l.textContent))).sort(),
    ['127.0.0.1', 'localhost', 'slack.com', 'youtube.com']));

  const tileSel = (d) => `[data-domain="${d}"] .tile`;
  await eventually(async () => assert.equal(await p.textContent(`${tileSel('m.youtube.com')} .letter`), 'Y'));
  assert.ok(await p.isVisible(`${tileSel('127.0.0.1')} .icon img`), 'a real favicon is shown');
  assert.equal(await p.$(`${tileSel('127.0.0.1')} .letter`), null);
  assert.equal(await p.textContent(`${tileSel('app.slack.com')} .letter`), 'S');

  const title = (d) => `${tileSel(d)} .card`;
  assert.ok(!(await p.isVisible(title('m.youtube.com'))));
  await p.hover(tileSel('m.youtube.com'));
  assert.ok(await p.isVisible(title('m.youtube.com')));
  assert.equal(await p.textContent(title('m.youtube.com')), 'Cat video');
  await p.mouse.move(0, 0);
  assert.ok(!(await p.isVisible(title('m.youtube.com'))));
  await p.hover(tileSel('app.slack.com'));
  assert.ok(!(await p.isVisible(title('app.slack.com'))), 'a folder has no page title to show');
  await p.mouse.move(0, 0);

  await p.focus(tileSel('127.0.0.1'));
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowRight');
  assert.equal(await focused(p), '127.0.0.1');
  assert.ok(await p.isVisible(title('127.0.0.1')), 'shown when selected with the keyboard');
  assert.equal(await p.textContent(title('127.0.0.1')), 'Page /icon/page');
  await p.hover(tileSel('m.youtube.com'));
  assert.ok(await p.isVisible(title('m.youtube.com')));
  assert.ok(!(await p.isVisible(title('127.0.0.1'))), 'one title at a time: the hovered one');

  await p.click(tileSel('app.slack.com'));
  assert.equal(await p.textContent('#heading'), 'slack.com');
});

test('labels can be turned off, leaving icons named by their card', async (t) => {
  const b = await launch(t);
  await b.seed(['https://a.test/', 'https://b.test/1', 'https://b.test/2']);
  const p = await b.panel();
  const label = '[data-domain="a.test"] .label';
  const card = (d) => `[data-domain="${d}"] .card`;
  assert.equal(await p.getAttribute('#show-labels', 'aria-pressed'), 'true');
  assert.ok(await p.isVisible(label));
  const height = async () => (await p.$eval('[data-domain="a.test"] .tile', (n) => n.getBoundingClientRect().height));
  const withLabels = await height();

  await p.click('#show-labels');
  await eventually(async () => assert.equal(await p.getAttribute('#show-labels', 'aria-pressed'), 'false'));
  assert.ok(!(await p.isVisible(label)));
  assert.ok((await height()) < withLabels, 'tiles shrink to their icons');
  await p.hover('[data-domain="a.test"] .tile');
  assert.equal(await p.textContent(card('a.test')), 'https://a.test/');
  assert.ok(await p.isVisible(card('a.test')));
  await p.hover('[data-domain="b.test"] .tile');
  assert.ok(await p.isVisible(card('b.test')), 'a folder names its site');
  assert.equal(await p.textContent(card('b.test')), 'b.test');
  assert.ok(!(await p.isVisible(card('a.test'))));

  // The setting is shared with the home tab, which has the toggle too.
  const home = await b.panel('?home', 1280);
  assert.ok(!(await home.isVisible(label)));
  assert.ok(await home.isVisible('#show-labels'));
  await home.click('#show-labels');
  await eventually(async () => assert.ok(await p.isVisible(label)));

  // It steps aside while Clear dock asks.
  await p.click('#clear-dock');
  assert.ok(!(await p.isVisible('#show-labels')));
});

test('the corner buttons sit inside the footer, even with an empty dock', async (t) => {
  const b = await launch(t);
  const p = await b.panel();
  for (const urls of [[], ['https://a.test/']]) {
    await b.seed(urls);
    await eventually(async () => assert.equal(await p.isVisible('#empty'), urls.length === 0));
    const footer = await p.locator('#actions').boundingBox();
    for (const id of ['#show-labels', '#keep-open']) {
      const box = await p.locator(id).boundingBox();
      assert.ok(box.y > footer.y && box.y + box.height < footer.y + footer.height, `${id} with ${urls.length} docked`);
    }
  }
});

test('keyboard: arrows reach the footer buttons and come back', async (t) => {
  const b = await launch(t);
  await b.seed(['a', 'b', 'c', 'd', 'e'].map((d) => `https://${d}.test/`));
  const p = await b.panel();
  const press = async (key, expect) => { await p.keyboard.press(key); assert.equal(await focused(p), expect, `after ${key}`); };
  assert.equal(await focused(p), 'a.test', 'the first tile is selected on open');

  await p.focus('[data-domain="e.test"] .tile');
  await press('ArrowDown', 'cache-tabs');
  await press('ArrowRight', 'clear-dock');
  await press('ArrowRight', 'show-labels');
  await press('ArrowRight', 'keep-open');
  await press('ArrowRight', 'keep-open');
  await press('ArrowLeft', 'show-labels');
  await press('ArrowLeft', 'clear-dock');
  await press('ArrowUp', 'e.test');
  await press('ArrowDown', 'cache-tabs');
  await press('ArrowRight', 'clear-dock');
  await press('Enter', 'confirm-cancel');
  await press('ArrowRight', 'confirm-ok');
  await press('ArrowLeft', 'confirm-cancel');
  await press('Escape', 'clear-dock');
  assert.equal((await b.dock()).length, 5);
});

test('keyboard: a folder has Back and Close all above its rows', async (t) => {
  const b = await launch(t);
  await b.seed(['https://f.test/1', 'https://f.test/2', 'https://f.test/3', 'https://a.test/']);
  const p = await b.panel();
  const inFolder = () => p.isVisible('#folder');
  const press = async (key, expect) => { await p.keyboard.press(key); assert.equal(await focused(p), expect, `after ${key}`); };

  await press('Enter', 'https://f.test/1');
  assert.ok(await inFolder());
  await press('ArrowUp', 'back');
  await press('ArrowRight', 'close-all');
  await press('ArrowRight', 'close-all');
  await press('ArrowLeft', 'back');
  await press('ArrowDown', 'https://f.test/1');
  await press('ArrowDown', 'https://f.test/2');
  await press('Escape', 'f.test');
  assert.ok(!(await inFolder()));
  await press('Enter', 'https://f.test/1');
  await press('ArrowLeft', 'f.test');
  await press('Enter', 'https://f.test/1');
  await press('ArrowUp', 'back');
  await press('Enter', 'f.test');
  assert.ok(!(await inFolder()));

  // Close all drops the site.
  await p.keyboard.press('Enter');
  await p.click('#close-all');
  await eventually(async () => assert.deepEqual(await b.dock(), ['a.test/']));
  assert.deepEqual(await tiles(p), ['a.test']);
});

test('keyboard: Delete and Backspace remove the selected item', async (t) => {
  const b = await launch(t);
  await b.seed(['https://f.test/1', 'https://f.test/2', 'https://f.test/3', 'https://a.test/', 'https://b.test/']);
  const p = await b.panel();
  const press = async (key, expect, dock) => {
    await p.keyboard.press(key);
    await eventually(async () => assert.deepEqual(await b.dock(), dock));
    await eventually(async () => assert.equal(await focused(p), expect, `after ${key}`));
  };
  const all = ['f.test/1', 'f.test/2', 'f.test/3', 'a.test/', 'b.test/'];
  await press('Enter', 'https://f.test/1', all);
  await press('Backspace', 'https://f.test/2', all.slice(1));
  await press('Escape', 'f.test', all.slice(1));
  await press('ArrowRight', 'a.test', all.slice(1));
  await press('Backspace', 'b.test', ['f.test/2', 'f.test/3', 'b.test/']);
  await press('Delete', 'f.test', ['f.test/2', 'f.test/3']);
});

test('the panel closes after opening a tab unless locked open; the home tab stays', async (t) => {
  const b = await launch(t);
  await b.seed(['http://a.test/', 'http://b.test/1', 'http://b.test/2', 'http://c.test/', 'http://d.test/']);

  let p = await b.panel();
  assert.equal(await p.getAttribute('#keep-open', 'aria-pressed'), 'false');
  await p.click('[data-domain="a.test"] .tile');
  await eventually(() => assert.ok(p.isClosed()));

  p = await b.panel();
  await p.click('[data-domain="b.test"] .tile');
  assert.ok(!p.isClosed(), 'opening a folder keeps the panel');
  await p.keyboard.press('Enter');
  await eventually(() => assert.ok(p.isClosed()));

  p = await b.panel();
  await p.click('#keep-open');
  await eventually(async () => assert.equal(await p.getAttribute('#keep-open', 'aria-pressed'), 'true'));
  await p.click('[data-domain="c.test"] .tile');
  await eventually(async () => assert.ok(!(await b.dock()).includes('c.test/')));
  await sleep(300);
  assert.ok(!p.isClosed(), 'locked open');
  await p.reload();
  await p.waitForSelector('#actions');
  await eventually(async () => assert.equal(await p.getAttribute('#keep-open', 'aria-pressed'), 'true'));
  await p.click('#keep-open');

  const home = b.homePage();
  await home.reload();
  await home.waitForSelector('#actions');
  assert.ok(!(await home.isVisible('#keep-open')), 'no lock in the home tab');
  await home.click('[data-domain="d.test"] .tile');
  await eventually(async () => assert.ok(!(await b.dock()).includes('d.test/')));
  await sleep(300);
  assert.ok(!home.isClosed());
});

test('every window keeps a pinned home tab', async (t) => {
  const b = await launch(t);
  const homes = () => b.sw.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((w) =>
    w.tabs.filter((t) => t.pinned && (t.url || t.pendingUrl).endsWith('panel.html?home')).length));
  assert.deepEqual(await homes(), [1]);

  for (const page of b.ctx.pages()) if (page.url() === 'about:blank') await page.close();
  const last = await b.visit(`${site}/one`);
  await last.close();
  await sleep(500);
  assert.deepEqual(await homes(), [1], 'closing the last regular tab leaves the window open');

  await b.visit(`${site}/two`);
  await b.sw.evaluate(async () => chrome.tabs.remove((await chrome.tabs.query({ pinned: true }))[0].id));
  await eventually(async () => assert.deepEqual(await homes(), [1]), 3000);

  await b.sw.evaluate((url) => chrome.windows.create({ url }), `${site}/newwin`);
  await eventually(async () => assert.deepEqual(await homes(), [1, 1]));

  // A second home turning up (a closed one reopened with ⌘⇧T, or one dragged in from another window) is closed,
  // and the pinned one stays.
  const all = () => b.sw.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((w) =>
    w.tabs.filter((t) => (t.url || t.pendingUrl).endsWith('panel.html?home')).length));
  const [first, second] = await b.sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.id));
  await b.sw.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: first, url: b.homePage().url() });
  await eventually(async () => assert.deepEqual(await all(), [1, 1]));
  assert.deepEqual(await homes(), [1, 1]);
  await b.sw.evaluate(async ({ from, to }) => {
    const [home] = await chrome.tabs.query({ windowId: from, pinned: true });
    await chrome.tabs.move(home.id, { windowId: to, index: -1 });
  }, { from: second, to: first });
  await eventually(async () => assert.deepEqual(await all(), [1, 1]));
  assert.deepEqual(await homes(), [1, 1]);
});

test('both keyboard shortcuts are registered', async (t) => {
  const b = await launch(t);
  const commands = await b.sw.evaluate(async () => (await chrome.commands.getAll()).map((c) => c.name));
  assert.ok(commands.includes('toggle-panel') && commands.includes('last-tab'));
});
