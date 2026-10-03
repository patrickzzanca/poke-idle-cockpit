'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../shared/classifier.js');

const DEFAULT_ALERTS = { boxRatio: 0.9, ballsMin: 100, potionsMin: 20, offlineMinutes: 2 };
const MAX_ACCOUNTS = 4;

function createStore(dir) {
  const accountsFile = path.join(dir, 'accounts.json');
  const machineFile = path.join(dir, 'machine.json');
  const configFile = path.join(dir, 'config.json');
  const warnings = [];

  function readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      fs.copyFileSync(file, `${file}.bak`);
      warnings.push(`${path.basename(file)} estava corrompido; cópia salva em ${path.basename(file)}.bak.`);
      return fallback;
    }
  }

  function writeJson(file, value) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  const wishlistFile = path.join(dir, 'wishlist.json');
  let accounts = readJson(accountsFile, { accounts: [] }).accounts ?? [];
  let cmid = readJson(machineFile, {}).cmid ?? null;
  let wishlist = readJson(wishlistFile, { wishlist: [] }).wishlist ?? [];
  const raw = readJson(configFile, {});
  const config = {
    tags: { ...DEFAULT_CONFIG, ...(raw.tags || {}) },
    alerts: { ...DEFAULT_ALERTS, ...(raw.alerts || {}) }
  };

  return {
    warnings,
    config,
    list: () => accounts.map(a => ({ ...a })),
    get: id => accounts.find(a => a.id === id) ?? null,
    upsert(record) {
      const i = accounts.findIndex(a => a.id === record.id);
      if (i < 0 && accounts.length >= MAX_ACCOUNTS) throw Object.assign(new Error(`Limite de ${MAX_ACCOUNTS} contas atingido.`), { status: 400 });
      if (i < 0) accounts.push({ ...record });
      else accounts[i] = { ...accounts[i], ...record };
      writeJson(accountsFile, { accounts });
    },
    getCmid: () => cmid,
    // Só aceita o formato que o jogo gera (32 hex). Retorna true se mudou.
    setCmid(value) {
      if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value) || value === cmid) return false;
      cmid = value;
      writeJson(machineFile, { cmid });
      return true;
    },
    remove(id) {
      accounts = accounts.filter(a => a.id !== id);
      writeJson(accountsFile, { accounts });
    },
    getWishlist: () => wishlist.map(w => ({ ...w })),
    addWishlistRule(rule) {
      const id = rule.id || `wl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const entry = { ...rule, id };
      wishlist.push(entry);
      writeJson(wishlistFile, { wishlist });
      return entry;
    },
    removeWishlistRule(id) {
      wishlist = wishlist.filter(w => w.id !== id);
      writeJson(wishlistFile, { wishlist });
    }
  };
}

module.exports = { createStore, MAX_ACCOUNTS };
