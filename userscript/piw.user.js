// ==UserScript==
// @name         PIW Cockpit — ponte e tags
// @namespace    pk-ext
// @version      1.2.0
// @description  Liga as abas do Poke Idle World ao cockpit local (localhost:8787) e mostra as tags unificadas nos cards.
// @match        https://poke.idleworld.online/*
// @updateURL    https://raw.githubusercontent.com/patrickzzanca/poke-idle-cockpit/main/userscript/piw.user.js
// @downloadURL  https://raw.githubusercontent.com/patrickzzanca/poke-idle-cockpit/main/userscript/piw.user.js
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @require      https://raw.githubusercontent.com/patrickzzanca/poke-idle-cockpit/main/shared/species.js
// @require      https://raw.githubusercontent.com/patrickzzanca/poke-idle-cockpit/main/shared/classifier.js
// ==/UserScript==

(() => {
  'use strict';

  let COCKPIT = localStorage.getItem('piw:cockpit_url') || 'http://localhost:8787';
  const page = unsafeWindow;
  const store = page.sessionStorage;
  const TOKENS_KEY = 'pokeweb:tokens';
  const ACCOUNT_KEY = 'piw:accountId';
  let machineId = null;
  let currentHunt = null;
  const { TAGS, classifyCollection, makeMarketClassifier, normalizePoke, primaryTag } = PIWClassifier;

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
          if (res.status >= 200 && res.status < 300) resolve(data);
          else reject(Object.assign(new Error(data.error || `Cockpit respondeu HTTP ${res.status}`), { status: res.status }));
        },
        onerror: () => reject(new Error('O cockpit não está rodando (localhost:8787).')),
        ontimeout: () => reject(new Error('O cockpit não respondeu.'))
      });
    });
  }

  function readTokens() {
    try {
      const tokens = JSON.parse(store.getItem(TOKENS_KEY) || 'null');
      return tokens?.accessToken && tokens?.refreshToken ? tokens : null;
    } catch { return null; }
  }

  // "Abrir sessão": o cockpit abre /pokepedia#piw=<código>; aqui trocamos o código pelos tokens.
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

  let lastHeartbeatSent = 0;
  function heartbeat(force = false) {
    const accountId = store.getItem(ACCOUNT_KEY);
    const tokens = readTokens();
    if (!accountId || !tokens) return;
    const now = Date.now();
    if (!force && now - lastHeartbeatSent < 1000) return;
    lastHeartbeatSent = now;
    cockpit('POST', '/api/bridge/heartbeat', { accountId, tokens, cmid: machineId, lastHunt: currentHunt }).catch(error => {
      if (error.status === 404) { store.removeItem(ACCOUNT_KEY); renderBridgeButton(); }
    });
  }
  setInterval(() => heartbeat(false), 30000);
  setTimeout(() => heartbeat(true), 3000);
  page.addEventListener('pagehide', () => {
    const accountId = store.getItem(ACCOUNT_KEY);
    if (accountId && location.pathname.startsWith('/play')) cockpit('POST', '/api/bridge/release', { accountId, lastHunt: currentHunt }).catch(() => {});
  });

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
          const newUrl = prompt('URL do Cockpit (ex: http://192.168.1.100:8787 ou http://localhost:8787):', COCKPIT);
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
        } catch (error) {
          alert(`PIW Cockpit: ${error.message}\n(Dica: Shift+Clique ou Alt+Clique neste botão para definir o IP/URL do Cockpit)`);
        } finally {
          button.disabled = false;
        }
      });
    }
    const text = linked ? '🔗 Cockpit' : '🔗 Enviar para o cockpit';
    if (button.textContent !== text) {
      button.textContent = text;
      button.title = linked ? 'Conta ligada ao cockpit. Clique para abrir o painel.' : 'Cadastra esta conta no cockpit local.';
    }
  }

  // ---------------- Tags nos cards ----------------

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
  }).catch(() => { /* sem espécies: tags que dependem da linha evolutiva ficam de fora */ });

  function rebuild() {
    const familyOf = species ? species.familyOf : undefined;
    owned = classifyCollection(ownedRaw, { familyOf });
    marketClassifier = makeMarketClassifier(ownedRaw, { familyOf });
    queueScan();
  }

  const NativeWebSocket = page.WebSocket;
  function TrackedWebSocket(...args) {
    // O jogo põe a impressão desta máquina na URL do socket; repassamos o mesmo valor ao cockpit.
    try {
      const cmid = new URL(String(args[0]), location.href).searchParams.get('cmid');
      if (cmid) machineId = cmid;
    } catch { /* URL inesperada */ }
    const socket = new NativeWebSocket(...args);
    const originalSend = socket.send;
    socket.send = function(data) {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg?.type === 'enter-hunt' && msg.slug) {
            currentHunt = String(msg.slug);
            heartbeat(true);
          }
        } catch { /* parse error */ }
      }
      return originalSend.apply(this, arguments);
    };
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if ((msg?.type === 'field-init' || msg?.type === 'hunt-resume') && msg.slug) {
            currentHunt = String(msg.slug);
            heartbeat(true);
          }
        } catch { /* parse error */ }
      }
      if (typeof event.data !== 'string' || !event.data.includes('"poke')) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type === 'pokes' && Array.isArray(message.list)) {
        ownedRaw = message.list;
        rebuild();
      } else if (message?.type === 'poke-delta' && message.poke?.id != null) {
        const i = ownedRaw.findIndex(p => p?.id === message.poke.id);
        ownedRaw = i >= 0 ? ownedRaw.map((p, j) => j === i ? message.poke : p) : [...ownedRaw, message.poke];
        rebuild();
      }
    });
    return socket;
  }
  TrackedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
  page.WebSocket = TrackedWebSocket;

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

  // Só marca o card quando há exatamente um Pokémon da coleção com esses dados.
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
    renderBridgeButton();
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const raw = readCard(card);
      if (raw) showTags(card, raw, assess(raw));
    }
  }

  function queueScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 150);
  }

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .piw-tags { display: inline-flex; flex-wrap: wrap; gap: 3px; margin-left: 4px; vertical-align: middle; }
      .piw-tag { display: inline-block; color: var(--piw-tag); border: 1px solid color-mix(in srgb, var(--piw-tag) 45%, transparent); background: color-mix(in srgb, var(--piw-tag) 12%, transparent); border-radius: 4px; padding: 0 3px; font: 700 9px/1.3 system-ui, sans-serif; white-space: nowrap; }
      .inv-grid .inv-slot.inv-poke { position: relative; }
      .inv-grid .inv-slot .piw-tags { position: absolute; left: 0; bottom: 0; z-index: 2; margin: 0; background: rgba(8,15,25,.8); border-radius: 3px; }
      .inv-grid .inv-slot .piw-tag { border: 0; background: none; padding: 0 1px; }
      #piw-bridge { position: fixed; right: 14px; bottom: 92px; z-index: 2147483000; padding: 7px 10px; border: 1px solid #547487; border-radius: 8px; background: #142231; color: #d6eaf6; font: 700 11px system-ui, sans-serif; cursor: pointer; box-shadow: 0 5px 16px #0008; }
    `;
    (document.head || document.documentElement).append(style);
  }

  function start() {
    installStyle();
    new MutationObserver(records => {
      if (records.some(r => {
        const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return !target?.closest?.('.piw-tags');
      })) queueScan();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    queueScan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
