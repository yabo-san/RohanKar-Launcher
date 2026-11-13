'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPadReader, nextIndex, stickDir } = require('../src/frontend/gamepad');

// A standard-mapping pad with these buttons held and these axes
const pad = (held = [], axes = [0, 0, 0, 0]) => ({
  connected: true,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })),
});

test('stickDir: the stronger axis past the deadzone', () => {
  assert.equal(stickDir(0.2, -0.3), null);
  assert.equal(stickDir(0.9, 0.4), 'right');
  assert.equal(stickDir(-0.5, 0.1), 'left');
  assert.equal(stickDir(0.1, -0.8), 'up');
  assert.equal(stickDir(0, 0.36), 'down');
});

test('pad reader: buttons fire once per press, not while held', () => {
  const read = createPadReader();
  assert.deepEqual(read([pad([0])], 0).actions, ['a']);
  assert.deepEqual(read([pad([0])], 16).actions, [], 'still held');
  assert.deepEqual(read([pad([])], 32).actions, []);
  assert.deepEqual(read([pad([0, 3, 9])], 48).actions, ['a', 'y', 'start']);
  assert.deepEqual(read([pad([1, 2, 4, 5, 8])], 64).actions, ['b', 'x', 'lb', 'rb', 'select']);
});

test('pad reader: a held direction repeats after the delay, then at the rate', () => {
  const read = createPadReader({ delay: 400, rate: 120 });
  const at = (t, p = pad([13])) => read([p], t).actions;
  assert.deepEqual(at(0), ['down']);
  assert.deepEqual(at(200), []);
  assert.deepEqual(at(400), ['down']);
  assert.deepEqual(at(500), []);
  assert.deepEqual(at(520), ['down']);
  assert.deepEqual(at(530, pad()), [], 'let go');
  assert.deepEqual(at(540), ['down'], 'a new press fires at once');
  assert.deepEqual(read([pad([], [0.9, 0, 0, 0])], 600).actions, ['right'], 'the left stick as the d-pad');
});

test('pad reader: the right stick scrolls, the deadzone ignored, missing pads skipped', () => {
  const read = createPadReader();
  assert.equal(read([pad([], [0, 0, 0, 0.2])], 0).scroll, 0);
  assert.equal(read([null, pad([], [0, 0, 0, -0.7])], 16).scroll, -0.7);
  assert.deepEqual(read([{ ...pad([0]), connected: false }], 32).actions, []);
  assert.deepEqual(read(undefined, 48), { actions: [], scroll: 0 });
});

test('nextIndex: the nearest rect that way, in line beating off to the side', () => {
  const box = (left, top, w = 100, h = 100) => ({ left, top, right: left + w, bottom: top + h });
  // A 3 by 2 grid of cards with 20px gaps, and a sidebar item far left
  const grid = [box(200, 0), box(320, 0), box(440, 0), box(200, 120), box(320, 120), box(0, 0, 150, 30)];
  assert.equal(nextIndex(grid[0], grid, 'right'), 1);
  assert.equal(nextIndex(grid[1], grid, 'right'), 2);
  assert.equal(nextIndex(grid[2], grid, 'right'), -1, 'nothing further right');
  assert.equal(nextIndex(grid[1], grid, 'down'), 4);
  assert.equal(nextIndex(grid[2], grid, 'down'), 4, 'the short last row: the nearest one off to the side');
  assert.equal(nextIndex(grid[4], grid, 'up'), 1);
  assert.equal(nextIndex(grid[0], grid, 'left'), 5, 'out to the sidebar');
  assert.equal(nextIndex(grid[3], grid, 'left'), 5);
  assert.equal(nextIndex(null, grid, 'down'), 0, 'no focus yet: the first');
  assert.equal(nextIndex(null, [], 'down'), -1);
});
