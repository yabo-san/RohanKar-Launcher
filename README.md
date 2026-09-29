# RohanKar Launcher

A desktop game launcher for the classic PC game collection uploaded to [Archive.org](https://archive.org/search?query=uploader%3Arohanjackson071%40gmail.com) by **rohanjackson071**. Browse, install, and launch games from a single polished interface — no account required.

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

## Installation

1. Go to the [latest release](https://github.com/Kilted-Kraken/-RohanKar-Launcher/releases/latest)
2. Download **RohanKar Launcher Setup x.x.x.exe**
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
| `mise run test` | Unit tests with the 80% coverage gate |
| `mise run e2e` | Playwright tests headless under xvfb, archive.org served from `e2e/fixtures` |
| `mise run build-dir` | An unpacked Linux build in `dist/linux-unpacked` |
| `trivy fs --scanners vuln --severity HIGH,CRITICAL .` | The dependency scan |

The smoke test that CI runs on the Windows build also runs against the Linux
one: `E2E_APP=dist/linux-unpacked/rohankar-launcher mise run e2e` after
`mise run build-dir`.

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
gh attestation verify RohanKar-Launcher-Setup-1.6.0-fork.0.exe --repo yabo-san/RohanKar-Launcher
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
