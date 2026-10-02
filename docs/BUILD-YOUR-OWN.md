# Build your own copy

The curated lists are part of the app: they are the archive.org uploaders and ports this repo
ships with. You can add your own from the app (Settings, with additional sources allowed, or a
`user.json`, see [USER-SOURCES.md](USER-SOURCES.md)), and everything you add is marked
"Your source". If you want different picks built in for everyone who installs your copy, fork
the repo, change the lists and build your own installer.

## 1. Fork

Fork [yabo-san/RohanKar-Launcher](https://github.com/yabo-san/RohanKar-Launcher) on GitHub and
clone your fork.

## 2. Edit the lists

- **`catalog/uploaders.json`**: the archive.org uploaders. An uploader is on by default when its
  entry has `"launcher": true` and an `uploaderEmail` (what archive.org's `uploader:` field
  matches), and `track` isn't `false`.
- **`catalog/curated-extras.json`**: ports and tools you add to the port shelf by hand
  (`name`, `repository`, `folderName`, and `releaseAssetFilter` when the release has several
  Windows files).

## 3. Rebuild the port shelf, or keep it

`catalog/curated-ports.json` is what the app loads. It is built from a community list plus
`catalog/curated-extras.json`:

    CURATED_PORTS_SOURCE_URL=... node scripts/curated-ports.js

`CURATED_PORTS_SOURCE_URL` is the community list's address, set in your own shell. If you don't
have one, keep the committed `catalog/curated-ports.json` and add your entries to it directly.

## 4. Point the app at your fork

The app fetches some lists from this repo's `main` at launch (`overrides.json`,
`catalog/uploaders.json`, `catalog/curated-ports.json`, `catalog/featured.json`,
`catalog/art.json`) and falls back to the copies it ships with. Change the
`raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/...` URLs in `src/backend/` to your
fork, or your edits only show while those fetches fail.

The self-updater checks `https://yabo-san.github.io/RohanKar-Launcher/` (`package.json`
`build.publish`, `src/electron/main.js` `UPDATE_CHANNEL_BASE`). Point both at your fork's Pages,
or your copy offers this repo's releases as updates.

## 5. Build

- **On GitHub:** push to your fork's `main`. `release.yml` (release-please) opens a release pull
  request; merging it builds the Windows installer on `windows-latest` and attaches it to the
  release. Enable Actions on your fork first.
- **On Windows:** `npm ci`, then `npm run build`. The installer lands in `dist/`.
