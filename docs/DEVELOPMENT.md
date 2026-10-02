# Development and releases

Moved here from the README unchanged (only the link to API.md is fixed for the new folder).

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
need the desktop app and answer 501 here. The API is in [docs/API.md](API.md).

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
(`catalog/featured.json` and `catalog/art.json`, `overrides.json`,
`announcement.json`) are fetched
live when the page is opened, so an edit on main shows on the next reload
(raw.githubusercontent.com caches for up to 5 minutes); the saved copy answers
if that fails. The archive.org wall and the Quiver lists are the build's
snapshot, and main's preview is rebuilt nightly.

`mise run ui` is the same thing locally: the whole UI in a browser, with no
Windows, Electron or build. It saves the real sources as the Pages build does
(uploader walls, Quiver's catalogs, main's
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
   onto a draft release, runs the packaged smoke test against it, and
   publishes it as the latest GitHub release. It then opens a PR against
   `gh-pages` that moves `beta/latest.yml` to the new version; merge that beta
   PR. A build that fails the smoke test stays a draft and no beta PR opens.
2. **Merge a promotion PR.** When a beta has proven itself, open a PR against
   `gh-pages` that copies `beta/latest.yml` over `stable/latest.yml`. Stable
   never moves automatically, even though the newest build is always the
   latest release on GitHub.

To roll a channel back, revert the `gh-pages` PR that moved it. Installed
copies stop being offered the bad version on their next check. Copies that
already updated stay on it, since the updater doesn't downgrade.

Each installer and its `latest.yml` carry a build provenance attestation. To
check that a download was built by this repo's Release workflow:

```sh
gh attestation verify y4bo-Setup-x.x.x.exe --repo yabo-san/RohanKar-Launcher
```
