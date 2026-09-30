# y4bo

y4bo is a desktop game launcher for the classic PC game collection uploaded to [Archive.org](https://archive.org/search?query=uploader%3Arohanjackson071%40gmail.com) by **rohanjackson071**. Browse, install, and launch games from a single polished interface — no account required.

<img width="1280" height="800" alt="Screenshot 2026-03-23 221326" src="https://github.com/user-attachments/assets/bd3b0e92-6f0f-4d99-9138-b4e0deae2155" />

---

## Features

### 🎮 Game Library
- Pulls the full game catalogue directly from Archive.org
- Search by title and sort by name, date archived, date published, or developer
- Installed games shown with a badge
- Option to show installed games first in the list

### 📦 Download & Install
- One-click download and automatic extraction (ZIP, 7z, RAR supported)
- Automatically unblocks downloaded files so games launch without permission errors
- Optionally deletes the archive after installation to save space
- Configurable download and install folder locations

### 🚀 Launching
- Automatically finds and launches the correct executable
- Smart exe picker for games with multiple launch options (e.g. DOSBox vs native)
- Set a default executable so future launches skip the picker
- Playtime tracking per game

### 🖼️ Game Detail Panel
- Hero banner image — pulled automatically from a `hero.png` bundled in the game's archive
- Archive.org description, year, download count, and file size
- Readme viewer (reads the readme packaged with the game)
- Archive.org user reviews tab
- Open install folder directly in Explorer

### 🔔 Updates
- Automatically checks for new releases on launch
- Notifies you when an update is available with a link to download it

### 🎮 Gamepad / Controller Support

- Full gamepad navigation with standard W3C layout (Xbox / PS controllers)
- Browse the game library, navigate menus, launch and install games entirely with a controller
- On-screen keyboard for text input (search, notes)
- Mouse mode via L3 toggle
- Contextual hint bar showing available controls

### 🎮 Add to Steam

- Add any installed game to your Steam library as a Non-Steam shortcut directly from the launcher
- Exe picker modal for games with multiple executables
- Writes correctly-formatted shortcuts.vdf matching Steam's own format

---

## Interface

The launcher opens in the new interface (`src/frontend/new/`): a game wall from the curated
archive.org uploaders, Ports shelves from Quiver's community catalogs joined to
`catalog/collisions.json`, the library, and a Keep current view of what changed in the catalogs.
The classic interface (`src/frontend/index.html`) is one click away in Settings, in either
direction, and the choice is remembered. `RK_UI=legacy` also opens the classic one.

## Installation

1. Go to the [latest release](https://github.com/yabo-san/RohanKar-Launcher/releases/latest)
2. Download the installer, **y4bo-Setup-x.x.x.exe**
3. Run the installer

> **Note:** Windows may show a SmartScreen warning on first run. Click **More info → Run anyway**. This is expected for unsigned installers from new publishers.

> **Upgrading from v1.0.8 or earlier?** The auto-updater in older versions does not work correctly. Please download and install **v1.0.9** manually from the link above. From v1.0.9 onwards, updates will be detected and linked to automatically.

---

## Development

The development environment is a dev container (`.devcontainer/`). Open it with
Devsy:

```sh
devsy workspace up .    # or the `dev up` alias
mise run test
```

Creating the container runs `scripts/setup`: it installs the tools pinned in
`mise.toml` (Node 24, gh, pre-commit, Trivy), runs `npm ci`, and installs the
git hooks. Commit messages are checked against conventional commits, and
staged JavaScript is linted.

The container runs everything a PR check runs:

| Task | Runs |
|---|---|
| `mise run lint` | ESLint and a syntax check of `src` |
| `mise run test` | Unit and API tests with the 80% coverage gate |
| `mise run e2e` | The frontend in headless Chromium against the standalone backend, archive.org served from `e2e/fixtures` |
| `mise run build-dir` | An unpacked Linux build in `dist/linux-unpacked` |
| `mise run smoke` | `build-dir`, then the packaged smoke test that CI runs on the Windows build, under xvfb |
| `trivy fs --scanners vuln --severity HIGH,CRITICAL .` | The dependency scan |

To work on the app without Electron:

| Task | Runs |
|---|---|
| `mise run dev` | The backend and the frontend together, and prints the page URLs |
| `mise run backend` | Only the backend, on `127.0.0.1:5170` |
| `mise run frontend` | Only `src/frontend`, on `127.0.0.1:5173`, pointed at the backend task |
| `mise run ui` | The UI alone on `0.0.0.0:5180`, from the real data saved as JSON, no backend and no installs (below) |
| `mise run sandbox` | The backend and the UI with real installs, everything kept under `./sandbox/` (below) |

Open the printed URL in a browser: `new/index.html` is the new interface and
`index.html` the classic one. The backend keeps its data in `.launcher-data/`
and uses the token `dev`, so the URLs stay the same across restarts
(`LAUNCHER_PORT`, `FRONTEND_PORT`, `LAUNCHER_TOKEN` and `LAUNCHER_DATA_DIR`
change that). Folder pickers, the Recycle Bin, Add to Steam and the updater
need the desktop app and answer 501 here. The API is in [docs/API.md](docs/API.md).

### Web preview

Both interfaces run in a browser on GitHub Pages, no install needed:
[main](https://yabo-san.github.io/RohanKar-Launcher/preview/new/), and each PR
that touches the app gets its own under `preview/pr-<number>/new/`, linked in a
PR comment and removed when the PR closes. `.github/workflows/preview.yml`
builds it with `scripts/preview/build.js`: the backend loads the live sources
once, every response the UIs ask for at start is saved as a file, and
`scripts/preview/preview.js` answers the API from those files. Browsing,
favorites, Add/Remove and settings work (kept for the tab); installs and
launching answer 501. The JSON feeds the app reads from main at launch
(`catalog/featured.json`, `overrides.json`, `announcement.json`) are fetched
live when the page is opened, so an edit on main shows on the next reload
(raw.githubusercontent.com caches for up to 5 minutes); the saved copy answers
if that fails. The archive.org wall and the Quiver lists are the build's
snapshot, and main's preview is rebuilt nightly.

`mise run ui` is the same thing locally: the whole UI in a browser, with no
Windows, Electron or build. It saves the real sources as the Pages build does
(uploader walls, Quiver's catalogs joined to the collision catalog, main's
renames and SteamGridDB art) and serves them on `0.0.0.0:5180`: open the
forwarded port in a devcontainer, or `http://127.0.0.1:5180/`. There are no
installs in this mode. `mise run ui -- --offline` uses the e2e fixtures and a
small made-up library instead, with no network; `UI_PORT` and `UI_HOST`
change where it listens.

`mise run sandbox` is the real thing in a throwaway folder: `mise run dev`
with its data folder set to `./sandbox/`, so the library, settings, downloads
and installed games all live there and nothing touches `%APPDATA%` or the
desktop app's library. Installs download and unpack for real; launching needs
the desktop app. `mise run sandbox -- --reset` starts again from an empty
folder, and `--dir` picks another one.

To see the app, run `npm start` on Windows. The Windows installer comes only
from `release.yml` on `windows-latest`; nothing in the container builds it.

---

## Releases

Versions follow the fork line (`1.6.0-fork.0`, `1.6.0-fork.1`, …). The launcher
checks for updates against a `latest.yml` on the `gh-pages` branch, served at
`https://yabo-san.github.io/RohanKar-Launcher/stable/` (or `/beta/` with
**Settings → Beta updates** on). Two steps are done by hand:

1. **Merge the release PR.** release-please keeps a `chore(main): release …` PR
   open on `main`. Merging it tags the version, builds the Windows installer
   onto a draft release, and opens a PR against `gh-pages` that moves
   `beta/latest.yml` to the new version. Publish the draft release, then merge
   that beta PR.
2. **Merge a promotion PR.** When a beta has proven itself, open a PR against
   `gh-pages` that copies `beta/latest.yml` over `stable/latest.yml`. Stable
   never moves automatically.

To roll a channel back, revert the `gh-pages` PR that moved it. Installed
copies stop being offered the bad version on their next check. Copies that
already updated stay on it, since the updater doesn't downgrade.

Each installer and its `latest.yml` carry a build provenance attestation. To
check that a download was built by this repo's Release workflow:

```sh
gh attestation verify y4bo-Setup-x.x.x.exe --repo yabo-san/RohanKar-Launcher
```

---

## Requirements

- Windows 10 or later
- Internet connection (to browse and download games from Archive.org)

---

## Notes for Game Uploaders

To include a hero banner image for your game, place a file named `hero.png` in the root of your archive alongside the game folder and readme. The launcher will automatically display it as the banner when your game is selected.

Recommended hero image dimensions: **1920 × 620px**

---

## Tech Stack

- [Electron](https://www.electronjs.org/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [electron-updater](https://www.electron.build/auto-update)
- [Archive.org Advancedsearch API](https://archive.org/advancedsearch.php)

---

## License

This project is not affiliated with the Internet Archive. All games in the collection are property of their respective owners and are hosted publicly on Archive.org.
