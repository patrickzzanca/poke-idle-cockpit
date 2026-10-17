'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_COCKPIT_URL = process.env.PIW_COCKPIT_URL || 'http://192.168.100.103:8787';

function safeParseTokens(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && raw.accessToken && raw.refreshToken) {
    return { accessToken: String(raw.accessToken), refreshToken: String(raw.refreshToken) };
  }
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
    }
  } catch {
    // ignore invalid json
  }
  return null;
}

function createHubSync({
  cockpitUrl = DEFAULT_COCKPIT_URL,
  timeoutMs = 2500,
  getToken = () => null,
  setToken = () => {},
  onAccountsSynced = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const baseUrl = String(cockpitUrl).replace(/\/+$/, '');
  const slotToAccount = new Map();

  async function request(reqPath, { method = 'GET', body } = {}) {
    const headers = { 'X-PIW-Bridge': '1' };
    const opts = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${baseUrl}${reqPath}`, opts);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function syncFromCockpit() {
    try {
      const data = await request('/api/bridge/accounts');
      const list = Array.isArray(data?.accounts) ? data.accounts.slice(0, 4) : [];
      let count = 0;
      const syncedAccounts = [];

      for (let i = 0; i < list.length; i++) {
        const slot = i + 1;
        const acc = list[i];
        const tokens = safeParseTokens(acc?.tokens);
        if (!tokens) continue;

        setToken(slot, JSON.stringify(tokens));
        slotToAccount.set(slot, { id: acc.id, name: acc.name, tokens });
        syncedAccounts.push({ slot, id: acc.id, name: acc.name });
        count++;

        await request('/api/bridge/heartbeat', {
          method: 'POST',
          body: { accountId: acc.id, tokens }
        });
      }

      if (typeof onAccountsSynced === 'function' && syncedAccounts.length > 0) {
        try {
          onAccountsSynced(syncedAccounts);
        } catch {}
      }

      return { ok: true, count };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function onSlotTokenChanged(slot, tokenStr) {
    const tokens = safeParseTokens(tokenStr);
    if (!tokens) return { ok: false, error: 'invalid tokens' };

    const meta = slotToAccount.get(slot);
    if (meta) {
      meta.tokens = tokens;
    }

    try {
      const body = meta?.id ? { accountId: meta.id, tokens } : { tokens };
      const res = await request('/api/bridge/heartbeat', { method: 'POST', body });
      if (res?.accountId && !meta?.id) {
        slotToAccount.set(slot, { id: res.accountId, name: null, tokens });
      }
      return { ok: true, accountId: res?.accountId ?? meta?.id ?? null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function heartbeatAll() {
    let okCount = 0;
    for (const slot of [1, 2, 3, 4]) {
      const currentRaw = getToken(slot);
      const tokens = safeParseTokens(currentRaw) || slotToAccount.get(slot)?.tokens;
      const meta = slotToAccount.get(slot);
      if (!tokens && !meta?.id) continue;
      try {
        await request('/api/bridge/heartbeat', {
          method: 'POST',
          body: { accountId: meta?.id, tokens }
        });
        okCount++;
      } catch {
        // ignore offline errors during background heartbeat
      }
    }
    return { ok: true, count: okCount };
  }

  async function releaseAll() {
    let released = 0;
    for (const [, meta] of slotToAccount.entries()) {
      if (!meta?.id) continue;
      try {
        await request('/api/bridge/release', {
          method: 'POST',
          body: { accountId: meta.id }
        });
        released++;
      } catch {
        // ignore offline errors on quit
      }
    }
    return { ok: true, count: released };
  }

  return {
    syncFromCockpit,
    onSlotTokenChanged,
    heartbeatAll,
    releaseAll,
    slotToAccount
  };
}

let preReadyRunner = null;
let origWhenReady = null;

function preInit() {
  try {
    const electron = require('electron');
    if (!electron?.app) return;
    // Permite execucao a partir de unidades de rede (SMB/UNC como Z:\) sem crash do GPU/Renderer sandbox (error_code=18)
    electron.app.commandLine.appendSwitch('no-sandbox');
    electron.app.commandLine.appendSwitch('disable-gpu-sandbox');

    if (!origWhenReady && typeof electron.app.whenReady === 'function') {
      origWhenReady = electron.app.whenReady.bind(electron.app);
      let wrappedPromise = null;
      electron.app.whenReady = function () {
        if (!wrappedPromise) {
          wrappedPromise = origWhenReady().then(async () => {
            if (typeof preReadyRunner === 'function') {
              try {
                await preReadyRunner();
              } catch {}
            }
          });
        }
        return wrappedPromise;
      };
    }
  } catch {}
}

function updateHubAjustesFile(electron, syncedAccounts, resetSettingsCache) {
  try {
    const userData = electron.app.getPath('userData');
    const ajustesPath = path.join(userData, 'ajustes.json');
    let data = {};
    if (fs.existsSync(ajustesPath)) {
      data = JSON.parse(fs.readFileSync(ajustesPath, 'utf8'));
    }
    if (!data.contas || typeof data.contas !== 'object') {
      data.contas = {};
    }
    for (const item of syncedAccounts) {
      const key = String(item.slot);
      const prev = data.contas[key] || {};
      data.contas[key] = {
        ...prev,
        ligada: true,
        nome: item.name || prev.nome || null
      };
    }
    fs.writeFileSync(ajustesPath, JSON.stringify(data, null, 2), 'utf8');
    if (typeof resetSettingsCache === 'function') {
      resetSettingsCache();
    }
  } catch {}
}

function bootstrapElectronHub({
  electron,
  getToken,
  setToken,
  resolveSlot,
  resetSettingsCache,
  cockpitUrl = DEFAULT_COCKPIT_URL
} = {}) {
  if (!electron?.app || !electron?.ipcMain) return null;

  const hubSync = createHubSync({
    cockpitUrl,
    getToken,
    setToken,
    onAccountsSynced: syncedAccounts => updateHubAjustesFile(electron, syncedAccounts, resetSettingsCache)
  });

  const startSyncAndHeartbeat = async () => {
    await hubSync.syncFromCockpit().catch(() => {});
    const timer = setInterval(() => {
      hubSync.heartbeatAll().catch(() => {});
    }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
  };

  if (origWhenReady) {
    preReadyRunner = startSyncAndHeartbeat;
  } else {
    electron.app.whenReady().then(startSyncAndHeartbeat);
  }

  electron.ipcMain.on('jogo:tokens-mudou', (event, rawTokens) => {
    try {
      const slot = typeof resolveSlot === 'function' ? resolveSlot(event) : null;
      if (slot) {
        hubSync.onSlotTokenChanged(slot, rawTokens).catch(() => {});
      }
    } catch {
      // ignore
    }
  });

  electron.app.on('before-quit', () => {
    hubSync.releaseAll().catch(() => {});
  });

  return hubSync;
}

module.exports = {
  createHubSync,
  bootstrapElectronHub,
  preInit,
  DEFAULT_COCKPIT_URL
};
