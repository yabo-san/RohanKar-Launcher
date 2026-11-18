'use strict';
/**
 * "Newer release": an installed upload whose title has a newer upload on
 * archive.org (a later addeddate among the item's versions). Nothing updates
 * by itself; the launcher and the Playnite export only say so.
 *
 * A version that had an update installed over it carries `current`: the
 * upload it now holds ({ id, addeddate }). Newer means newer than that.
 */

// The newest version of item added after versionId (or after what it now
// holds), or null
function newerVersion(item, versionId) {
  const versions = item?.versions || [];
  const mine = versions.find(v => v.id === versionId);
  const since = mine?.current?.addeddate || mine?.addeddate;
  if (!since) return null;
  const held = new Set([mine.id, mine.current?.id].filter(Boolean));
  let best = null;
  for (const v of versions) {
    if (!held.has(v.id) && !v.local && v.addeddate && v.addeddate > since && (!best || v.addeddate > best.addeddate)) best = v;
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
