# User-added sources

The launcher ships with a starting list: the archive.org uploaders in `catalog/uploaders.json`
and the built-in port shelf (`catalog/curated-ports.json`). Anyone can add their own on top, with
no switch to turn on and no warning to click through. What you add loads next to what ships and
looks the same.

## Where you add your own

| Source | Where it's added |
| --- | --- |
| `user.json` | Settings > Your sources > user.json (a file path) |
| Your own GitHub repos | Add a GitHub repo |
| Any other uploader | Settings > Uploaders |
| A single upload pasted as a link | Settings > Uploaders, or `archive` in user.json |

## Settings > Uploaders

One line per uploader:

```text
rohanjackson071@gmail.com, Rohan
@pstriple
https://archive.org/details/@eldritchpenumbra, Eldritch, +Windows|Linux, -DVD|PS3
lawlessb991@gmail.com, thiago86, -discography
https://archive.org/details/some-single-upload
- https://archive.org/details/an-upload-i-dont-want
# someone@example.com, turned off for now
```

What the first field can be:

| You type | What loads |
| --- | --- |
| `me@example.com` | The account's software uploads (archive.org's `uploader:` field is the account email) |
| `@handle` | The account's software uploads, from its profile's uploads list |
| `handle` (no @) | The same as `@handle`. archive.org's `uploader:` field is always an email, so a name without @ can only be a handle |
| `https://archive.org/details/@handle` | The same, with or without `/uploads`, a query string or `#...` after it; `http`, `www.` and `archive.org/@handle` work too |
| `https://archive.org/search?query=uploader:"me@example.com"` | The same as the email (the form `catalog/uploaders.json` keeps in `url`) |
| `https://archive.org/details/<identifier>` | That one upload (also `/download/<identifier>/...`) |

Then, after commas, in any order:

- a **label** (what the wall calls the uploader; default: the handle, the part of the email before
  @, or the identifier);
- **`-word|word`**: leave out uploads whose title contains any of the words;
- **`+word|word`**: keep only uploads whose title contains one of the words.

Matching is a case-insensitive substring of the archive.org title (not an `overrides.json`
rename). Exclude beats include. A word can't contain a comma or `|`.

A line starting with **`-`** leaves one upload out wherever it comes from: an identifier or any
item URL as above. It's stored as `excludeItems` in settings, as identifiers; anything that isn't
an upload is refused on save, naming it. A leading `#` turns a line off.

An upload left out by a filter or an exclude still shows if it's installed, so an installed game
keeps its card. Changing excludes needs no refetch; changing filters reloads the wall.

A line names a built-in uploader when it matches the built-in entry's email or any of its handles
(`handle` and `handles` in `catalog/uploaders.json`), so `@hailstormttv` and `@tirednonfire` are
the built-in account, not one of your own. A built-in entry's `titleInclude`/`titleExclude` always apply
on top of whatever the line adds; a line can't remove them.

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
