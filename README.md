# y4bo

An easy way to download games from the Internet Archive. It also downloads and installs
release builds from GitHub and GitLab.

It doesn't curate ports. With the state of AI game porting, I'm not going to judge which
ports are good or bad. The shelf has a few personal picks (GoldenEye 007 via Project Midas, Perfect Dark,
Star Fox 64: Recompiled), and everything else is yours to add: any archive.org uploader
or upload, any GitHub or GitLab repo.

I made this to test a CI/CD pipeline (see the commit history), not to show what a
proper frontend looks like. **The frontend is vibecoded.**

## What it does

- **archive.org:** a few uploaders are built in (Rohan's uploads, pstriple, r4ze, with box art
  and titles cleaned up by hand); add any other uploader or single upload. One-click download
  and extract (zip, 7z, rar).
- **GitHub and GitLab:** install a repo's latest release build. A few personal picks are built in;
  add any other repo yourself.
- **Add your own:** paste an archive.org uploader, a single upload or a GitHub/GitLab repo link into the search box.
  Settings copies your setup out as text and pastes one back in.
  Want your own built-in list? Fork it and build your own: [docs/BUILD-YOUR-OWN.md](docs/BUILD-YOUR-OWN.md).
- **Launch:** picks the right exe, or lets you choose when there are several.
- **Add to Steam:** adds an installed game to Steam as a non-Steam shortcut (Big Picture, Steam Deck).
- **Playtime:** tracks how long you've played each game.
- **Uninstall:** moves the game's folder to the Recycle Bin, so it can be undone.
- **Open folder:** opens the install folder, for adding data files, mods or saves by hand.
- **Updates:** the launcher updates itself; installed ports show when a newer release is out.
- **Playnite:** the [RohanKar extension](https://github.com/yabo-san/playnite-extensions/releases?q=rohankar-playnite) puts your library in Playnite.

## Install

Download `y4bo-Setup-x.x.x.exe` from the [latest release](https://github.com/yabo-san/RohanKar-Launcher/releases/latest).
SmartScreen will warn (unsigned): **More info, then Run anyway**.
Verify a download: `gh attestation verify y4bo-Setup-x.x.x.exe --repo yabo-san/RohanKar-Launcher`

## Credits

Fork of the RohanKar Launcher by Kilted-Kraken. Not affiliated with the Internet Archive.
Games belong to their owners and are hosted publicly on archive.org.
