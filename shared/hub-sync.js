'use strict';

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
  fetchImpl = globalThis.fetch
} = {}) {
  const baseUrl = String(cockpitUrl).replace(/\/+$/, '');
  const slotToAccount = new Map();

  async function request(path, { method = 'GET', body } = {}) {
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
    const res = await fetchImpl(`${baseUrl}${path}`, opts);
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

      for (let i = 0; i < list.length; i++) {
        const slot = i + 1;
        const acc = list[i];
        const tokens = safeParseTokens(acc?.tokens);
        if (!tokens) continue;

        setToken(slot, JSON.stringify(tokens));
        slotToAccount.set(slot, { id: acc.id, name: acc.name, tokens });
        count++;

        await request('/api/bridge/heartbeat', {
          method: 'POST',
          body: { accountId: acc.id, tokens }
        });
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

function bootstrapElectronHub({ electron, getToken, setToken, resolveSlot, cockpitUrl = DEFAULT_COCKPIT_URL } = {}) {
  if (!electron?.app || !electron?.ipcMain) return null;

  const hubSync = createHubSync({ cockpitUrl, getToken, setToken });

  electron.app.whenReady().then(() => {
    hubSync.syncFromCockpit().catch(() => {});
    const timer = setInterval(() => {
      hubSync.heartbeatAll().catch(() => {});
    }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
  });

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
  DEFAULT_COCKPIT_URL
};
