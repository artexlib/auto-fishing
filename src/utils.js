'use strict';

const fs = require('fs');
const path = require('path');

function rng([min, max]) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':');
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sumStats(map) {
  return Object.entries(map)
    .map(([tier, count]) => `Tier ${tier}: ${count}`)
    .join(', ');
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  rng,
  formatDuration,
  ensureDirectory,
  sumStats,
  deepClone,
  resolveDataFile(characterName, serverId, baseDir = __dirname) {
    const safeName = characterName.replace(/[^\w\-]/g, '_');
    return path.join(baseDir, 'saves', `${safeName}-${serverId}.json`);
  }
};
