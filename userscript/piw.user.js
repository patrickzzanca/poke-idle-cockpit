// ==UserScript==
// @name         PIW Cockpit — Ponte, HUD & Tags
// @namespace    pk-ext
// @version      2.1.3
// @description  Liga as abas do Poke Idle World ao cockpit local, exibe HUD de hunt retrátil com radar de shiny, tags unificadas e leitor de IVs.
// @match        https://poke.idleworld.online/*
// @match        https://*.idleworld.online/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @updateURL    http://localhost:8787/piw.user.js
// @downloadURL  http://localhost:8787/piw.user.js
// @connect      localhost
// @connect      *
// @require      http://localhost:8787/shared/species.js
// @require      http://localhost:8787/shared/classifier.js
// ==/UserScript==

(() => {
  'use strict';

  let savedUrl = localStorage.getItem('piw:cockpit_url');
  if (!savedUrl || savedUrl.includes('localhost') || savedUrl.includes('127.0.0.1')) {
    savedUrl = 'http://192.168.100.103:8787';
    localStorage.setItem('piw:cockpit_url', savedUrl);
  }
  let COCKPIT = savedUrl;
  const page = unsafeWindow;
  const store = page.sessionStorage;
  const TOKENS_KEY = 'pokeweb:tokens';
  const ACCOUNT_KEY = 'piw:accountId';
  const HUD_STATE_KEY = 'piw:hud:state';
  const SHINY_SOUND_URL = 'https://www.myinstants.com/media/sounds/legends-arceus-shiny-noise.mp3';

  let machineId = null;
  let currentHunt = null;
  let currentHuntName = null;
  let lastKillAt = 0;
  let cockpitConnected = false;
  let latestAnalyzer = null;
  let sessionStartTime = Date.now();
  let sessionShinies = [];
  let recentDamageMoves = new Map();
  let soundEnabled = true;
  let lastSoundAt = 0;
  let activeMapShinies = new Set();
  let pokesChanged = false;
  let latestBalls = null;
  let latestInventory = null;

  try {
    const savedSound = localStorage.getItem('piw:sound:enabled');
    if (savedSound !== null) soundEnabled = savedSound === 'true';
    localStorage.removeItem('piw:shinies:session');
    sessionShinies = [];
  } catch {}

  const { TAGS, classifyCollection, makeMarketClassifier, normalizePoke, primaryTag } = PIWClassifier;

  // ---------------- Som de Shiny ----------------

  function playShinySound(force = false) {
    if (!soundEnabled && !force) return;
    const now = Date.now();
    if (!force && now - lastSoundAt < 3000) return;
    lastSoundAt = now;
    try {
      const audio = new Audio(SHINY_SOUND_URL);
      audio.volume = 0.85;
      audio.play().catch(() => {});
    } catch {}
  }

  // ---------------- Ponte com o cockpit ----------------

  function cockpit(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: COCKPIT + path,
        headers: { 'Content-Type': 'application/json', 'X-PIW-Bridge': '1' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 8000,
        onload: res => {
          let data = {};
          try { data = JSON.parse(res.responseText || '{}'); } catch { /* resposta vazia */ }
          if (res.status >= 200 && res.status < 300) {
            cockpitConnected = true;
            updateHudStatus();
            resolve(data);
          } else {
            cockpitConnected = false;
            updateHudStatus();
            reject(Object.assign(new Error(data.error || `Cockpit respondeu HTTP ${res.status}`), { status: res.status }));
          }
        },
        onerror: () => {
          cockpitConnected = false;
          updateHudStatus();
          reject(new Error('O cockpit não está acessível no momento.'));
        },
        ontimeout: () => {
          cockpitConnected = false;
          updateHudStatus();
          reject(new Error('Cockpit timed out.'));
        }
      });
    });
  }

  function readTokens() {
    try {
      const tokens = JSON.parse(store.getItem(TOKENS_KEY) || 'null');
      return tokens?.accessToken && tokens?.refreshToken ? tokens : null;
    } catch { return null; }
  }

  // "Abrir sessão": troca de código handoff pelos tokens.
  const handoff = location.hash.match(/[#&]piw=([a-f0-9]{32})/);
  if (handoff) {
    history.replaceState(null, '', location.pathname + location.search);
    cockpit('GET', `/api/bridge/claim/${handoff[1]}`).then(data => {
      store.setItem(TOKENS_KEY, JSON.stringify(data.tokens));
      store.setItem(ACCOUNT_KEY, data.accountId);
      location.replace('/play');
    }).catch(error => alert(`PIW Cockpit: ${error.message}`));
    return;
  }

  // ---------------- Envio de Telemetria Contínua ----------------

  let telemetryTimer = null;
  function sendTelemetry() {
    const accountId = store.getItem(ACCOUNT_KEY);
    const tokens = readTokens();
    if (!accountId || !tokens) return;

    const payload = {
      accountId,
      tokens,
      cmid: machineId,
      telemetry: {
        lastHunt: currentHunt,
        huntName: currentHuntName,
        lastKillAt: lastKillAt || (latestAnalyzer ? Date.now() : 0),
        analyzer: latestAnalyzer,
        shinies: sessionShinies.slice(0, 10),
        pokes: pokesChanged ? ownedRaw : undefined,
        balls: latestBalls,
        inventory: latestInventory
      }
    };
    pokesChanged = false;

    cockpit('POST', '/api/bridge/telemetry', payload).then(() => {
      cockpitConnected = true;
      updateHudStatus();
    }).catch(error => {
      if (error.status === 404) {
        store.removeItem(ACCOUNT_KEY);
      }
      cockpitConnected = false;
      updateHudStatus();
    });
  }

  function queueTelemetry(immediate = false) {
    if (immediate) {
      clearTimeout(telemetryTimer);
      sendTelemetry();
      return;
    }
    if (!telemetryTimer) {
      telemetryTimer = setTimeout(() => {
        telemetryTimer = null;
        sendTelemetry();
      }, 5000);
    }
  }

  function heartbeat() {
    sendTelemetry();
  }
  setInterval(heartbeat, 15000);
  setTimeout(heartbeat, 3000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendTelemetry();
    }
  });

  page.addEventListener('pagehide', () => {
    const accountId = store.getItem(ACCOUNT_KEY);
    if (accountId && location.pathname.startsWith('/play')) {
      cockpit('POST', '/api/bridge/release', { accountId, lastHunt: currentHunt }).catch(() => {});
    }
  });

  // ---------------- Tags nos cards & Coleção ----------------

  const CARD_SELECTOR = '.dpt-poke-row, .mkt2-card, .mkt2-trow, .mks-row, .inv-grid .inv-slot.inv-poke';
  const fingerprints = new WeakMap();
  let species = null;
  let ownedRaw = [];
  let owned = [];
  let marketClassifier = null;
  let scanTimer = 0;

  fetch('/game/creatures.json').then(r => r.json()).then(data => {
    species = PIWSpecies.buildSpeciesIndex(data.creatures);
    rebuild();
  }).catch(() => {});

  function rebuild() {
    const familyOf = species ? species.familyOf : undefined;
    owned = classifyCollection(ownedRaw, { familyOf });
    marketClassifier = makeMarketClassifier(ownedRaw, { familyOf });
    queueScan();
  }

  // ---------------- Interceptador de WebSocket ----------------

  function extrairShiniesDoPacote(obj, depth = 0, lista = []) {
    if (!obj || typeof obj !== 'object' || depth > 5) return lista;
    const isShiny = obj.shiny === true || obj.isShiny === true || obj.shiny_state === true || obj.rarity === 'shiny' || (obj.name && /shiny|✨/i.test(obj.name));
    const isDead = Boolean(obj.dead || obj.isDead || obj.killed || (obj.hp != null && Number(obj.hp) <= 0));
    if (isShiny && !isDead) {
      lista.push(obj);
    }
    if (Array.isArray(obj)) {
      for (const item of obj) extrairShiniesDoPacote(item, depth + 1, lista);
    } else {
      if (Array.isArray(obj.mobs)) {
        for (const item of obj.mobs) extrairShiniesDoPacote(item, depth + 1, lista);
      }
      for (const k of Object.keys(obj)) {
        if (k === 'mobs') continue;
        const val = obj[k];
        if (val && typeof val === 'object' && depth < 3) {
          extrairShiniesDoPacote(val, depth + 1, lista);
        }
      }
    }
    return lista;
  }

  function extrairDanosDoPacote(obj, depth = 0, lista = []) {
    if (!obj || typeof obj !== 'object' || depth > 5) return lista;
    const name = obj.moveName || obj.attackName || (typeof obj.move === 'string' ? obj.move : obj.move?.name);
    const dmg = Number(obj.damage ?? obj.dmg ?? obj.dano ?? obj.amount);
    if (typeof name === 'string' && name.trim() && Number.isFinite(dmg) && dmg > 0) {
      lista.push({ name: name.trim(), dmg, eff: obj.eff ? Number(obj.eff) : 1 });
    }
    if (Array.isArray(obj)) {
      for (const item of obj) extrairDanosDoPacote(item, depth + 1, lista);
    } else {
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') extrairDanosDoPacote(val, depth + 1, lista);
      }
    }
    return lista;
  }

  const NativeWebSocket = page.WebSocket;
  let gameSocket = null;

  function TrackedWebSocket(...args) {
    try {
      const cmid = new URL(String(args[0]), location.href).searchParams.get('cmid');
      if (cmid) machineId = cmid;
    } catch {}

    const socket = new NativeWebSocket(...args);
    gameSocket = socket;

    // Polling do analyzer a cada 15s pelo próprio socket do jogo
    const analyzerInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'analyzer-get' }));
      }
    }, 15000);

    socket.addEventListener('close', () => {
      clearInterval(analyzerInterval);
      if (gameSocket === socket) gameSocket = null;
    });

    const originalSend = socket.send;
    socket.send = function(data) {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg?.type === 'enter-hunt' && msg.slug) {
            currentHunt = String(msg.slug);
            queueTelemetry(true);
          }
        } catch {}
      }
      return originalSend.apply(this, arguments);
    };

    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;

      // 1. Atualizações de Hunt
      if ((message.type === 'field-init' || message.type === 'hunt-resume') && message.slug) {
        currentHunt = String(message.slug);
        if (message.name) currentHuntName = String(message.name);
        updateHud();
        queueTelemetry();
      }

      // 2. Kills e Mobs
      if (message.type === 'field-kill') {
        lastKillAt = Date.now();
        const isShinyKill = Boolean(
          message.shiny || message.isShiny || message.rarity === 'shiny' ||
          (message.speciesName && /shiny|✨/i.test(message.speciesName)) ||
          [...activeMapShinies].some(k => k.includes(`_sp_${message.speciesId}`))
        );
        if (isShinyKill) {
          for (const key of activeMapShinies) {
            if (key.includes(`_sp_${message.speciesId}`)) activeMapShinies.delete(key);
          }
          registrarShinyEncontrado({
            speciesId: message.speciesId,
            name: message.speciesName,
            type: 'kill'
          });
          playShinySound();
        }
        updateHud();
        queueTelemetry();
      }

      // 3. Spawns e Mobs (Detector de Shiny EXCLUSIVAMENTE em mobs da hunt)
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
              registrarShinyEncontrado({
                speciesId: mob.speciesId || mob.species,
                name: mob.name || mob.pokemonName,
                slot: mob.slot,
                type: 'spawn'
              });
              playShinySound();
            }
          }
        }
        for (const k of activeMapShinies) {
          if (!currentMobKeys.has(k)) activeMapShinies.delete(k);
        }
        updateHud();
      }

      // 4. Analisador da Sessão
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
          profitPerHour: seconds > 0 ? Math.round(profit / seconds * 3600) : 0
        };
        updateHud();
        queueTelemetry();
      }

      // 5. Coleção / Capturas
      if (message.type === 'pokes' && Array.isArray(message.list)) {
        ownedRaw = message.list;
        pokesChanged = true;
        rebuild();
        queueTelemetry();
      } else if (message.type === 'poke-delta' && message.poke?.id != null) {
        const i = ownedRaw.findIndex(p => p?.id === message.poke.id);
        ownedRaw = i >= 0 ? ownedRaw.map((p, j) => j === i ? message.poke : p) : [...ownedRaw, message.poke];
        pokesChanged = true;
        rebuild();
        queueTelemetry(true);
      }

      // 6. Suprimentos (Bolas e Bag)
      if (message.type === 'balls') {
        latestBalls = { catalog: message.catalog || [], counts: message.counts || {} };
      }
      if (message.type === 'inventory') {
        latestInventory = message.items || [];
      }

      // 7. Danos e Golpes
      const danos = extrairDanosDoPacote(message);
      if (danos.length > 0) {
        for (const d of danos) {
          const k = d.name.toLowerCase();
          const prev = recentDamageMoves.get(k) || { count: 0, total: 0 };
          recentDamageMoves.set(k, {
            name: d.name,
            lastDmg: d.dmg,
            count: prev.count + 1,
            total: prev.total + d.dmg,
            eff: d.eff
          });
        }
        updateDamageSection();
      }
    });

    return socket;
  }
  TrackedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
  page.WebSocket = TrackedWebSocket;

  function registrarShinyEncontrado(mob) {
    const now = Date.now();
    const d = new Date(now);
    const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const speciesId = mob.speciesId ? Number(mob.speciesId) : null;
    let name = mob.name ? String(mob.name).replace(/^✨\s*/, '').replace(/^Shiny\s*/i, '').trim() : '';

    if (!name && speciesId && species) {
      const sp = species.profile(speciesId);
      if (sp?.name) name = sp.name;
    }
    if (!name) name = speciesId ? `Pokémon #${speciesId}` : 'Shiny';

    // Evita duplicatas do mesmo tipo em janela de 30 segundos
    const entryType = mob.type || 'spawn';
    const dup = sessionShinies.find(s => (s.speciesId && s.speciesId === speciesId) && (s.type === entryType) && (now - s.timestamp < 30000));
    if (dup) return;

    const entry = {
      id: `sh_${now}_${Math.random().toString(36).slice(2, 6)}`,
      speciesId,
      name: `Shiny ${name}`,
      slot: mob.slot ?? null,
      timeStr,
      timestamp: now,
      type: mob.type || 'spawn'
    };

    sessionShinies.unshift(entry);
    if (sessionShinies.length > 50) sessionShinies = sessionShinies.slice(0, 50);

    try {
      localStorage.setItem('piw:shinies:session', JSON.stringify(sessionShinies));
    } catch {}

    showShinyBanner(entry);
    updateHud();
    queueTelemetry(true);
  }

  function fold(value) {
    return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }
  function cleanName(value) {
    return fold(value).replace(/^✨\s*/, '').replace(/^shiny\s+/, '')
      .replace(/\s+(?:lv\.?|nv\.?)\s*\d+.*$/i, '').replace(/\s+⚔\s*$/, '').trim();
  }
  function toNumber(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  }
  const readIv = text => toNumber(String(text).match(/\bIV\s*[:\s]*([0-9]{1,3})(?:\s*\/\s*192)?\b/i)?.[1]);
  const readLevel = text => toNumber(String(text).match(/\b(?:Lv\.?|Nv\.?)\s*(\d+)/i)?.[1]);
  const readQuality = text => toNumber(String(text).match(/(?:[×x]|\bQ)\s*(\d+(?:[.,]\d+)?)/i)?.[1]);

  function readCard(card) {
    let kind, nameEl, metaEl;
    if (card.matches('.dpt-poke-row')) {
      kind = 'owned'; nameEl = card.querySelector('.dpt-name'); metaEl = card.querySelector('.dpt-meta');
    } else if (card.matches('.mks-row')) {
      kind = 'owned'; nameEl = card.querySelector('.mks-name'); metaEl = card.querySelector('.mks-meta');
    } else if (card.matches('.mkt2-card, .mkt2-trow')) {
      const badge = card.querySelector('.mkt2-badge, .mkt2-card-badges');
      if (badge && !/pok[eé]mon/i.test(badge.textContent)) return null;
      kind = 'market';
      nameEl = card.querySelector('.mkt2-card-name, .mkt2-trow-name, .mkt2-name, .mkt2-title');
      metaEl = card.querySelector('.mkt2-card-meta, .mkt2-trow-meta, .mkt2-meta') || card;
    } else if (card.matches('.inv-grid .inv-slot.inv-poke')) {
      const title = card.getAttribute('title') || '';
      return { kind: 'team', name: cleanName(title.split('—')[0]), level: readLevel(card.querySelector('.inv-lv')?.textContent || ''),
        iv: null, q: null, nameEl: card, compact: true };
    } else return null;
    if (!nameEl) return null;
    const nameText = nameEl.childNodes[0]?.textContent?.trim() || nameEl.getAttribute('title') || '';
    const meta = metaEl?.textContent || '';
    return {
      kind, name: cleanName(nameText), level: readLevel(`${nameText} ${meta}`), iv: readIv(meta), q: readQuality(meta),
      shiny: /shiny|✨/i.test(nameText), nameEl, compact: false
    };
  }

  function assess(raw) {
    if (!raw?.name) return null;
    const speciesEntry = species?.byName(raw.name);
    if (raw.kind === 'market') {
      if (raw.iv == null || raw.q == null || !marketClassifier) return null;
      return marketClassifier(normalizePoke({ speciesId: speciesEntry?.pokeId, ivTotal: raw.iv, quality: raw.q, shiny: raw.shiny }));
    }
    const candidates = owned.filter(p =>
      (speciesEntry ? p.speciesId === speciesEntry.pokeId : cleanName(p.name) === raw.name) &&
      (raw.iv == null || p.ivTotal === raw.iv) &&
      (raw.level == null || p.level == null || p.level === raw.level) &&
      (raw.q == null || (p.quality != null && Math.abs(p.quality - raw.q) < 0.011)) &&
      (raw.kind !== 'team' || p.team));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function showTags(card, raw, result) {
    const tags = result?.tags ?? [];
    const fingerprint = JSON.stringify([raw.name, raw.iv, raw.level, raw.q, tags]);
    let host = raw.nameEl.querySelector(':scope > .piw-tags');
    if (fingerprints.get(card) === fingerprint && (tags.length ? host : !host)) return;
    fingerprints.set(card, fingerprint);
    if (!tags.length) { host?.remove(); return; }
    if (!host) {
      host = document.createElement('span');
      host.className = 'piw-tags';
      raw.nameEl.append(host);
    }
    const shown = raw.compact ? [primaryTag(tags)] : tags;
    host.replaceChildren(...shown.map(tag => {
      const badge = document.createElement('span');
      badge.className = 'piw-tag';
      badge.textContent = raw.compact ? TAGS[tag].short : TAGS[tag].label;
      badge.style.setProperty('--piw-tag', TAGS[tag].color);
      badge.title = (result.reasons ?? []).join(' · ');
      return badge;
    }));
  }

  function scan() {
    scanTimer = 0;
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const raw = readCard(card);
      if (raw) showTags(card, raw, assess(raw));
    }
  }

  function queueScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 150);
  }

  // ---------------- Leitor de Tooltips de Pokémon ----------------

  function enhanceTooltip(tipEl) {
    if (!tipEl || tipEl.dataset.piwEnhanced) return;
    const text = tipEl.textContent || '';
    if (!text.includes('HP') && !text.includes('IV') && !text.includes('Quality') && !text.includes('Qualidade')) return;

    const iv = readIv(text);
    const q = readQuality(text);
    const nameEl = tipEl.querySelector('.inv-tip-name, [class*="tip-name"]') || tipEl.firstElementChild;
    const pokeName = cleanName(nameEl?.textContent || '');

    if (iv == null && q == null && !pokeName) return;
    tipEl.dataset.piwEnhanced = 'true';

    const speciesEntry = species?.byName ? species.byName(pokeName) : null;
    const speciesId = speciesEntry?.pokeId;
    const isOwned = speciesId != null
      ? owned.some(p => p.speciesId === speciesId)
      : owned.some(p => cleanName(p.name) === pokeName);

    const matchCandidate = owned.find(p => (speciesId != null ? p.speciesId === speciesId : cleanName(p.name) === pokeName) && (iv == null || p.ivTotal === iv));
    const tag = matchCandidate ? primaryTag(matchCandidate.tags) : null;

    const badge = document.createElement('div');
    badge.className = 'piw-tip-badge';

    const ivPercent = iv != null ? `${((iv / 192) * 100).toFixed(1)}%` : null;
    const ivHtml = iv != null ? `<span class="piw-tip-pill iv">⭐ IV ${iv}/192 <small>(${ivPercent})</small></span>` : '';
    const qHtml = q != null ? `<span class="piw-tip-pill q">Q ×${q.toFixed(2)}</span>` : '';
    const tagHtml = tag ? `<span class="piw-tip-pill tag" style="--piw-tag:${TAGS[tag].color}">${TAGS[tag].label}</span>` : '';

    badge.innerHTML = [ivHtml, qHtml, tagHtml].filter(Boolean).join(' ');
    tipEl.insertBefore(badge, tipEl.firstChild);
  }

  function watchTooltips() {
    const observer = new MutationObserver(records => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) {
            if (n.matches?.('.inv-tip, .poke-tip, [class*="-tip"], [class*="tip-"]')) enhanceTooltip(n);
            const inside = n.querySelectorAll?.('.inv-tip, .poke-tip, [class*="-tip"], [class*="tip-"]');
            if (inside) inside.forEach(enhanceTooltip);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------- HUD In-Game (Card Retrátil Responsivo) ----------------

  let hudEl = null;
  let hudMinimized = false;

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

  function showShinyBanner(shiny) {
    let banner = document.getElementById('piw-shiny-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'piw-shiny-banner';
      document.body.appendChild(banner);
    }
    banner.innerHTML = `
      <div class="piw-shiny-content">
        <span class="piw-shiny-sparkle">✨</span>
        <div class="piw-shiny-text">
          <strong>SHINY DETECTADO NO MAPA!</strong>
          <span>${shiny.name} ${shiny.slot != null ? `(Slot ${shiny.slot})` : ''} · às ${shiny.timeStr}</span>
        </div>
        <button type="button" class="piw-shiny-dismiss" title="Fechar">✕</button>
      </div>
    `;
    banner.style.display = 'flex';
    banner.querySelector('.piw-shiny-dismiss')?.addEventListener('click', () => {
      banner.style.display = 'none';
    });
    setTimeout(() => { if (banner) banner.style.display = 'none'; }, 20000);
  }

  function renderHud() {
    if (hudEl || !document.body || !location.pathname.startsWith('/play')) return;

    hudEl = document.createElement('div');
    hudEl.id = 'piw-hud';
    hudEl.className = 'piw-hud-root';

    try {
      const saved = JSON.parse(localStorage.getItem(HUD_STATE_KEY) || '{}');
      if (saved.minimized) hudMinimized = true;
      if (saved.left != null && saved.top != null) {
        hudEl.style.left = `${saved.left}px`;
        hudEl.style.top = `${saved.top}px`;
        hudEl.style.right = 'auto';
        hudEl.style.bottom = 'auto';
      }
    } catch {}

    hudEl.innerHTML = `
      <!-- MODO MINIMIZADO (Pill compacto) -->
      <div id="piw-hud-min" class="piw-hud-min-bar" ${hudMinimized ? '' : 'style="display:none;"'}>
        <span class="piw-status-dot ${cockpitConnected ? 'online' : 'standalone'}" title="${cockpitConnected ? 'Cockpit Conectado' : 'Modo Standalone (Cockpit offline)'}"></span>
        <span class="piw-hud-min-hunt" id="piw-min-hunt">${currentHuntName || currentHunt || 'Hunt'}</span>
        <span class="piw-hud-min-kph" id="piw-min-kph">⚔️ 0/h</span>
        <span class="piw-hud-min-shinies" id="piw-min-shinies">✨ ${sessionShinies.length}</span>
        <button type="button" id="piw-hud-expand-btn" class="piw-hud-icon-btn" title="Expandir Cockpit HUD">⯆</button>
      </div>

      <!-- MODO EXPANDIDO (Card Retrátil) -->
      <div id="piw-hud-card" class="piw-hud-card-body" ${hudMinimized ? 'style="display:none;"' : ''}>
        <div class="piw-hud-header" id="piw-hud-drag">
          <div class="piw-hud-title-area">
            <span class="piw-status-dot ${cockpitConnected ? 'online' : 'standalone'}"></span>
            <strong>Cockpit HUD</strong>
          </div>
          <div class="piw-hud-controls">
            <button type="button" id="piw-hud-sound-toggle" class="piw-hud-icon-btn" title="Alerta Sonoro de Shiny">${soundEnabled ? '🔊' : '🔇'}</button>
            <button type="button" id="piw-hud-open-cockpit" class="piw-hud-icon-btn" title="Abrir painel do Cockpit">🔗</button>
            <button type="button" id="piw-hud-collapse-btn" class="piw-hud-icon-btn" title="Minimizar">−</button>
          </div>
        </div>

        <div class="piw-hud-section piw-hunt-info">
          <div class="piw-hunt-name-row">
            <span class="piw-label">HUNT ATIVA</span>
            <strong id="piw-hud-hunt-name">${currentHuntName || currentHunt || 'Nenhuma hunt'}</strong>
          </div>
          <div class="piw-stats-grid">
            <div class="piw-stat-box">
              <span class="piw-stat-sub">⏱️ Duração</span>
              <strong id="piw-hud-duration" class="mono">00:00</strong>
            </div>
            <div class="piw-stat-box">
              <span class="piw-stat-sub">⚔️ Kills</span>
              <strong id="piw-hud-kills" class="mono">0</strong>
              <small id="piw-hud-kph" class="mono text-muted">0/h</small>
            </div>
            <div class="piw-stat-box">
              <span class="piw-stat-sub">🔴 Capturas</span>
              <strong id="piw-hud-captures" class="mono">0</strong>
              <small id="piw-hud-cph" class="mono text-muted">0/h</small>
            </div>
            <div class="piw-stat-box">
              <span class="piw-stat-sub">✨ XP/h</span>
              <strong id="piw-hud-xph" class="mono">0</strong>
            </div>
          </div>
        </div>

        <div class="piw-hud-section piw-shiny-section">
          <div class="piw-section-header">
            <span>✨ SHINIES NA SESSÃO (<b id="piw-hud-shiny-count">${sessionShinies.length}</b>)</span>
            <button type="button" id="piw-test-sound" class="piw-hud-pill-btn" title="Testar Som">🔔 Som</button>
          </div>
          <div id="piw-hud-shiny-list" class="piw-shiny-list">
            ${sessionShinies.length === 0 ? '<div class="piw-empty-muted">Nenhum Shiny registrado ainda</div>' : ''}
          </div>
        </div>

        <div class="piw-hud-section piw-damage-section">
          <div class="piw-section-header">
            <span>💥 RASTREADOR DE GOLPES</span>
          </div>
          <div id="piw-hud-damage-list" class="piw-damage-list">
            <div class="piw-empty-muted">Aguardando batalha…</div>
          </div>
        </div>

        <div class="piw-hud-footer">
          <span class="piw-footer-tag mono" id="piw-bridge-status">${cockpitConnected ? '🟢 Sincronizado ao Cockpit' : '🟡 Modo Local'}</span>
          <button type="button" id="piw-btn-full-cockpit" class="piw-btn-link">Cockpit Completo ↗</button>
        </div>
      </div>
    `;

    document.body.appendChild(hudEl);
    setupHudEvents();
    updateHud();
  }

  function setupHudEvents() {
    const expandBtn = document.getElementById('piw-hud-expand-btn');
    const collapseBtn = document.getElementById('piw-hud-collapse-btn');
    const soundBtn = document.getElementById('piw-hud-sound-toggle');
    const testSoundBtn = document.getElementById('piw-test-sound');
    const openCockpitBtn = document.getElementById('piw-hud-open-cockpit');
    const fullCockpitBtn = document.getElementById('piw-btn-full-cockpit');
    const dragHandle = document.getElementById('piw-hud-drag');

    expandBtn?.addEventListener('click', () => toggleHud(false));
    collapseBtn?.addEventListener('click', () => toggleHud(true));

    soundBtn?.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem('piw:sound:enabled', String(soundEnabled));
      if (soundBtn) soundBtn.textContent = soundEnabled ? '🔊' : '🔇';
    });

    testSoundBtn?.addEventListener('click', () => playShinySound(true));

    const openCockpit = () => window.open(COCKPIT, 'piw-cockpit');
    openCockpitBtn?.addEventListener('click', openCockpit);
    fullCockpitBtn?.addEventListener('click', openCockpit);

    // Arraste do HUD
    if (dragHandle && hudEl) {
      let isDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
      dragHandle.addEventListener('mousedown', e => {
        if (e.target.closest('button')) return;
        isDragging = true;
        const rect = hudEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const left = Math.max(10, Math.min(window.innerWidth - hudEl.offsetWidth - 10, startLeft + (e.clientX - startX)));
        const top = Math.max(10, Math.min(window.innerHeight - hudEl.offsetHeight - 10, startTop + (e.clientY - startY)));
        hudEl.style.left = `${left}px`;
        hudEl.style.top = `${top}px`;
        hudEl.style.right = 'auto';
        hudEl.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          document.body.style.userSelect = '';
          const rect = hudEl.getBoundingClientRect();
          saveHudState({ left: rect.left, top: rect.top, minimized: hudMinimized });
        }
      });
    }
  }

  function toggleHud(minimized) {
    hudMinimized = minimized;
    const minBar = document.getElementById('piw-hud-min');
    const card = document.getElementById('piw-hud-card');
    if (minBar) minBar.style.display = minimized ? 'flex' : 'none';
    if (card) card.style.display = minimized ? 'none' : 'flex';
    const rect = hudEl ? hudEl.getBoundingClientRect() : { left: null, top: null };
    saveHudState({ left: rect.left, top: rect.top, minimized });
  }

  function saveHudState(st) {
    try {
      localStorage.setItem(HUD_STATE_KEY, JSON.stringify(st));
    } catch {}
  }

  function updateHudStatus() {
    const dots = document.querySelectorAll('.piw-status-dot');
    dots.forEach(d => {
      d.className = `piw-status-dot ${cockpitConnected ? 'online' : 'standalone'}`;
      d.title = cockpitConnected ? 'Cockpit Conectado' : 'Modo Standalone (Cockpit offline)';
    });
    const statusText = document.getElementById('piw-bridge-status');
    if (statusText) {
      statusText.textContent = cockpitConnected ? '🟢 Sincronizado ao Cockpit' : '🟡 Modo Local';
    }
  }

  function updateHud() {
    if (!hudEl) return;

    // Atualiza nome da Hunt
    const huntDisplay = currentHuntName || currentHunt || 'Nenhuma hunt';
    const huntEl = document.getElementById('piw-hud-hunt-name');
    const minHuntEl = document.getElementById('piw-min-hunt');
    if (huntEl) huntEl.textContent = huntDisplay;
    if (minHuntEl) minHuntEl.textContent = huntDisplay;

    // Dados do Analisador
    const z = latestAnalyzer;
    const kills = z?.kills || 0;
    const kph = z?.killsPerHour || 0;
    const captures = z?.captures || 0;
    const cph = z?.seconds > 60 && captures > 0 ? Math.round((captures / z.seconds) * 3600) : 0;
    const xph = z?.xpPerHour ? `${formatNum(z.xpPerHour)}/h` : '0/h';
    const durSec = z?.seconds || Math.floor((Date.now() - sessionStartTime) / 1000);

    const durEl = document.getElementById('piw-hud-duration');
    const killsEl = document.getElementById('piw-hud-kills');
    const kphEl = document.getElementById('piw-hud-kph');
    const capEl = document.getElementById('piw-hud-captures');
    const cphEl = document.getElementById('piw-hud-cph');
    const xphEl = document.getElementById('piw-hud-xph');
    const minKphEl = document.getElementById('piw-min-kph');

    if (durEl) durEl.textContent = formatDuration(durSec);
    if (killsEl) killsEl.textContent = formatNum(kills);
    if (kphEl) kphEl.textContent = `${formatNum(kph)}/h`;
    if (capEl) capEl.textContent = formatNum(captures);
    if (cphEl) cphEl.textContent = `${formatNum(cph)}/h`;
    if (xphEl) xphEl.textContent = xph;
    if (minKphEl) minKphEl.textContent = `⚔️ ${formatNum(kph)}/h`;

    // Shinies
    const shinyCountEl = document.getElementById('piw-hud-shiny-count');
    const minShinyEl = document.getElementById('piw-min-shinies');
    const shinyListEl = document.getElementById('piw-hud-shiny-list');

    if (shinyCountEl) shinyCountEl.textContent = String(sessionShinies.length);
    if (minShinyEl) minShinyEl.textContent = `✨ ${sessionShinies.length}`;

    if (shinyListEl && sessionShinies.length > 0) {
      shinyListEl.innerHTML = sessionShinies.slice(0, 4).map(s => `
        <div class="piw-shiny-item">
          <span class="piw-shiny-name">✨ ${s.name}</span>
          <span class="piw-shiny-time mono">${s.timeStr}</span>
        </div>
      `).join('');
    }
  }

  function updateDamageSection() {
    const listEl = document.getElementById('piw-hud-damage-list');
    if (!listEl) return;
    const moves = Array.from(recentDamageMoves.values()).slice(-3);
    if (moves.length === 0) return;

    listEl.innerHTML = moves.map(m => `
      <div class="piw-dmg-row">
        <span class="piw-move-name">${m.name}</span>
        <span class="piw-move-dmg mono">💥 ${formatNum(m.lastDmg)} ${m.eff && m.eff !== 1 ? `<small class="eff">x${m.eff}</small>` : ''}</span>
      </div>
    `).join('');
  }

  // ---------------- Estilos Visuais ----------------

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = `
      /* Tags nos cards de Pokémon */
      .piw-tags { display: inline-flex; flex-wrap: wrap; gap: 3px; margin-left: 4px; vertical-align: middle; }
      .piw-tag { display: inline-block; color: var(--piw-tag); border: 1px solid color-mix(in srgb, var(--piw-tag) 45%, transparent); background: color-mix(in srgb, var(--piw-tag) 12%, transparent); border-radius: 4px; padding: 0 3px; font: 700 9px/1.3 system-ui, sans-serif; white-space: nowrap; }
      .inv-grid .inv-slot.inv-poke { position: relative; }
      .inv-grid .inv-slot .piw-tags { position: absolute; left: 0; bottom: 0; z-index: 2; margin: 0; background: rgba(8,15,25,.8); border-radius: 3px; }
      .inv-grid .inv-slot .piw-tag { border: 0; background: none; padding: 0 1px; }

      /* Tooltip enhancer */
      .piw-tip-badge { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-wrap: wrap; }
      .piw-tip-pill { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; }
      .piw-tip-pill.iv { background: rgba(85,230,211,0.15); color: #55e6d3; border: 1px solid rgba(85,230,211,0.3); }
      .piw-tip-pill.q { background: rgba(241,198,68,0.15); color: #f1c644; border: 1px solid rgba(241,198,68,0.3); }
      .piw-tip-pill.tag { background: color-mix(in srgb, var(--piw-tag) 15%, transparent); color: var(--piw-tag); border: 1px solid color-mix(in srgb, var(--piw-tag) 40%, transparent); }

      /* HUD In-Game */
      .piw-hud-root {
        position: fixed; right: 14px; bottom: 20px; z-index: 2147483640;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        color: #e2ecfa; font-size: 11px;
      }
      .piw-hud-min-bar {
        display: flex; align-items: center; gap: 8px;
        background: #0f1724; border: 1px solid #233145; border-radius: 20px;
        padding: 5px 12px; box-shadow: 0 4px 18px rgba(0,0,0,0.6);
        cursor: pointer; user-select: none;
      }
      .piw-hud-card-body {
        width: 290px; display: flex; flex-direction: column; gap: 8px;
        background: linear-gradient(170deg, #131b28 0%, #0d131d 100%);
        border: 1px solid #28374d; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.75); padding: 10px;
        box-sizing: border-box;
      }
      .piw-hud-header {
        display: flex; align-items: center; justify-content: space-between;
        cursor: grab; user-select: none; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .piw-hud-title-area { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 12px; color: #fff; }
      .piw-status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      .piw-status-dot.online { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
      .piw-status-dot.standalone { background: #facc15; box-shadow: 0 0 6px #facc15; }
      .piw-hud-controls { display: flex; align-items: center; gap: 3px; }
      .piw-hud-icon-btn {
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
        color: #cbd5e1; border-radius: 6px; cursor: pointer; padding: 2px 6px; font-size: 11px;
      }
      .piw-hud-icon-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
      .piw-hud-section {
        background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.04);
        border-radius: 8px; padding: 7px 9px; display: flex; flex-direction: column; gap: 5px;
      }
      .piw-label { font-size: 8px; font-weight: 700; color: #64748b; letter-spacing: 0.5px; }
      .piw-hunt-name-row { display: flex; flex-direction: column; gap: 1px; }
      .piw-hunt-name-row strong { font-size: 12px; color: #f1c644; }
      .piw-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; margin-top: 3px; }
      .piw-stat-box {
        background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05);
        border-radius: 6px; padding: 4px 6px; display: flex; flex-direction: column; gap: 1px;
      }
      .piw-stat-sub { font-size: 8.5px; color: #8292a8; font-weight: 600; }
      .piw-section-header {
        display: flex; align-items: center; justify-content: space-between;
        font-size: 8.5px; font-weight: 700; color: #7a8fa8;
      }
      .piw-hud-pill-btn {
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
        color: #cbd5e1; border-radius: 4px; padding: 1px 5px; font-size: 8px; font-weight: 700; cursor: pointer;
      }
      .piw-shiny-list, .piw-damage-list { display: flex; flex-direction: column; gap: 3px; max-height: 80px; overflow-y: auto; }
      .piw-shiny-item, .piw-dmg-row {
        display: flex; align-items: center; justify-content: space-between;
        font-size: 9.5px; background: rgba(255,255,255,0.02); padding: 3px 5px; border-radius: 4px;
      }
      .piw-shiny-name { color: #facc15; font-weight: 700; }
      .piw-shiny-time { color: #64748b; font-size: 8.5px; }
      .piw-move-name { color: #cbd5e1; font-weight: 600; }
      .piw-move-dmg { color: #f1c644; font-weight: 700; }
      .piw-move-dmg small.eff { color: #4ade80; font-size: 8px; margin-left: 2px; }
      .piw-empty-muted { color: #516379; font-size: 9px; text-align: center; padding: 4px 0; font-style: italic; }
      .piw-hud-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 9.5px;
      }
      .piw-footer-tag { color: #72849b; font-size: 8.5px; }
      .piw-btn-link {
        background: transparent; border: none; color: #55e6d3; font-weight: 700;
        font-size: 9.5px; cursor: pointer; text-decoration: underline; padding: 0;
      }

      /* Banner de Alerta de Shiny na Tela */
      #piw-shiny-banner {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; display: none; align-items: center; justify-content: space-between;
        background: linear-gradient(135deg, #2b1f05 0%, #171206 100%);
        border: 2px solid #facc15; border-radius: 12px;
        box-shadow: 0 0 25px rgba(250,204,21,0.5), 0 8px 30px rgba(0,0,0,0.8);
        padding: 10px 16px; color: #fff; min-width: 320px;
        animation: piw-pulse 2s infinite ease-in-out;
      }
      .piw-shiny-content { display: flex; align-items: center; gap: 12px; width: 100%; }
      .piw-shiny-sparkle { font-size: 22px; }
      .piw-shiny-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      .piw-shiny-text strong { color: #fde047; font-size: 13px; letter-spacing: 0.5px; }
      .piw-shiny-text span { color: #e2e8f0; font-size: 11px; }
      .piw-shiny-dismiss {
        background: transparent; border: none; color: #94a3b8; font-size: 16px;
        cursor: pointer; padding: 0 4px;
      }
      @keyframes piw-pulse {
        0%, 100% { box-shadow: 0 0 20px rgba(250,204,21,0.4); }
        50% { box-shadow: 0 0 35px rgba(250,204,21,0.8); }
      }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      #piw-bridge { position: fixed; right: 14px; bottom: 92px; z-index: 2147483000; padding: 7px 10px; border: 1px solid #547487; border-radius: 8px; background: #142231; color: #d6eaf6; font: 700 11px system-ui, sans-serif; cursor: pointer; box-shadow: 0 5px 16px rgba(0,0,0,0.5); transition: all 0.2s ease; }
      #piw-bridge:hover { background: #1c3147; border-color: #79a8c4; }
      #piw-bridge.linked { border-color: #22c55e; background: #064e3b; color: #a7f3d0; }
    `;
    (document.head || document.documentElement).append(style);
  }

  function renderBridgeButton() {
    if (!document.body || !location.pathname.startsWith('/play')) return;
    let button = document.getElementById('piw-bridge');
    const linked = store.getItem(ACCOUNT_KEY);
    if (!readTokens()) { button?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.id = 'piw-bridge';
      button.type = 'button';
      document.body.append(button);
      button.addEventListener('click', async (e) => {
        if (e.shiftKey || e.altKey) {
          const newUrl = prompt('URL do Cockpit (ex: http://192.168.100.103:8787):', COCKPIT);
          if (newUrl) {
            COCKPIT = newUrl.trim().replace(/\/+$/, '');
            localStorage.setItem('piw:cockpit_url', COCKPIT);
            alert(`Cockpit configurado para: ${COCKPIT}`);
          }
          return;
        }
        if (store.getItem(ACCOUNT_KEY)) return window.open(COCKPIT, 'piw-cockpit');
        button.disabled = true;
        try {
          const result = await cockpit('POST', '/api/bridge/register', { tokens: readTokens(), cmid: machineId });
          store.setItem(ACCOUNT_KEY, result.id);
          renderBridgeButton();
          alert(`Conta cadastrada com sucesso no Cockpit (${COCKPIT})!`);
        } catch (error) {
          const newUrl = prompt(`Não foi possível conectar ao Cockpit em ${COCKPIT}.\nConfirme o endereço IP do servidor Gandalf:`, 'http://192.168.100.103:8787');
          if (newUrl) {
            COCKPIT = newUrl.trim().replace(/\/+$/, '');
            localStorage.setItem('piw:cockpit_url', COCKPIT);
            try {
              const res2 = await cockpit('POST', '/api/bridge/register', { tokens: readTokens(), cmid: machineId });
              store.setItem(ACCOUNT_KEY, res2.id);
              renderBridgeButton();
              alert(`Conectado ao Cockpit com sucesso em: ${COCKPIT}!`);
            } catch (err2) {
              alert(`Erro: ${err2.message}`);
            }
          }
        } finally {
          button.disabled = false;
        }
      });
    }
    const text = linked ? '🔗 Cockpit' : '🔗 Enviar para o cockpit';
    if (button.textContent !== text) {
      button.textContent = text;
      button.title = linked ? 'Conta ligada ao cockpit. Clique para abrir o painel.' : 'Cadastra esta conta no cockpit (Gandalf).';
      button.className = linked ? 'linked' : '';
    }
  }

  function start() {
    installStyle();
    renderHud();
    renderBridgeButton();
    watchTooltips();

    new MutationObserver(records => {
      renderHud();
      renderBridgeButton();
      if (records.some(r => {
        const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return !target?.closest?.('.piw-tags') && !target?.closest?.('#piw-hud');
      })) queueScan();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    queueScan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
