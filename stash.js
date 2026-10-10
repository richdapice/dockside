// Shelved tabs wait in one collapsed group per window instead of closing, so they come back without reloading.
// The group is recognised by its title, which also lets us find it again after Chrome restores a session.
export const STASH_TITLE = 'Shelved';

export async function inStash(tab) {
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false;
  const group = await chrome.tabGroups.get(tab.groupId);
  return group.title === STASH_TITLE;
}

export async function stashTab(tab) {
  const [group] = await chrome.tabGroups.query({ windowId: tab.windowId, title: STASH_TITLE });
  if (group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
    await chrome.tabGroups.update(group.id, { collapsed: true });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: STASH_TITLE, color: 'grey', collapsed: true });
  await chrome.tabGroups.move(groupId, { index: -1 });
}

// The item's live tab, but only while it's still in a stash group; a tab the user dragged out is theirs now.
export async function stashedTab(item) {
  if (item.tabId == null) return null;
  // tabs.get rejects once the tab is gone, e.g. its window was closed.
  const tab = await chrome.tabs.get(item.tabId).catch(() => null);
  return tab && (await inStash(tab)) ? tab : null;
}

export async function closeStashed(items) {
  const tabs = await Promise.all(items.map(stashedTab));
  const ids = tabs.filter(Boolean).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
}
