'use strict';
// Gamepad input, without the page: which buttons were just pressed, which way
// the left stick or d-pad points (repeating while held, like a held arrow key),
// and which element lies in that direction. new/pad.js does the page side.

// The browser's "standard" mapping (Steam Input and XInput pads report it)
const BUTTONS = { 0: 'a', 1: 'b', 2: 'x', 3: 'y', 4: 'lb', 5: 'rb', 8: 'select', 9: 'start' };
const DPAD = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

// The way a stick points, or null inside the deadzone
function stickDir(x = 0, y = 0, deadzone = 0.35) {
  if (Math.max(Math.abs(x), Math.abs(y)) < deadzone) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

// read(pads, now) → { actions, scroll }: actions are button names on the press
// (not while held) and directions on the press, then after `delay` ms every
// `rate` ms; scroll is the right stick's up/down, -1..1, 0 in the deadzone.
function createPadReader({ deadzone = 0.35, delay = 400, rate = 120 } = {}) {
  let before = new Set();
  const due = {};   // held direction → when it next repeats
  return function read(pads, now) {
    const down = new Set();
    let scroll = 0;
    for (const pad of pads || []) {
      if (!pad || pad.connected === false) continue;
      const pressed = (i) => !!(pad.buttons?.[i]?.pressed || pad.buttons?.[i]?.value > 0.5);
      for (const [i, name] of Object.entries(BUTTONS)) if (pressed(+i)) down.add(name);
      for (const [i, name] of Object.entries(DPAD)) if (pressed(+i)) down.add(name);
      const dir = stickDir(pad.axes?.[0], pad.axes?.[1], deadzone);
      if (dir) down.add(dir);
      const ry = pad.axes?.[3] || 0;
      if (Math.abs(ry) >= deadzone && Math.abs(ry) > Math.abs(scroll)) scroll = ry;
    }
    const actions = [];
    for (const name of Object.values(BUTTONS)) if (down.has(name) && !before.has(name)) actions.push(name);
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (!down.has(dir)) { delete due[dir]; continue; }
      if (due[dir] === undefined) { actions.push(dir); due[dir] = now + delay; }
      else if (now >= due[dir]) { actions.push(dir); due[dir] = now + rate; }
    }
    before = down;
    return { actions, scroll };
  };
}

// The index of the rect to move to from `from` going `dir`, or -1. Rects are
// { left, top, right, bottom }. Only rects past `from` that way count; the
// nearest wins, and one in line with `from` beats one off to the side.
function nextIndex(from, rects, dir) {
  if (!from) return rects.length ? 0 : -1;
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const cx = (r) => (r.left + r.right) / 2;
  const cy = (r) => (r.top + r.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    // How far past `from` it starts, edge to edge (a little overlap is fine)
    const gap = horizontal
      ? (sign > 0 ? r.left - from.right : from.left - r.right)
      : (sign > 0 ? r.top - from.bottom : from.top - r.bottom);
    const ahead = horizontal ? (cx(r) - cx(from)) * sign : (cy(r) - cy(from)) * sign;
    if (ahead <= 1 || gap < -Math.min(8, (horizontal ? r.right - r.left : r.bottom - r.top) / 2)) return;
    // How far off to the side, 0 when the two overlap across the move
    const side = horizontal
      ? Math.max(0, Math.max(from.top, r.top) - Math.min(from.bottom, r.bottom))
      : Math.max(0, Math.max(from.left, r.left) - Math.min(from.right, r.right));
    const score = Math.max(0, gap) + side * 3 + (side ? 1000 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

if (typeof module !== 'undefined') module.exports = { createPadReader, nextIndex, stickDir, BUTTONS, DPAD };
