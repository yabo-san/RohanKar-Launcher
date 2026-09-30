'use strict';
/**
 * "Newer release": an installed upload whose title has a newer upload on
 * archive.org (a later addeddate among the item's versions). Nothing updates
 * by itself; the launcher and the Playnite export only say so.
 */

// The newest version of item added after versionId, or null
function newerVersion(item, versionId) {
  const versions = item?.versions || [];
  const mine = versions.find(v => v.id === versionId);
  if (!mine?.addeddate) return null;
  let best = null;
  for (const v of versions) {
    if (v.id !== mine.id && v.addeddate && v.addeddate > mine.addeddate && (!best || v.addeddate > best.addeddate)) best = v;
  }
  return best ? best.id : null;
}

// row: a library.db row; item: the loaded item holding its version
const updateAvailable = (row, item) => !!row?.install_dir && !!newerVersion(item, row.identifier);

// The item with each version's `newer`: the id of the newest later upload, or null
function withNewer(item) {
  if (!item?.versions?.length) return item;
  return { ...item, versions: item.versions.map(v => ({ ...v, newer: newerVersion(item, v.id) })) };
}

module.exports = { newerVersion, updateAvailable, withNewer };
