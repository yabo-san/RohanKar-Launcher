# Build your own copy

The built-in lists are part of the app: they are the archive.org uploaders and ports this repo
ships with. You can add your own from the app (paste a link into the search box, or use a `user.json`, see
[USER-SOURCES.md](USER-SOURCES.md)). If you want different picks built in for everyone who
installs your copy, fork the repo, change the lists and build your own installer.

## 1. Fork

Fork [yabo-san/RohanKar-Launcher](https://github.com/yabo-san/RohanKar-Launcher) on GitHub and
clone your fork.

## 2. Edit the lists

- **`catalog/uploaders.json`**: the archive.org uploaders. An uploader is on by default when its
  entry has `"launcher": true` and an `uploaderEmail` (what archive.org's `uploader:` field
  matches), and `track` isn't `false`.
- **`catalog/curated-ports.json`**: the port shelf. Edit it by hand: add, change or remove
  entries (the format is in [catalog/README.md](../catalog/README.md#port-shelf)). `npm test`
  checks every entry.

## 3. Point the app at your fork

The app fetches some lists from this repo's `main` at launch (`overrides.json`,
`catalog/uploaders.json`, `catalog/curated-ports.json`) and falls back to the copies it ships with. Change the
`raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/...` URLs in `src/backend/` to your
fork, or your edits only show while those fetches fail.

The update check (off unless `checkForUpdates` is set in settings.json) reads
`https://yabo-san.github.io/RohanKar-Launcher/` (`package.json` `build.publish`,
`src/electron/main.js` `UPDATE_CHANNEL_BASE`). Point both at your fork's Pages if you turn it on.

## 4. Build

- **On GitHub:** push to your fork's `main`. `release.yml` (release-please) opens a release pull
  request; merging it builds the Windows installer on `windows-latest` and attaches it to the
  release. Enable Actions on your fork first.
- **On Windows:** `npm ci`, then `npm run build`. The installer lands in `dist/`.
