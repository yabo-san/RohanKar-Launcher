'use strict';
// The frontend talks only to the backend's HTTP API; all it needs from
// Electron is where that is. main.js passes both as process arguments.
const { contextBridge } = require('electron');

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) || null;

contextBridge.exposeInMainWorld('launcher', {
  apiBase: arg('launcher-api'),
  token:   arg('launcher-token'),
});
