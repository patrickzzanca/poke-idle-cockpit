'use strict';

const DEFAULT_COCKPIT_URL = (typeof process !== 'undefined' && process.env?.PIW_COCKPIT_URL) || 'http://192.168.100.103:8787';

const TAGS = Object.freeze({
  raro: { label: '💎 Raro', short: '💎', color: '#f0b71e' },
  top: { label: '⭐ Top', short: '⭐', color: '#f6d66d' },
  matriz: { label: '🧬 Matriz', short: '🧬', color: '#d8a9ff' },
  upar: { label: '⬆ Upar', short: '⬆', color: '#75dca8' },
  lixo: { label: '🗑 Lixo', short: '🗑', color: '#9aa6b3' }
});
const TAG_ORDER = ['raro', 'top', 'matriz', 'upar', 'lixo'];

const DEFAULT_CLASSIFIER_CONFIG = Object.freeze({
  raroQuality: 1.7,
  topIv: 170,
  matrizIv: 165,
  uparIv: 145,
  uparQuality: 1.5,
  lixoIv: 130,
  lixoQuality: 1.5
});

function fold(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function cleanName(value) {
  return fold(value)
    .replace(/^✨\s*/, '')
    .replace(/^shiny\s+/, '')
    .replace(/\s+(?:lv\.?|nv\.?)\s*\d+.*$/i, '')
    .replace(/\s+⚔\s*$/, '')
    .trim();
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

const readIv = text => toNumber(String(text).match(/\bIV\s*[:\s]*([0-9]{1,3})(?:\s*\/\s*192)?\b/i)?.[1]);
const readQuality = text => toNumber(String(text).match(/(?:[×x]|\bQ)\s*(\d+(?:[.,]\d+)?)/i)?.[1]);

function normalizePoke(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let ivTotal = toNumber(raw.ivTotal ?? raw.totalIv);
  if (ivTotal == null && raw.ivs && typeof raw.ivs === 'object') {
    const vals = Object.values(raw.ivs).map(toNumber);
    if (vals.length === 6 && vals.every(v => v != null)) {
      ivTotal = vals.reduce((a, b) => a + b, 0);
    }
  }
  const name = String(raw.name ?? '');
  return {
    id: raw.id ?? null,
    speciesId: toNumber(raw.speciesId ?? raw.pokeId ?? raw.dexId),
    name,
    level: toNumber(raw.level),
    quality: toNumber(raw.quality),
    ivTotal,
    shiny: Boolean(raw.shiny || raw.isShiny || raw.rarity === 'shiny' || /shiny|✨/i.test(name)),
    isDitto: Boolean(raw.isDitto || cleanName(name) === 'ditto'),
    team: Boolean(raw.team),
    starter: Boolean(raw.starter),
    locked: Boolean(raw.locked)
  };
}

function classifySinglePoke(poke, cfg = DEFAULT_CLASSIFIER_CONFIG) {
  const tags = [];
  const iv = poke.ivTotal;
  const q = poke.quality;

  if (poke.shiny || poke.isDitto || (q != null && q >= cfg.raroQuality)) {
    tags.push('raro');
  }
  if (iv != null && iv >= cfg.topIv) {
    tags.push('top');
  }
  if (iv != null && iv >= cfg.matrizIv) {
    tags.push('matriz');
  }
  if (iv != null && q != null && iv >= cfg.uparIv && q >= cfg.uparQuality) {
    tags.push('upar');
  }
  const isProtected = poke.team || poke.starter || poke.locked;
  if (!tags.length && !isProtected && iv != null && q != null && iv < cfg.lixoIv && q < cfg.lixoQuality) {
    tags.push('lixo');
  }
  return tags;
}

function primaryTag(tags) {
  if (!Array.isArray(tags)) return null;
  return TAG_ORDER.find(t => tags.includes(t)) ?? null;
}

function computeDexSpeciesStatus(ownedList, speciesId, speciesName) {
  const targetId = toNumber(speciesId);
  const targetName = cleanName(speciesName);
  let hasNormal = false;
  let hasShiny = false;

  for (const raw of ownedList ?? []) {
    const p = normalizePoke(raw);
    if (!p) continue;
    const matchId = targetId != null && p.speciesId != null && p.speciesId === targetId;
    const matchName = targetName && cleanName(p.name) === targetName;
    if (matchId || matchName) {
      if (p.shiny) hasShiny = true;
      else hasNormal = true;
    }
  }

  if (hasShiny) return 'shiny';
  if (hasNormal) return 'normal';
  return 'missing';
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatNum(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

function createInGameHud({
  window: win = typeof globalThis.window !== 'undefined' ? globalThis.window : null,
  document: doc = win?.document ?? (typeof globalThis.document !== 'undefined' ? globalThis.document : null),
  cockpitUrl = DEFAULT_COCKPIT_URL,
  fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : null
} = {}) {
  const baseUrl = String(cockpitUrl).replace(/\/+$/, '');
  let hudEl = null;
  let hudMinimized = false;
  let currentHunt = null;
  let currentHuntName = null;
  let latestAnalyzer = null;
  let ownedRaw = [];
  let owned = [];
  let sessionShinies = [];
  let pendingKills = [];
  let pendingCaptures = [];
  let pokesDirty = false;
  let leaderFainted = false;
  let cockpitConnected = false;
  let telemetryTimer = null;
  const sessionStartTime = Date.now();
  const activeMapShinies = new Set();

  function readTokens() {
    try {
      const raw = win?.sessionStorage?.getItem('pokeweb:tokens');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.accessToken && parsed?.refreshToken) return parsed;
    } catch {}
    return null;
  }

  function rebuildCollection() {
    owned = ownedRaw.map(raw => {
      const p = normalizePoke(raw);
      if (!p) return null;
      return { ...p, tags: classifySinglePoke(p) };
    }).filter(Boolean);
  }

  function installStyle() {
    if (!doc || doc.getElementById('piw-hud-styles')) return;
    const style = doc.createElement('style');
    style.id = 'piw-hud-styles';
    style.textContent = `
      .piw-tip-badge { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-wrap: wrap; }
      .piw-tip-pill { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; }
      .piw-tip-pill.iv { background: rgba(85,230,211,0.15); color: #55e6d3; border: 1px solid rgba(85,230,211,0.3); }
      .piw-tip-pill.q { background: rgba(241,198,68,0.15); color: #f1c644; border: 1px solid rgba(241,198,68,0.3); }
      .piw-tip-pill.tag { background: color-mix(in srgb, var(--piw-tag) 15%, transparent); color: var(--piw-tag); border: 1px solid color-mix(in srgb, var(--piw-tag) 40%, transparent); }
      .piw-dex-status-badge { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; margin-left: 4px; }
      .piw-dex-status-badge.shiny { background: rgba(250,204,21,0.2); color: #fde047; border: 1px solid #facc15; }
      .piw-dex-status-badge.normal { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.35); }
      .piw-dex-status-badge.missing { background: rgba(248,113,113,0.15); color: #f87171; border: 1px solid rgba(248,113,113,0.35); }
      .piw-hud-root { position: fixed; right: 12px; bottom: 16px; z-index: 2147483640; font-family: system-ui, sans-serif; color: #e2ecfa; font-size: 11px; }
      .piw-hud-min-bar { display: flex; align-items: center; gap: 8px; background: #0f1724; border: 1px solid #233145; border-radius: 20px; padding: 4px 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.6); cursor: pointer; }
      .piw-hud-card-body { width: 260px; display: flex; flex-direction: column; gap: 6px; background: linear-gradient(170deg, #131b28 0%, #0d131d 100%); border: 1px solid #28374d; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,0.75); padding: 8px; }
      .piw-hud-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.06); }
      .piw-status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: #facc15; }
      .piw-status-dot.online { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
      .piw-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }
      .piw-stat-box { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 3px 6px; display: flex; flex-direction: column; }
    `;
    (doc.head || doc.documentElement || doc.body)?.append(style);
  }

  function renderHud() {
    if (!doc?.body) return;
    const existing = doc.getElementById('piw-hud');
    if (existing) {
      hudEl = existing;
      return;
    }

    hudEl = doc.createElement('div');
    hudEl.id = 'piw-hud';
    hudEl.className = 'piw-hud-root';
    hudEl.innerHTML = `
      <div id="piw-hud-min" class="piw-hud-min-bar" ${hudMinimized ? '' : 'style="display:none;"'}>
        <span class="piw-status-dot ${cockpitConnected ? 'online' : 'standalone'}"></span>
        <span id="piw-min-hunt">${currentHuntName || currentHunt || 'Hunt'}</span>
        <span id="piw-min-kph">⚔️ 0/h</span>
        <span id="piw-min-shinies">✨ ${sessionShinies.length}</span>
        <button type="button" id="piw-hud-expand-btn" class="piw-hud-icon-btn">⯆</button>
      </div>
      <div id="piw-hud-card" class="piw-hud-card-body" ${hudMinimized ? 'style="display:none;"' : ''}>
        <div class="piw-hud-header" id="piw-hud-drag">
          <div class="piw-hud-title-area">
            <span class="piw-status-dot ${cockpitConnected ? 'online' : 'standalone'}"></span>
            <strong>Cockpit HUD</strong>
          </div>
          <div class="piw-hud-controls">
            <button type="button" id="piw-hud-collapse-btn" class="piw-hud-icon-btn">−</button>
          </div>
        </div>
        <div class="piw-hud-section">
          <div class="piw-hunt-name-row">
            <span class="piw-label">HUNT ATIVA</span>
            <strong id="piw-hud-hunt-name">${currentHuntName || currentHunt || 'Nenhuma hunt'}</strong>
          </div>
          <div class="piw-stats-grid">
            <div class="piw-stat-box">
              <span class="piw-stat-sub">⏱️ Duração</span>
              <strong id="piw-hud-duration">00:00</strong>
            </div>
            <div class="piw-stat-box">
              <span class="piw-stat-sub">⚔️ Kills</span>
              <strong id="piw-hud-kills">0</strong>
              <small id="piw-hud-kph">0/h</small>
            </div>
            <div class="piw-stat-box">
              <span class="piw-stat-sub">🔴 Capturas</span>
              <strong id="piw-hud-captures">0</strong>
              <small id="piw-hud-cph">0/h</small>
            </div>
            <div class="piw-stat-box">
              <span class="piw-stat-sub">✨ XP/h</span>
              <strong id="piw-hud-xph">0/h</strong>
            </div>
          </div>
        </div>
        <div class="piw-hud-section">
          <div class="piw-section-header">
            <span>✨ SHINIES (<b id="piw-hud-shiny-count">${sessionShinies.length}</b>)</span>
          </div>
          <div id="piw-hud-shiny-list" class="piw-shiny-list"></div>
        </div>
        <div class="piw-hud-footer">
          <span id="piw-bridge-status">${cockpitConnected ? '🟢 Sincronizado ao Cockpit' : '🟡 Modo Local'}</span>
        </div>
      </div>
    `;

    doc.body.appendChild(hudEl);
    const expandBtn = doc.getElementById('piw-hud-expand-btn');
    const collapseBtn = doc.getElementById('piw-hud-collapse-btn');
    expandBtn?.addEventListener('click', () => {
      hudMinimized = false;
      const minBar = doc.getElementById('piw-hud-min');
      const card = doc.getElementById('piw-hud-card');
      if (minBar) minBar.style.display = 'none';
      if (card) card.style.display = 'flex';
    });
    collapseBtn?.addEventListener('click', () => {
      hudMinimized = true;
      const minBar = doc.getElementById('piw-hud-min');
      const card = doc.getElementById('piw-hud-card');
      if (minBar) minBar.style.display = 'flex';
      if (card) card.style.display = 'none';
    });

    updateHud();
  }

  function updateHud() {
    if (!doc || !hudEl) return;
    const huntDisplay = currentHuntName || currentHunt || 'Nenhuma hunt';
    const huntEl = doc.getElementById('piw-hud-hunt-name');
    const minHuntEl = doc.getElementById('piw-min-hunt');
    if (huntEl) huntEl.textContent = huntDisplay;
    if (minHuntEl) minHuntEl.textContent = huntDisplay;

    const z = latestAnalyzer;
    const kills = z?.kills ?? 0;
    const kph = z?.killsPerHour ?? 0;
    const captures = z?.captures ?? 0;
    const cph = z?.seconds > 60 && captures > 0 ? Math.round((captures / z.seconds) * 3600) : 0;
    const xph = z?.xpPerHour ? `${formatNum(z.xpPerHour)}/h` : '0/h';
    const durSec = z?.seconds || Math.floor((Date.now() - sessionStartTime) / 1000);

    const durEl = doc.getElementById('piw-hud-duration');
    const killsEl = doc.getElementById('piw-hud-kills');
    const kphEl = doc.getElementById('piw-hud-kph');
    const capEl = doc.getElementById('piw-hud-captures');
    const cphEl = doc.getElementById('piw-hud-cph');
    const xphEl = doc.getElementById('piw-hud-xph');
    const minKphEl = doc.getElementById('piw-min-kph');

    if (durEl) durEl.textContent = formatDuration(durSec);
    if (killsEl) killsEl.textContent = formatNum(kills);
    if (kphEl) kphEl.textContent = `${formatNum(kph)}/h`;
    if (capEl) capEl.textContent = formatNum(captures);
    if (cphEl) cphEl.textContent = `${formatNum(cph)}/h`;
    if (xphEl) xphEl.textContent = xph;
    if (minKphEl) minKphEl.textContent = `⚔️ ${formatNum(kph)}/h`;

    const shinyCountEl = doc.getElementById('piw-hud-shiny-count');
    const minShinyEl = doc.getElementById('piw-min-shinies');
    if (shinyCountEl) shinyCountEl.textContent = String(sessionShinies.length);
    if (minShinyEl) minShinyEl.textContent = `✨ ${sessionShinies.length}`;
  }

  function recordShiny({ speciesId, name, slot, type = 'spawn' }) {
    const now = Date.now();
    const dup = sessionShinies.find(
      s => s.speciesId === speciesId && s.type === type && now - s.timestamp < 30_000
    );
    if (dup) return;

    const entry = {
      id: `sh_${now}`,
      speciesId: toNumber(speciesId),
      name: String(name || 'Shiny'),
      slot: slot ?? null,
      timestamp: now,
      type
    };
    sessionShinies.unshift(entry);
    if (sessionShinies.length > 50) sessionShinies = sessionShinies.slice(0, 50);
    updateHud();
  }

  function enhanceTooltip(tipEl) {
    if (!tipEl || tipEl.dataset?.piwEnhanced) return;
    if (tipEl.classList?.contains('piw-tip-badge') || tipEl.classList?.contains('piw-tip-pill')) return;
    if (tipEl.closest?.('.piw-tip-badge, .piw-tags, #piw-hud')) return;
    if (tipEl.querySelector?.('.piw-tip-badge')) return;
    const text = tipEl.textContent || '';
    if (!text.includes('HP') && !text.includes('IV') && !text.includes('Quality') && !text.includes('Qualidade')) return;

    const iv = readIv(text);
    const q = readQuality(text);
    const nameEl = tipEl.querySelector?.('.inv-tip-name') || tipEl.firstElementChild;
    const pokeName = cleanName(nameEl?.textContent || '');

    if (iv == null && q == null && !pokeName) return;
    if (tipEl.dataset) tipEl.dataset.piwEnhanced = 'true';

    const matchCandidate = owned.find(
      p => cleanName(p.name) === pokeName && (iv == null || p.ivTotal === iv)
    );
    const computedTags = matchCandidate?.tags ?? classifySinglePoke({
      ivTotal: iv,
      quality: q,
      shiny: /shiny|✨/i.test(text),
      isDitto: pokeName === 'ditto'
    });
    const tag = primaryTag(computedTags);

    const badge = doc.createElement('div');
    badge.className = 'piw-tip-badge';
    if (badge.dataset) badge.dataset.piwEnhanced = 'true';

    const ivPercent = iv != null ? `${((iv / 192) * 100).toFixed(1)}%` : null;
    const ivHtml = iv != null ? `<span class="piw-tip-pill iv">⭐ IV ${iv}/192 <small>(${ivPercent})</small></span>` : '';
    const qHtml = q != null ? `<span class="piw-tip-pill q">Q ×${q.toFixed(2)}</span>` : '';
    const tagHtml = tag ? `<span class="piw-tip-pill tag" style="--piw-tag:${TAGS[tag].color}">${TAGS[tag].label}</span>` : '';

    badge.innerHTML = [ivHtml, qHtml, tagHtml].filter(Boolean).join(' ');
    tipEl.insertBefore(badge, tipEl.firstChild);
  }

  function decoratePokedexCard(cardEl, speciesId, speciesName) {
    if (!cardEl || !doc) return;
    const status = computeDexSpeciesStatus(ownedRaw, speciesId, speciesName);
    let badge = cardEl.querySelector?.('.piw-dex-status-badge');
    if (!badge) {
      badge = doc.createElement('span');
      cardEl.appendChild(badge);
    }
    badge.className = `piw-dex-status-badge ${status}`;
    badge.textContent = status === 'shiny' ? '✨ Shiny' : status === 'normal' ? '🟢 Possui' : '🔴 Faltando';
    return status;
  }

  async function flushTelemetry() {
    if (telemetryTimer) {
      clearTimeout(telemetryTimer);
      telemetryTimer = null;
    }
    if (!fetchImpl) return { ok: false };

    const telemetry = {
      hunt: currentHunt,
      analyzer: latestAnalyzer,
      leaderFainted,
      shinies: sessionShinies.slice(0, 10)
    };
    if (pendingKills.length > 0) {
      telemetry.kills = pendingKills.splice(0, pendingKills.length);
    }
    if (pendingCaptures.length > 0) {
      telemetry.captures = pendingCaptures.splice(0, pendingCaptures.length);
    }
    if (pokesDirty) {
      telemetry.pokes = ownedRaw;
      pokesDirty = false;
    }

    try {
      const res = await fetchImpl(`${baseUrl}/api/bridge/telemetry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PIW-Bridge': '1'
        },
        body: JSON.stringify({
          tokens: readTokens(),
          lastHunt: currentHunt,
          telemetry
        })
      });
      cockpitConnected = Boolean(res?.ok);
      const statusEl = doc?.getElementById('piw-bridge-status');
      if (statusEl) {
        statusEl.textContent = cockpitConnected ? '🟢 Sincronizado ao Cockpit' : '🟡 Modo Local';
      }
      return { ok: cockpitConnected };
    } catch {
      cockpitConnected = false;
      return { ok: false };
    }
  }

  function queueTelemetry(immediate = false) {
    if (immediate) {
      flushTelemetry().catch(() => {});
      return;
    }
    if (!telemetryTimer) {
      telemetryTimer = setTimeout(() => {
        flushTelemetry().catch(() => {});
      }, 1500);
      if (typeof telemetryTimer.unref === 'function') telemetryTimer.unref();
    }
  }

  function onSocketEvent(kind, rawData) {
    if (kind !== 'frame' || typeof rawData !== 'string') return;
    if (rawData.length === 0 || rawData.charCodeAt(0) !== 123) return;

    let message;
    try {
      message = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'hunt-state' || message.type === 'hunt-resume') {
      currentHunt = message.slug || message.huntId || currentHunt;
      if (message.name) currentHuntName = message.name;
      updateHud();
      queueTelemetry();
      return;
    }

    if (message.type === 'field-init') {
      if (message.slug || message.huntId) currentHunt = message.slug || message.huntId;
      if (message.name || message.zoneName) currentHuntName = message.name || message.zoneName;
      updateHud();
      return;
    }

    if (message.type === 'analyzer') {
      const seconds = Number(message.seconds) || 0;
      const profit = Number(message.balance ?? 0) + (Number(message.photos ?? 0) * (Number(message.photoNpcGold ?? 0) || 0));
      latestAnalyzer = {
        seconds,
        kills: message.kills ?? 0,
        killsPerHour: message.killsPerHour ?? 0,
        xpGained: message.xpGained ?? 0,
        xpPerHour: message.xpPerHour ?? 0,
        captures: message.captures ?? 0,
        shinyCaptures: message.shinyCaptures ?? 0,
        lootGold: message.lootGold ?? 0,
        supplyGold: message.supplyGold ?? 0,
        ballsUsed: message.ballsUsed ?? 0,
        potionsUsed: message.potionsUsed ?? 0,
        profit,
        profitPerHour: seconds > 0 ? Math.round((profit / seconds) * 3600) : 0
      };
      updateHud();
      queueTelemetry();
      return;
    }

    if (message.type === 'hunt-kill') {
      const isShiny = Boolean(
        message.shiny || message.isShiny || message.rarity === 'shiny' ||
        (message.speciesName && /shiny|✨/i.test(message.speciesName))
      );
      pendingKills.push({
        speciesId: message.speciesId,
        speciesName: message.speciesName,
        shiny: isShiny
      });
      if (isShiny) {
        recordShiny({
          speciesId: message.speciesId,
          name: message.speciesName,
          type: 'kill'
        });
      }
      updateHud();
      queueTelemetry(isShiny);
      return;
    }

    if (message.type === 'field' && Array.isArray(message.mobs)) {
      const currentMobKeys = new Set();
      for (const mob of message.mobs) {
        if (!mob || mob.dead || mob.respawning || (mob.hp != null && Number(mob.hp) <= 0)) continue;
        const isShiny = Boolean(mob.shiny || mob.isShiny || mob.shiny_state || mob.rarity === 'shiny');
        if (isShiny) {
          const key = `mob_${mob.slot ?? '0'}_sp_${mob.speciesId || mob.species || 'x'}`;
          currentMobKeys.add(key);
          if (!activeMapShinies.has(key)) {
            activeMapShinies.add(key);
            recordShiny({
              speciesId: mob.speciesId || mob.species,
              name: mob.name || mob.pokemonName,
              slot: mob.slot,
              type: 'spawn'
            });
          }
        }
      }
      for (const k of activeMapShinies) {
        if (!currentMobKeys.has(k)) activeMapShinies.delete(k);
      }
      return;
    }

    if (message.type === 'pokes' && Array.isArray(message.list)) {
      ownedRaw = message.list;
      pokesDirty = true;
      rebuildCollection();
      queueTelemetry();
      return;
    }

    if (message.type === 'poke-delta' && message.poke?.id != null) {
      const idx = ownedRaw.findIndex(p => p?.id === message.poke.id);
      ownedRaw = idx >= 0
        ? ownedRaw.map((p, j) => (j === idx ? message.poke : p))
        : [...ownedRaw, message.poke];
      pendingCaptures.push(message.poke);
      rebuildCollection();
      queueTelemetry(true);
      return;
    }

    if (message.type === 'team-state' && Array.isArray(message.team)) {
      const leader = message.team[0];
      leaderFainted = Boolean(leader && Number(leader.hp) <= 0);
      queueTelemetry();
    }
  }

  function mount() {
    installStyle();
    renderHud();
    if (typeof MutationObserver !== 'undefined' && doc?.body) {
      const obs = new MutationObserver(records => {
        if (!doc.getElementById('piw-hud')) renderHud();
        for (const r of records) {
          for (const n of r.addedNodes || []) {
            if (n.nodeType === 1) {
              if (n.classList?.contains('piw-tip-badge') || n.classList?.contains('piw-tip-pill')) continue;
              if (n.matches?.('.inv-tip, .poke-tip')) {
                enhanceTooltip(n);
              }
              const tips = n.querySelectorAll?.('.inv-tip, .poke-tip');
              if (tips) tips.forEach(enhanceTooltip);
            }
          }
        }
      });
      obs.observe(doc.body, { childList: true, subtree: true });
    }
  }

  return {
    mount,
    onSocketEvent,
    enhanceTooltip,
    decoratePokedexCard,
    flushTelemetry,
    updateHud
  };
}

function bootstrapPreload({
  window: win = typeof globalThis.window !== 'undefined' ? globalThis.window : null,
  cockpitUrl = DEFAULT_COCKPIT_URL,
  wrapJe
} = {}) {
  if (!win) return null;
  const hud = createInGameHud({ window: win, document: win.document, cockpitUrl });

  if (typeof wrapJe === 'function') {
    wrapJe((kind, rawData) => {
      try {
        hud.onSocketEvent(kind, rawData);
      } catch {}
    });
  }

  const start = () => {
    try {
      hud.mount();
    } catch {}
  };

  if (win.document?.readyState === 'loading') {
    win.document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  return hud;
}

module.exports = {
  createInGameHud,
  computeDexSpeciesStatus,
  bootstrapPreload,
  TAGS
};
