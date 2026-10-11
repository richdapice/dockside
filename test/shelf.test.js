import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainOf, shelvable, addToShelf, removeFromShelf, removeDomain, groupByDomain, applyOrder, moveDomain } from '../shelf.js';

const tab = (url, extra = {}) => ({ url, title: url, ...extra });

test('domainOf strips www', () => {
  assert.equal(domainOf('https://www.github.com/a'), 'github.com');
  assert.equal(domainOf('https://docs.github.com/a'), 'docs.github.com');
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

test('applyOrder keeps arranged domains in place and puts new ones in front', () => {
  const groups = ['new.com', 'b.com', 'a.com', 'c.com'].map((domain) => ({ domain }));
  assert.deepEqual(applyOrder(groups, ['a.com', 'gone.com', 'b.com', 'c.com']).map((g) => g.domain),
    ['new.com', 'a.com', 'b.com', 'c.com']);
});

test('moveDomain inserts before or after the target', () => {
  const shown = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveDomain(shown, 'a', 'c', false), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveDomain(shown, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveDomain(shown, 'd', 'a', false), ['d', 'a', 'b', 'c']);
});
