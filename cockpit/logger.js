'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'events.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_BACKUPS = 2;

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_BYTES) return;

    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      const dest = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dest); } catch {}
      }
    }
    try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
  } catch {}
}

function formatLine(level, tag, message, meta) {
  const now = new Date();
  const d = now.toISOString().replace('T', ' ').replace('Z', '');
  const metaStr = meta ? (typeof meta === 'object' ? ` ${JSON.stringify(meta)}` : ` ${meta}`) : '';
  return `[${d}] [${level.toUpperCase().padEnd(5)}] [${tag}] ${message}${metaStr}\n`;
}

function write(level, tag, message, meta) {
  try {
    ensureDir();
    rotateIfNeeded();
    const line = formatLine(level, tag, message, meta);
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // Logging não deve interromper execução do app
  }
}

const logger = {
  info: (tag, msg, meta) => write('info', tag, msg, meta),
  warn: (tag, msg, meta) => write('warn', tag, msg, meta),
  error: (tag, msg, meta) => write('error', tag, msg, meta),
  debug: (tag, msg, meta) => write('debug', tag, msg, meta),

  getRecentLogs(lines = 100) {
    try {
      if (!fs.existsSync(LOG_FILE)) return [];
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const all = content.trim().split('\n');
      return all.slice(-lines);
    } catch {
      return [];
    }
  }
};

module.exports = logger;
