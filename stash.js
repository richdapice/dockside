// Docked tabs wait in one collapsed group per window instead of closing, so they come back without reloading.
// The group's chip reads "⚓ 7": an anchor and how many tabs are docked in it.
export const stashTitle = (count) => `⚓ ${count}`;
// Older versions titled the group "Shelved" (before the rename from Tabshelf) and then "Docked"; those are still
// recognized so their groups are adopted and retitled rather than stranded.
export function isStashTitle(title) {
  return /^⚓ \d+$/.test(title) || title === 'Docked' || title === 'Shelved';
}

// For .catch(): Chrome's "No tab/window/group with id" errors mean the thing is already gone, which callers treat
// as nothing to do. Anything else is a real failure and is rethrown.
export function ifGone(e) {
  if (/^No (tab|window|group) with id/.test(e.message)) return null;
  throw e;
}

// Ids of the groups Dockside made, rather than trusting the title, so a user's own group with a similar title stays
// theirs.
// Session storage is cleared on browser restart and extension reload; the background re-adopts groups then.
export async function stashGroupIds() {
  const { stashGroups = [] } = await chrome.storage.session.get('stashGroups');
  return stashGroups;
}

export async function adoptStashGroup(groupId) {
  const ids = await stashGroupIds();
  if (!ids.includes(groupId)) await chrome.storage.session.set({ stashGroups: [...ids, groupId] });
}

export async function stashGroupIn(windowId) {
  const ids = await stashGroupIds();
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((g) => ids.includes(g.id)) ?? null;
}

export async function retitleStash(windowId) {
  const group = await stashGroupIn(windowId);
  if (!group) return;
  const title = stashTitle((await chrome.tabs.query({ groupId: group.id })).length);
  // The group disappears when its last tab leaves, possibly between the query and this update.
  if (group.title !== title) await chrome.tabGroups.update(group.id, { title }).catch(ifGone);
}

export async function inStash(tab) {
  return tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && (await stashGroupIds()).includes(tab.groupId);
}

export async function stashTab(tab) {
  const group = await stashGroupIn(tab.windowId);
  if (group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
    await chrome.tabGroups.update(group.id, { collapsed: true });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await adoptStashGroup(groupId);
  await chrome.tabGroups.update(groupId, { title: stashTitle(1), color: 'grey', collapsed: true });
  await chrome.tabGroups.move(groupId, { index: -1 });
}

// The item's live tab, but only while it's still in a stash group; a tab the user dragged out is theirs now.
export async function stashedTab(item) {
  if (item.tabId == null) return null;
  const tab = await chrome.tabs.get(item.tabId).catch(ifGone);
  return tab && (await inStash(tab)) ? tab : null;
}

export async function closeStashed(items) {
  const tabs = await Promise.all(items.map(stashedTab));
  const ids = tabs.filter(Boolean).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
}
