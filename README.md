# Dockside

**Leave a tab. It docks.**

<p align="center"><img src="docs/hero.svg" alt="tabs leave the tab strip and fly into the side panel as apps; a second GitHub tab turns its app into a folder" width="960"></p>

Your tab strip fills up with tabs you're not using but don't want to lose. Dockside clears them out as you go. When you switch away from a tab, it docks in Chrome's side panel as an app. Dock a second tab from the same site and the app becomes a folder.

Nothing is closed. Docked tabs wait in one collapsed tab group, still loaded, so opening one brings it straight back with its scroll position, half-typed form, and login intact.

## Install

Dockside isn't on the Chrome Web Store yet. Load it unpacked:

```sh
git clone https://github.com/richdapice/dockside.git
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `dockside` folder.
3. Press **Option+Shift+S** (Alt+Shift+S on Windows and Linux) or click the toolbar icon to open the panel. Press it again to
   close it.

## What you get

**A tab strip that only holds what you're using.** Switch tabs and the one you left docks after half a second. Close a tab yourself and it's gone, not docked.

**Apps and folders.** One tab from a site is an app. Two or more become a folder with a count; open it to see every tab, how long ago you left it, and a × to drop it.

**Tabs that don't reload.** Docked tabs live in a collapsed group at the end of the strip, its chip showing ⚓ and how many are inside. Click an app or a folder row and the live tab comes out. Expand the group and click a tab there, and that works too.

**Your arrangement.** Drag tiles to reorder them. New sites land at the front, so the tab you just left is easy to find.

**Bulk moves.** **Cache tabs** closes every docked tab to free memory; the dock keeps them, and opening one loads it fresh from its address. **Clear dock** empties the dock and closes its tabs, after asking you to confirm.

**A panel that gets out of the way.** Opening a tab from the side panel closes the panel. Click the lock in its corner to keep it open instead.

**A window that stays open.** Each window keeps a pinned Dockside tab showing the launcher, so closing your last regular tab never closes the window.

## Keys

| Where | Key | Does |
|---|---|---|
| Anywhere in Chrome | Option+Shift+S | Open or close the panel (change it at `chrome://extensions/shortcuts`) |
| Grid | ← → ↑ ↓ | Move between tiles |
| Grid | Enter | Open an app, or open a folder |
| Folder | ↑ ↓ | Move between tabs |
| Folder | Enter | Bring that tab back |
| Folder | Esc, Backspace, ← | Back to the grid |
| Grid or folder | Delete | Remove the selected item, closing its docked tabs |

## What never docks

- Pinned tabs and tabs playing audio.
- Tabs in a group you made. Your groups stay yours.
- Pages that aren't web pages: `chrome://` pages, the New Tab page, extension pages.

## How it works

- **The dock** is a list in `chrome.storage.local`: URL, title, site, when you left it, and the live tab's id.
- **The ⚓ group** is tracked by id, so a group of your own that happens to have a similar title is left alone. After a browser restart, ids change: Dockside takes back restored ⚓ groups that hold docked pages and matches their tabs to dock items by URL. If a tab is gone, its app opens the URL fresh instead.
- **Duplicates:** docking a page that's already in the dock keeps only the newer tab.

Permissions: `tabs` and `tabGroups` to move tabs in and out of the group, `storage` for the dock, `sidePanel` for the launcher, `favicon` for site icons. No host permissions; Dockside never reads page content.

## Development

No build step and no dependencies. Edit the files, then click reload on the extension in `chrome://extensions`.

```sh
npm test    # unit tests for the dock logic (Node 22+)
```

## License

[MIT](LICENSE)
