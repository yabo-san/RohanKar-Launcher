'use strict';
// Gamepad navigation for the page: a Steam Deck or any standard pad moves
// focus and presses what it lands on. The input logic is ../gamepad.js; this
// file only reads the pad and acts on the page through what a keyboard or a
// mouse would do (focus, click, Escape, the context menu), so app.js needs no
// pad code of its own.
//
// A  press · B  back · X  play or install · Y  menu · LB / RB  sidebar / content
// Start  downloads · Select  What's new · right stick  scroll
(() => {
  const read = createPadReader();
  const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex], .mi';
  let polling = false;

  const visible = (el) => el.getClientRects().length > 0 && !el.closest('.hidden, [hidden], [aria-hidden="true"]');
  // Not what the keyboard's Tab skips either (a row's own buttons, the row arrows)
  const usable = (el) => visible(el) && !el.disabled && !el.matches('.skel, [tabindex="-1"]:not(.dd-opt)');

  // What the pad works in: the topmost thing open, else the whole window
  function layer() {
    return document.getElementById('modal')
      || document.querySelector('#ddmenu:not(.hidden)')
      || document.querySelector('#ctxmenu:not(.hidden)')
      || document.querySelector('#pop:not(.hidden)')
      || document.getElementById('app');
  }
  const targets = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(usable);
  const current = (root) => (root.contains(document.activeElement) && usable(document.activeElement) ? document.activeElement : null);

  function focusOn(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // Where focus starts when it is nowhere useful: the open thing's first
  // control, or the first thing in the page, or the sidebar's current view
  function start(root) {
    if (root.id !== 'app') return targets(root)[0];
    return targets(document.getElementById('body'))[0] || document.querySelector('#sidebar .navitem.active');
  }
  const key = (name) => (document.activeElement || document.body)
    .dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

  function move(dir) {
    const root = layer();
    // Menus and dropdowns already walk with the arrow keys
    if (root.id === 'ctxmenu' || root.id === 'ddmenu') {
      return key({ up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[dir]);
    }
    const from = current(root);
    if (!from) return focusOn(start(root));
    const list = targets(root).filter(el => el !== from && !from.contains(el) && !el.contains(from));
    const i = nextIndex(from.getBoundingClientRect(), list.map(el => el.getBoundingClientRect()), dir);
    if (i >= 0) focusOn(list[i]);
  }

  function press() {
    const el = current(layer());
    if (!el) return focusOn(start(layer()));
    if (el.matches('input[type=text], input[type=search], input:not([type]), textarea')) {
      el.focus();
      // In Steam's Game Mode nothing else brings up the on-screen keyboard
      return api.showKeyboard?.();
    }
    el.click();
  }

  function back() {
    const root = layer();
    const navBack = document.getElementById('nav-back');
    if (root.id === 'app' && navBack && !navBack.disabled) return navBack.click();
    key('Escape');
  }

  // Play or install: the page's main button, or the focused row's own
  function mainAction() {
    const el = document.activeElement;
    const rowGo = el?.closest?.('.lv-row')?.querySelector('.lv-go');
    if (rowGo) return rowGo.click();
    const primary = document.querySelector('#body .album-pill.primary:not([disabled])');
    if (primary && layer().id === 'app') return primary.click();
    press();
  }

  function menu() {
    const el = current(layer());
    const detailMenu = document.querySelector('#body [data-detail-menu]');
    if (!el?.closest('[data-open]') && detailMenu) return detailMenu.click();
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }

  function openPop(button) {
    document.getElementById(button)?.click();
    const pop = document.querySelector('#pop:not(.hidden)');
    if (pop) focusOn(targets(pop)[0]);
  }

  const ACTIONS = {
    up: () => move('up'), down: () => move('down'), left: () => move('left'), right: () => move('right'),
    a: press, b: back, x: mainAction, y: menu,
    lb: () => focusOn(document.querySelector('#sidebar .navitem.active') || targets(document.getElementById('sidebar'))[0]),
    rb: () => focusOn(targets(document.getElementById('body'))[0]),
    start: () => openPop('btn-downloads'),
    select: () => openPop('btn-news'),
  };

  // The hint bar, shown while the pad is in use
  function padMode(on) {
    document.documentElement.classList.toggle('pad', on);
    let bar = document.getElementById('padhints');
    if (on && !bar) {
      bar = document.createElement('div');
      bar.id = 'padhints';
      bar.className = 'padhints';
      bar.setAttribute('aria-hidden', 'true');
      bar.innerHTML = [['A', 'Select'], ['B', 'Back'], ['X', 'Play'], ['Y', 'Menu'], ['LB RB', 'Sidebar, content'], ['Start', 'Downloads'], ['Select', "What's new"]]
        .map(([b, label]) => `<span><kbd>${b}</kbd>${label}</span>`).join('');
      document.body.append(bar);
    }
    if (bar) bar.hidden = !on;
  }
  // A real mouse takes over again
  addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) padMode(false); }, { passive: true });

  function scroller() {
    const root = layer();
    return root.id === 'app' ? document.getElementById('body') : root;
  }

  function tick(now) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    if (!pads.some(Boolean)) { polling = false; return; }
    const { actions, scroll } = read(pads, now);
    if (actions.length || scroll) padMode(true);
    for (const a of actions) ACTIONS[a]?.();
    if (scroll) scroller()?.scrollBy(0, scroll * 18);
    requestAnimationFrame(tick);
  }
  function poll() {
    if (polling) return;
    polling = true;
    requestAnimationFrame(tick);
  }
  addEventListener('gamepadconnected', poll);
  if (navigator.getGamepads && [...navigator.getGamepads()].some(Boolean)) poll();
})();
