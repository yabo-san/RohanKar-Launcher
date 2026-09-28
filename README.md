# Update channels

Served by GitHub Pages at https://yabo-san.github.io/RohanKar-Launcher/.
The launcher reads `stable/latest.yml`, or `beta/latest.yml` when
"Beta updates" is on in Settings.

- `beta/latest.yml` is updated by a PR that the Release workflow opens after
  each release build.
- `stable/latest.yml` only changes by hand: open a PR that copies
  `beta/latest.yml` over it.
