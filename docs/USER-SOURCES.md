# User-added sources

The launcher ships with a starting list: the archive.org uploaders in `catalog/uploaders.json`
and the built-in port shelf (`catalog/curated-ports.json`). Anyone can add their own on top, with
no switch to turn on and no warning to click through. What you add loads next to what ships and
looks the same.

An upload made of zip, 7z or rar archives (what RohanKar expects) installs and plays from the
launcher. Anything else (an .iso, a .pkg, loose files) still downloads into its folder, so the
launcher works as a download client for any archive.org upload; Open folder gets to the files.

## Where you add your own

Everything goes in through **Add** (the sidebar, the + in the title row, or pasting a link
anywhere in the window). Paste a link and press Enter:

| You paste | What happens |
| --- | --- |
| `https://archive.org/details/@handle` (or `@handle`, or the account's email) | The account's software uploads join the game wall |
| `https://archive.org/details/<identifier>` | It asks: just this upload, or the whole account that uploaded it |
| `https://github.com/owner/repo` (or `owner/repo`) | The repo joins Your ports and its latest release's Windows build installs |
| `https://gitlab.com/group/project` (subgroups too) | The same, from GitLab's releases |

A repo whose latest release has no Windows build stays on Your ports; right-click opens its page.

Right-click a game and **Hide from Wall** to leave its uploads out (an installed game keeps its
card). Settings > Your sources lists every account, upload and repo you added, each with Remove,
and brings hidden uploads back.

Settings also takes an optional **GitHub token**. GitHub allows 60 release checks an hour without
one; with one, it's sent on GitHub API requests only and never logged.

Under the hood, accounts and uploads are saved as `sources` in settings.json and hidden uploads as
`excludeItems`. A source can carry `titleInclude` / `titleExclude` (pipe-separated words matched
case-insensitively against the archive.org title); a built-in entry's filters from
`catalog/uploaders.json` always apply. An account that matches a built-in entry's email or any of
its `handles` is that built-in account, not a second one.

## user.json

A local file (no URLs for now), named by its full path in Settings. Schema version 1, three arrays:

```json
{
  "schemaVersion": 1,
  "archive": [
    { "identifier": "my-homebrew", "title": "My Homebrew", "files": [{ "name": "my-homebrew.zip", "sha1": "0123…" }] },
    { "identifier": "my-demo" }
  ],
  "github": [
    { "repository": "me/tool", "name": "My Tool", "assetPattern": "(?i)windows", "sha1": "…" }
  ],
  "exclude": [
    "an-upload-i-dont-want",
    "https://archive.org/details/another-one"
  ]
}
```

- `archive`: a standalone archive.org download. `identifier` is the item's identifier or its
  URL (`https://archive.org/details/<identifier>`, `/download/<identifier>/...`, with or without
  `www.`, a trailing slash or a query string); a URL is read as the identifier. `title` is
  optional (archive.org's title otherwise); `files` lists sha1s for files you want checked.
- `github`: a standalone GitHub release binary: `repository`, and optionally `name`,
  `folderName`, `assetPattern` and the `sha1` of the release asset. A repository no catalog lists
  shows on Your ports.
- `exclude`: uploads to leave off the wall, from any uploader, built-in ones included: identifiers
  or item URLs, as for `archive`. Settings' `- ` lines do the same.

An older file's `collisions` array is not read: each entry is listed as invalid ("collisions are
no longer supported"), since collisions are parked on the `parked/collisions` branch.

`sha1` is optional everywhere.

## Rules

1. **Built-in wins.** A user entry with the same repository or identifier as a built-in one is
   ignored and listed under the file in Settings as a conflict: a `github` entry for a repository a
   port shelf lists, and an `archive` entry for an item a built-in uploader has.
2. **sha1.** A file with a sha1 is checked, and a mismatch fails the install.
   A file without one has its sha1 recorded on first install (`pins.json` in the data folder). If
   a later install of the same file gets a different sha1, the install stops before anything is
   written and a modal asks:
   **File changed**: "… is not the file you installed before … Only continue if you trust the
   source." [Cancel] [Install anyway]. Install anyway re-pins the new sha1.
   archive.org files are pinned per item and file name; GitHub release assets per release tag and
   asset name, so a new release pins afresh and a replaced asset in the same release asks.
3. **Validation.** The file is validated whenever it is read. A file that can't be used at all
   (missing, not JSON, wrong `schemaVersion`, a section that isn't an array) shows its error; each
   invalid entry is listed with its section, index, key and every reason, and the valid entries
   still load. Nothing is skipped silently.

The logic is in `src/backend/sources.js` (what a line or URL names, title filters),
`archive.js` (an account's uploads by handle), `user-sources.js` (read, validate, pins), `catalogs.js` (`github`
entries and Your ports), `items.js` (uploaders, `archive` entries and excludes) and `installs.js` (sha1 checks
and pins). The renderer only draws what `GET /v1/user-sources` and the items say.

## How a handle is resolved

archive.org's search matches `uploader:` against the account's email, which a profile page
doesn't show. For an `@handle` the launcher asks for the account's uploads the way archive.org's
own profile page does:

```text
https://archive.org/services/search/beta/page_production/?page_type=account_details&page_target=@<handle>&page_elements=["uploads"]&hits_per_page=100&page=<n>
```

It reads `response.body.page_elements.uploads.hits` (`total`, and `hits[].fields` with
`identifier`, `title`, `mediatype` and the rest), pages until it has `total`, and keeps
`mediatype` software (or none given), the same as the email search. A handle with no uploads is
reported as a failed source ("no uploads found for @handle"). The response shape this relies on is
in `test/fixtures/archive/account-uploads.json`.
