import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainOf, siteName, shelvable, addToShelf, removeFromShelf, removeDomain, groupByDomain, arrange, pinAt, unpin, moveDomain } from '../shelf.js';

const tab = (url, extra = {}) => ({ url, title: url, ...extra });

test('domainOf strips www', () => {
  assert.equal(domainOf('https://www.github.com/a'), 'github.com');
  assert.equal(domainOf('https://docs.github.com/a'), 'docs.github.com');
});

test('siteName drops mobile and web-app subdomains, but never down to a bare suffix', () => {
  assert.equal(siteName('m.youtube.com'), 'youtube.com');
  assert.equal(siteName('app.slack.com'), 'slack.com');
  assert.equal(siteName('web.whatsapp.com'), 'whatsapp.com');
  assert.equal(siteName('docs.google.com'), 'docs.google.com');
  assert.equal(siteName('app.com'), 'app.com');
  assert.equal(siteName('localhost'), 'localhost');
});

test('shelvable skips pinned, audible, grouped, incognito, and non-web tabs', () => {
  assert.equal(shelvable(tab('https://a.com')), true);
  assert.equal(shelvable(tab('https://a.com', { incognito: true })), false);
  assert.equal(shelvable(tab('https://a.com', { pinned: true })), false);
  assert.equal(shelvable(tab('https://a.com', { audible: true })), false);
  assert.equal(shelvable(tab('https://a.com', { groupId: 7 })), false);
  assert.equal(shelvable(tab('https://a.com', { groupId: -1 })), true);
  assert.equal(shelvable(tab('chrome://newtab/')), false);
  assert.equal(shelvable({}), false);
});

test('addToShelf puts newest first and dedupes by url', () => {
  let shelf = addToShelf([], tab('https://a.com/1'), 1);
  shelf = addToShelf(shelf, tab('https://b.com/1'), 2);
  shelf = addToShelf(shelf, tab('https://a.com/1'), 3);
  assert.deepEqual(shelf.map((i) => [i.url, i.shelvedAt]), [['https://a.com/1', 3], ['https://b.com/1', 2]]);
});

test('first tab of a domain is an app, second turns it into a folder', () => {
  let shelf = addToShelf([], tab('https://a.com/1'), 1);
  assert.deepEqual(groupByDomain(shelf).map((g) => g.kind), ['app']);
  shelf = addToShelf(shelf, tab('https://www.a.com/2'), 2);
  const [group] = groupByDomain(shelf);
  assert.equal(group.kind, 'folder');
  assert.deepEqual(group.items.map((i) => i.url), ['https://www.a.com/2', 'https://a.com/1']);
});

test('folder falls back to an app when an item is removed', () => {
  let shelf = addToShelf([], tab('https://a.com/1'), 1);
  shelf = addToShelf(shelf, tab('https://a.com/2'), 2);
  shelf = removeFromShelf(shelf, 'https://a.com/2');
  assert.deepEqual(groupByDomain(shelf).map((g) => g.kind), ['app']);
});

test('groups are ordered by most recent item', () => {
  let shelf = addToShelf([], tab('https://a.com/1'), 1);
  shelf = addToShelf(shelf, tab('https://b.com/1'), 2);
  shelf = addToShelf(shelf, tab('https://a.com/2'), 3);
  assert.deepEqual(groupByDomain(shelf).map((g) => g.domain), ['a.com', 'b.com']);
});

test('removeDomain drops every item from that domain only', () => {
  let shelf = addToShelf([], tab('https://a.com/1'), 1);
  shelf = addToShelf(shelf, tab('https://b.com/1'), 2);
  shelf = addToShelf(shelf, tab('https://www.a.com/2'), 3);
  assert.deepEqual(removeDomain(shelf, 'a.com').map((i) => i.url), ['https://b.com/1']);
});

const groupsOf = (...domains) => domains.map((domain) => ({ domain }));
const names = (groups) => groups.map((g) => g.domain).join(' ');

test('arrange puts pinned domains at their index and fills the rest newest first', () => {
  assert.equal(names(arrange(groupsOf('n1', 'n2', 'n3', 'p'), { p: 1 })), 'n1 p n2 n3');
  assert.equal(names(arrange(groupsOf('n1', 'p0', 'n2', 'p2'), { p0: 0, p2: 2 })), 'p0 n1 p2 n2');
});

test('arrange puts a pin past the end at the end, and ignores pins for absent domains', () => {
  assert.equal(names(arrange(groupsOf('n1', 'p'), { p: 5 })), 'n1 p');
  assert.equal(names(arrange(groupsOf('n1', 'n2'), { gone: 0 })), 'n1 n2');
  assert.equal(names(arrange(groupsOf('p1', 'p2'), { p2: 3, p1: 7 })), 'p2 p1');
});

test('pinAt moves clashing pins along', () => {
  assert.deepEqual(pinAt({ a: 0, b: 1, c: 3 }, 'd', 0), { d: 0, a: 1, b: 2, c: 3 });
  assert.deepEqual(pinAt({ a: 0, b: 1 }, 'a', 1), { a: 1, b: 2 });
  assert.deepEqual(unpin({ a: 0, b: 1 }, 'a'), { b: 1 });
});

test('moveDomain inserts before or after the target', () => {
  const shown = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveDomain(shown, 'a', 'c', false), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveDomain(shown, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveDomain(shown, 'd', 'a', false), ['d', 'a', 'b', 'c']);
});
