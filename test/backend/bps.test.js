'use strict';
// BPS patches: a fixture made by another implementation (python-bps), and
// hand-built patches for each way a patch can be wrong.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { crc32 } = require('zlib');
const { applyBps, BpsError } = require('../../src/backend/bps');

const FIX = path.join(__dirname, '..', 'fixtures', 'bps');
const read = (f) => fs.readFileSync(path.join(FIX, f));

// BPS varint
function num(n) {
  const out = [];
  for (;;) {
    const x = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) { out.push(0x80 | x); return out; }
    out.push(x);
    n--;
  }
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// A patch from raw action bytes, with correct checksums unless told otherwise
function build(source, target, actions, { sourceSize = source.length, targetSize = target.length, meta = '' } = {}) {
  const body = Buffer.concat([
    Buffer.from('BPS1'), Buffer.from(num(sourceSize)), Buffer.from(num(targetSize)),
    Buffer.from(num(meta.length)), Buffer.from(meta), Buffer.from(actions),
    u32(crc32(source)), u32(crc32(target)),
  ]);
  return Buffer.concat([body, u32(crc32(body))]);
}
const act = (kind, len) => num(((len - 1) * 4) + kind);
const off = (n) => num(Math.abs(n) * 2 + (n < 0 ? 1 : 0));

test('the fixture patch (every action kind, metadata) gives the fixture target', () => {
  assert.deepEqual(applyBps(read('source.bin'), read('patch.bps')), read('target.bin'));
});

test('hand-built: SourceRead, TargetRead, SourceCopy backwards, overlapping TargetCopy', () => {
  const source = Buffer.from('ABCDEFGH');
  const target = Buffer.from('ABCxyGHCDCDCDCD');
  const actions = [
    ...act(0, 3),                         // ABC
    ...act(1, 2), ...Buffer.from('xy'),   // xy
    ...act(2, 2), ...off(6),              // GH  (source 6)
    ...act(2, 2), ...off(-6),             // CD  (source 8 - 6 = 2)
    ...act(3, 6), ...off(7),              // CDCDCD from target 7, overlapping
  ];
  assert.deepEqual(applyBps(source, build(source, target, actions, { meta: 'm' })), target);
});

test('a wrong source file, a damaged or wrong patch each say so', () => {
  const source = read('source.bin');
  const patch = read('patch.bps');
  const fails = (s, p, re) => assert.throws(() => applyBps(s, p), (e) => e instanceof BpsError && re.test(e.message));

  fails(Buffer.from('some other rom'), patch, /not the one this patch was made for/);
  fails(Buffer.concat([source, Buffer.from('x')]), patch, /not the one this patch was made for/);
  fails(source, Buffer.from('PK\x03\x04 a zip, not a patch'), /not a BPS patch/);
  const flipped = Buffer.from(patch);
  flipped[20] ^= 0xff;
  fails(source, flipped, /damaged \(checksum\)/);

  const s = Buffer.from('ABCD');
  const t = Buffer.from('ABCD');
  fails(s, build(s, t, [...act(0, 5)]), /writes past the end/);
  fails(s, build(s, Buffer.from('ABCDEF'), [...act(0, 5)], { targetSize: 6 }), /reads past the source/);
  fails(s, build(s, t, [...act(1, 4), 0x41]), /truncated/);
  fails(s, build(s, t, [...act(2, 2), ...off(3)]), /reads past the source/);
  fails(s, build(s, t, [...act(2, 2), ...off(-1)]), /reads past the source/);
  fails(s, build(s, t, [...act(3, 2), ...off(0)]), /reads ahead of the output/);
  fails(s, build(s, t, [...act(0, 2)]), /output too short/);
  fails(s, build(s, t, [0x00]), /truncated/); // a varint that never ends
  fails(s, build(s, t, [...act(1, 4), ...Buffer.from('ABCE')]), /came out wrong/);
});
