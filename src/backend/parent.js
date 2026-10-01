'use strict';
/**
 * The link to the desktop app when the backend runs as its utility process
 * (src/electron/main.js). Messages over process.parentPort:
 *
 *   backend → app  { type: 'listening', port, token, url }
 *                  { type: 'host', id, method, args }        an OS action
 *   app → backend  { type: 'host-result', id, ok, value | error: { message, code } }
 *                  { type: 'updater', status }               for GET /os/updater and SSE
 *                  { type: 'shutdown' }
 *
 * `host` has the OS actions only the app can do; each returns a promise of
 * the app's answer and rejects with the app's error (and its code).
 */

// The host methods the desktop app answers; the rest keep the backend's defaults
const HOST_METHODS = ['openPath', 'trashItem', 'openExternal', 'chooseFolder', 'window', 'addToSteam', 'updaterInstall', 'relaunch'];

function connectParent(port) {
  let nextId = 1;
  const pending = new Map();
  const handlers = {};

  port.on('message', (e) => {
    // Electron's parentPort delivers { data }; a plain emitter may pass the message itself
    const msg = e && 'data' in e ? e.data : e;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'host-result') {
      const call = pending.get(msg.id);
      if (!call) return;
      pending.delete(msg.id);
      if (msg.ok) return call.resolve(msg.value);
      const err = new Error(msg.error?.message || 'The desktop app could not do that');
      if (msg.error?.code) err.code = msg.error.code;
      return call.reject(err);
    }
    for (const fn of handlers[msg.type] || []) fn(msg);
  });

  const send = (msg) => port.postMessage(msg);
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ type: 'host', id, method, args });
  });
  const host = Object.fromEntries(HOST_METHODS.map(m => [m, (...args) => call(m, args)]));
  const on = (type, fn) => { (handlers[type] ||= []).push(fn); };

  return { host, send, on };
}

module.exports = { connectParent, HOST_METHODS };
