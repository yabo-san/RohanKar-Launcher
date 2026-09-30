'use strict';
/**
 * BPS patches (byuu's format, what Flips writes): a collision's
 * dataFiles[].patch turns the file archive.org has into the one the port
 * expects, before the sha1 check.
 *
 *   "BPS1", sourceSize, targetSize, metadataSize, metadata, actions...,
 *   sourceCrc32, targetCrc32, patchCrc32 (little-endian)
 *
 * Every number is a varint; an action is (length - 1) << 2 | kind, where kind
 * is SourceRead, TargetRead, SourceCopy or TargetCopy.
 */
const { crc32 } = require('zlib');

class BpsError extends Error {}

// Returns the patched Buffer, or throws a BpsError saying what is wrong
function applyBps(source, patch) {
  if (patch.length < 4 + 3 + 12 || patch.toString('latin1', 0, 4) !== 'BPS1') throw new BpsError('not a BPS patch');
  const end = patch.length - 12;
  if (crc32(patch.subarray(0, patch.length - 4)) !== patch.readUInt32LE(patch.length - 4)) throw new BpsError('the patch is damaged (checksum)');

  let at = 4;
  const num = () => {
    let data = 0;
    let shift = 1;
    for (;;) {
      if (at >= end) throw new BpsError('the patch is damaged (truncated)');
      const x = patch[at++];
      data += (x & 0x7f) * shift;
      if (x & 0x80) return data;
      shift *= 128;
      data += shift;
    }
  };

  const sourceSize = num();
  const targetSize = num();
  const metadata = num();
  at += metadata;
  if (source.length !== sourceSize || crc32(source) !== patch.readUInt32LE(end)) {
    throw new BpsError('the file is not the one this patch was made for');
  }

  const target = Buffer.alloc(targetSize);
  let out = 0;
  let sourceRel = 0;
  let targetRel = 0;
  const room = (n) => { if (out + n > targetSize) throw new BpsError('the patch is damaged (writes past the end)'); };
  const offset = () => { const d = num(); return (d & 1 ? -1 : 1) * Math.floor(d / 2); };
  while (at < end) {
    const data = num();
    const len = Math.floor(data / 4) + 1;
    room(len);
    switch (data & 3) {
      case 0: // SourceRead: the same bytes as the source at this position
        if (out + len > source.length) throw new BpsError('the patch is damaged (reads past the source)');
        source.copy(target, out, out, out + len);
        out += len;
        break;
      case 1: // TargetRead: bytes from the patch
        if (at + len > end) throw new BpsError('the patch is damaged (truncated)');
        patch.copy(target, out, at, at + len);
        at += len;
        out += len;
        break;
      case 2: // SourceCopy: from anywhere in the source
        sourceRel += offset();
        if (sourceRel < 0 || sourceRel + len > source.length) throw new BpsError('the patch is damaged (reads past the source)');
        source.copy(target, out, sourceRel, sourceRel + len);
        sourceRel += len;
        out += len;
        break;
      default: // TargetCopy: from what is written so far, byte by byte (runs may overlap)
        targetRel += offset();
        if (targetRel < 0 || targetRel >= out) throw new BpsError('the patch is damaged (reads ahead of the output)');
        for (let i = 0; i < len; i++) target[out++] = target[targetRel++];
    }
  }
  if (out !== targetSize) throw new BpsError('the patch is damaged (output too short)');
  if (crc32(target) !== patch.readUInt32LE(end + 4)) throw new BpsError('the patched file came out wrong (checksum)');
  return target;
}

module.exports = { applyBps, BpsError };
