'use strict';
/**
 * settings.json in the data directory. A save merges, so keys the settings
 * UI doesn't manage survive it.
 */
const fs = require('fs');

function createSettings(file) {
  function load() {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* unreadable: treat as empty */ }
    return {};
  }

  function save(data) {
    const merged = { ...load(), ...data };
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    return merged;
  }

  return { file, load, save };
}

module.exports = { createSettings };
