# y4bo

An easy way to download games from the Internet Archive. It also downloads and installs
release builds from GitHub and GitLab.

It doesn't curate ports. With the state of AI game porting, I'm not going to judge which
ports are good or bad. The shelf has a few personal picks (GoldenEye 007 via Project Midas, Perfect Dark,
Star Fox 64: Recompiled), and everything else is yours to add: any archive.org uploader
or upload, any GitHub or GitLab repo.

I made this to test a CI/CD pipeline (see the commit history), not to show what a
proper frontend looks like. **The frontend is vibecoded.**

## Install

Download `y4bo-Setup-x.x.x.exe` from the [latest release](https://github.com/yabo-san/RohanKar-Launcher/releases/latest).
SmartScreen will warn (unsigned): **More info, then Run anyway**.
Verify a download: `gh attestation verify y4bo-Setup-x.x.x.exe --repo yabo-san/RohanKar-Launcher`

New builds aren't installed by the app; get them from the same releases page.
For Playnite, the [RohanKar extension](https://github.com/yabo-san/playnite-extensions/releases?q=rohankar-playnite) puts your library there.
Want your own built-in list? Fork it: [docs/BUILD-YOUR-OWN.md](docs/BUILD-YOUR-OWN.md).

## Credits

Fork of the RohanKar Launcher by Kilted-Kraken. Not affiliated with the Internet Archive.
Games belong to their owners and are hosted publicly on archive.org.
