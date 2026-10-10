# Tabshelf

Chrome extension that keeps your tab strip down to what you're using.

- Switch away from a tab and it lands on the shelf (side panel) as an **app**. The tab itself moves into a collapsed
  "Shelved" tab group, so it stays loaded and comes back instantly, scroll position and all.
- Shelve a second tab from the same site and the app becomes a **folder** you can open and browse.
- Each window keeps a pinned Tabshelf home tab, so closing your current tab never closes the window.
- Click an app or folder item to reopen it. Pinned, audible, non-web tabs, and tabs in your own groups are never shelved.

Keys in the launcher: arrows move, Enter opens, Esc / Backspace / ← leaves a folder, Delete removes.

## Install

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this folder.
2. Click the toolbar icon, or press Alt+Shift+S (Option+Shift+S on a Mac), to open the side panel.
   Change the shortcut at `chrome://extensions/shortcuts`.

## Test

`npm test` (Node 22+, no dependencies).
