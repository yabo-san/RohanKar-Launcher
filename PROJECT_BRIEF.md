# y4bo — Project Brief

## Current Version: 0.1.0 — Session 1 Complete

## Stack
- Electron (frameless window)
- Vanilla JS + CSS
- archive.org public API (uploader: rohanjackson071@gmail.com)
- SQLite planned for Session 3+

## What is Built
- [x] Frameless custom window with titlebar
- [x] Minimize / Maximize / Close controls
- [x] RK Logo in titlebar
- [x] Left sidebar with scrollable game list (200 games)
- [x] Live search filtering
- [x] archive.org API integration
- [x] Game thumbnails loading from archive.org
- [x] Hero image area with gradient overlay
- [x] Right detail panel with metadata
- [x] Download / Launch / Delete buttons (UI only, not wired yet)
- [x] Dark theme with red/orange accent, Rajdhani + Inter fonts
- [x] GitHub repo clean with .gitignore

## What is Next (Session 2)
- [ ] Fix hero and detail panel images not displaying on game select
- [ ] Download manager with progress bar
- [ ] Extract ZIP/7z after download
- [ ] Detect .exe and store launch path
- [ ] Launch game functionality
- [ ] Delete downloaded files option
- [ ] SQLite library to track installed games

## Known Issues
- Hero image and right panel cover not displaying when game selected
- DevTools still opening on launch (need to remove)

## File Structure
src/
  main/main.js        — Electron main process
  renderer/
    index.html        — App shell
    style.css         — All styles
    renderer.js       — UI logic
assets/
  icons/
    rk-logo.jpg       — RK brand logo
PROJECT_BRIEF.md      — This file

## GitHub Repo
https://github.com/Kilted-Kraken/-RohanKar-Launcher

## archive.org Uploader
Email: rohanjackson071@gmail.com
API: https://archive.org/advancedsearch.php?q=uploader%3Arohanjackson071%40gmail.com+mediatype%3Asoftware
