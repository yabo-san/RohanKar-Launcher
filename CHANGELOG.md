# Changelog

## [1.6.0-fork.5](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.6.0-fork.4...v1.6.0-fork.5) (2026-09-29)


### Features

* batch 1 of curated SteamGridDB covers for pstriple's items ([40f5a8c](https://github.com/yabo-san/RohanKar-Launcher/commit/40f5a8ca9bacd2e67b73b544ae905c65142c0b94))
* box-art pipeline into overrides.json, batch 1 (17 pstriple covers) ([662efda](https://github.com/yabo-san/RohanKar-Launcher/commit/662efda37c09837f1091620c325c72883293ff1f))
* box-art script writes approved covers and heroes into overrides.json ([67ab14a](https://github.com/yabo-san/RohanKar-Launcher/commit/67ab14a880f8264f8183d06da822a632c2b456e6))
* list top three SteamGridDB candidates for items with no curated cover ([dfc10f6](https://github.com/yabo-san/RohanKar-Launcher/commit/dfc10f67c95ee960079628563f3e1df2b6a5db19))
* pin curated SteamGridDB covers for 12 of pstriple's items ([8b5978b](https://github.com/yabo-san/RohanKar-Launcher/commit/8b5978b276e869aadd30d4e2364246f67b0a33d1))


### Bug Fixes

* strip emulator and build text from box-art search titles ([2074fbb](https://github.com/yabo-san/RohanKar-Launcher/commit/2074fbb045f2364b5996bba473acb7920e02d0d6))

## [1.6.0-fork.4](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.6.0-fork.3...v1.6.0-fork.4) (2026-09-29)


### Features

* **backend:** write playnite-export.json on every library change ([c4d1b7a](https://github.com/yabo-san/RohanKar-Launcher/commit/c4d1b7a17f563967a4e71f17957016c3878034a2))
* **cli:** add --export-playnite, --install, --uninstall and --launch ([8d9be4a](https://github.com/yabo-san/RohanKar-Launcher/commit/8d9be4a093e7a0f2bdd04c4bc5d30740ac2f94ae))
* Playnite export and CLI flags (step 7) ([eb02ed6](https://github.com/yabo-san/RohanKar-Launcher/commit/eb02ed685b3b32fafb9bc5faf1878e778ec2bf40))
* **ui:** ship the new y4bo interface, with a toggle to the classic one ([5add284](https://github.com/yabo-san/RohanKar-Launcher/commit/5add2843e491b7ef9bf4535a42df362b0a58449a))
* **ui:** ship the new y4bo interface, with a toggle to the classic one ([e787f59](https://github.com/yabo-san/RohanKar-Launcher/commit/e787f598f90a97ea93923e60b8f3f2786d31ab43))

## [1.6.0-fork.3](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.6.0-fork.2...v1.6.0-fork.3) (2026-09-29)


### Features

* load default sources from catalog/uploaders.json ([2a182ce](https://github.com/yabo-san/RohanKar-Launcher/commit/2a182ce23a0936b3c5667305c406d1f1f1901f09))
* load default sources from catalog/uploaders.json ([6d652c0](https://github.com/yabo-san/RohanKar-Launcher/commit/6d652c059d09031d8cd64a2832c80ac776c4cf0d))

## [1.6.0-fork.2](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.6.0-fork.1...v1.6.0-fork.2) (2026-09-29)


### Features

* per-title overrides for title, cover and hero ([56abeaf](https://github.com/yabo-san/RohanKar-Launcher/commit/56abeaf5a9e65f18dcd51ee4655f41e4e0d32591))
* per-title overrides for title, cover and hero ([fe931cd](https://github.com/yabo-san/RohanKar-Launcher/commit/fe931cd37cca934575da7d96361336a90fd0a1e5))

## [1.6.0-fork.1](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.6.0-fork.0...v1.6.0-fork.1) (2026-09-28)


### Bug Fixes

* always write latest.yml, also for -fork versions ([b881dc3](https://github.com/yabo-san/RohanKar-Launcher/commit/b881dc3140da243bb8ce916c080e3dd95a818c60))
* channel files point at the release assets by absolute URL ([5d15c57](https://github.com/yabo-san/RohanKar-Launcher/commit/5d15c57c96ecd9b246de239a39997ee299c1f4b8))

## [1.6.0-fork.0](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.5.0...v1.6.0-fork.0) (2026-09-28)


### Features

* stable and beta update channels served from gh-pages ([c90ebbc](https://github.com/yabo-san/RohanKar-Launcher/commit/c90ebbc3a3bf34ac6fc953a060bcb4c024c56230))
* stable and beta update channels served from gh-pages ([69fbd9b](https://github.com/yabo-san/RohanKar-Launcher/commit/69fbd9bb1f67ed8b62e0a35af88daeadb39ab29b))

## [1.5.0](https://github.com/yabo-san/RohanKar-Launcher/compare/v1.4.1...v1.5.0) (2026-09-28)


### Features

* ship pstriple and r4zel1ght as default sources ([a2c9bca](https://github.com/yabo-san/RohanKar-Launcher/commit/a2c9bca6ca0c638c2096c602d2c2b984ec1a2081))


### Bug Fixes

* drop async promise executor in launch-game handler ([55498f2](https://github.com/yabo-san/RohanKar-Launcher/commit/55498f2c18cfbfd320e0cc930e5dd3148dda3457))
* drop async promise executor in launch-game handler ([ff050dd](https://github.com/yabo-san/RohanKar-Launcher/commit/ff050dd7063ed250c8b14288e38231fcf07df897))
* hero from cached cover, release the cover observer on re-render ([433bd52](https://github.com/yabo-san/RohanKar-Launcher/commit/433bd528a507b743201595157485ebd6ed83d6ff))
* hero uses the cached cover and the grid releases its cover observer ([dbfe477](https://github.com/yabo-san/RohanKar-Launcher/commit/dbfe477623abfff2f737899693d93dedcf18f453))
* home banner uses the cached cover too ([91f98e8](https://github.com/yabo-san/RohanKar-Launcher/commit/91f98e8449d1e7808f48090b1ebb8aff810b5195))
