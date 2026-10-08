'use strict';

const { TAGS, TAG_ORDER, primaryTag } = window.PIWClassifier;
const TYPE_LABELS = {
  normal: 'Normal', fire: 'Fogo', water: 'Água', electric: 'Elétrico', grass: 'Planta', ice: 'Gelo',
  fighting: 'Lutador', poison: 'Veneno', ground: 'Terra', flying: 'Voador', psychic: 'Psíquico', bug: 'Inseto',
  rock: 'Pedra', ghost: 'Fantasma', dragon: 'Dragão', dark: 'Sombrio', steel: 'Aço', fairy: 'Fada'
};
const CATEGORY_LABELS = { physical: 'Físico', special: 'Especial', mixed: 'Misto' };
const STATUS = {
  online: ['Online', 'ok'], connecting: ['Conectando…', 'warn'], offline: ['Offline', 'bad'],
  handedOff: ['No navegador', 'info'], replaced: ['Aberta em outro lugar', 'warn'], error: ['Erro', 'bad']
};

const state = {
  accounts: new Map(), highlights: [], shinies: [], logs: [], warnings: [], config: null, tab: 'contas',
  collection: { accountId: '', items: [], sort: 'ivTotal', dir: -1, selected: new Set(), viewMode: 'grid' },
  sell: { accountId: '', items: [], selected: new Set() },
  market: { rawResults: [], accountId: '', lastMeta: null },
  radar: { wishlist: [], matches: [], currencyFilter: '' },
  bag: { accountId: '', items: [], selected: new Set(), categoryFilter: '', search: '', marketSummary: {}, myListings: [], activeItem: null },
  route: { accountId: '', presets: [], customPresets: [], activePresetId: null, queue: [], status: null },
  breeder: { accountId: '', data: null, currentView: 'ready', sim: { parent1Id: null, parent2Id: null, mode: 'free', doubleStones: false } },
  tickers: null,
  speciesList: []
};

const $ = sel => document.querySelector(sel);
const fmt = n => n == null ? '—' : n === Infinity ? '∞' : Number(n).toLocaleString('pt-BR');
const time = at => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function toSlug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function findSpeciesInCatalog(input) {
  if (!input || !state.speciesList?.length) return null;
  const raw = String(input).trim();
  
  // 1. Se contiver número (ex: "#038", "#38", "38", "#038 Ninetales")
  const numMatch = raw.match(/#?(\d+)/);
  if (numMatch) {
    const pokeId = Number(numMatch[1]);
    const byId = state.speciesList.find(s => Number(s.pokeId) === pokeId);
    if (byId) return byId;
  }
  
  // 2. Normalização de texto
  const clean = str => String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const targetClean = clean(raw);
  if (!targetClean) return null;

  // Busca exata limpa
  let found = state.speciesList.find(s => clean(s.name) === targetClean);
  if (found) return found;

  // Busca por contenção
  found = state.speciesList.find(s => clean(s.name).includes(targetClean) || targetClean.includes(clean(s.name)));
  if (found) return found;

  return null;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child.nodeType ? child : String(child));
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function tagBadges(tags, reasons = []) {
  return tags.map(t => el('span', { class: 'tag', style: `--tag:${TAGS[t].color}`, title: reasons.join(' · ') }, TAGS[t].label));
}

function typeBadges(types = []) {
  return types.map(t => el('span', { class: 'type' }, TYPE_LABELS[t] ?? t));
}

function bar(ratio, kind = '') {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return el('div', { class: `bar ${kind}` }, el('span', { style: `width:${pct}%` }));
}

function pokeSpriteUrl(speciesId, shiny = false) {
  if (!speciesId) return null;
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shiny ? 'shiny/' : ''}${speciesId}.gif`;
}

function pokeStaticSpriteUrl(speciesId, shiny = false) {
  if (!speciesId) return null;
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shiny ? 'shiny/' : ''}${speciesId}.png`;
}

function applyTheme(theme) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light-mode', isLight);
  document.body.classList.toggle('dark-mode', !isLight);
  document.body.classList.toggle('theme-light', isLight);
  $('#theme-btn-dark')?.classList.toggle('active', !isLight);
  $('#theme-btn-light')?.classList.toggle('active', isLight);
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = isLight ? '🌙' : '☀️';
  try { localStorage.setItem('piw:theme', theme); } catch {}
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('piw:theme'); } catch {}
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved ?? (prefersLight ? 'light' : 'dark'));
}

// ---------- Alertas Sonoros (Web Audio API) ----------
let audioCtx = null;
let soundEnabled = true;

try {
  const savedSound = localStorage.getItem('piw:sound');
  if (savedSound !== null) soundEnabled = savedSound === 'true';
} catch {}

function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function updateSoundToggleUi() {
  const btn = $('#sound-toggle');
  if (!btn) return;
  btn.textContent = soundEnabled ? '🔊 Som: On' : '🔇 Som: Off';
  btn.classList.toggle('muted', !soundEnabled);
  btn.title = soundEnabled ? 'Avisos sonoros ativados (clique para mutar)' : 'Avisos sonoros desativados (clique para ativar)';
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem('piw:sound', String(soundEnabled)); } catch {}
  updateSoundToggleUi();
  if (soundEnabled) {
    getAudioContext();
    playShinySpawnSound();
  }
}

function setupAudioUnlock() {
  const unlock = () => {
    if (soundEnabled) getAudioContext();
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock);
}

// Som cintilante arpeggiado (E6, G#6, B6, E7, G#7 - estilo brilho mágico Shiny)
function playShinySpawnSound() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const freqs = [1318.51, 1661.22, 1975.53, 2637.02, 3322.44];
  freqs.forEach((freq, idx) => {
    const start = now + idx * 0.055;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(start);
    osc.stop(start + 0.3);
  });
}

// Som de vitória (Fanfarra rápida de derrota/captura de shiny)
function playShinyKillSound() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const notes = [
    { freq: 523.25, time: 0, dur: 0.1 },
    { freq: 659.25, time: 0.09, dur: 0.1 },
    { freq: 783.99, time: 0.18, dur: 0.12 },
    { freq: 1046.50, time: 0.28, dur: 0.32 }
  ];
  notes.forEach(({ freq, time: offset, dur }) => {
    const start = now + offset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(start);
    osc.stop(start + dur + 0.02);
  });
}

function playRadarChime() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.12);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch {}
}


// ---------- Contas ----------

function renderTotals() {
  const list = [...state.accounts.values()];
  const online = list.filter(a => a.status === 'online').length;
  const hunting = list.filter(a => a.status === 'online' && a.lastKillAt && Date.now() - a.lastKillAt < 120000).length;
  const sum = key => list.reduce((s, a) => s + (Number(a[key]) || 0), 0);
  const profitPerHour = list.reduce((s, a) => s + (a.analyzer?.profitPerHour || 0), 0);
  const totalKillsPerHour = list.reduce((s, a) => s + (a.analyzer?.killsPerHour || 0), 0);
  const totalBox = list.reduce((s, a) => s + (a.box?.count || 0), 0);
  const totalCapacity = list.reduce((s, a) => s + (a.box?.capacity || 0), 0);
  const boxPct = totalCapacity > 0 ? Math.round((totalBox / totalCapacity) * 100) : 0;
  const junkCount = list.reduce((s, a) => s + (a.junkCount || 0), 0);
  const shiniesCount = Math.max(state.shinies?.length || 0, state.highlights.filter(h => h.poke?.shiny).length);
  const matrizCount = state.highlights.filter(h => h.poke?.tags?.includes('matriz')).length;

  const card = (label, value, sub, valCls = '') => el('div', { class: 'metric-card' },
    el('div', { class: 'metric-label' }, label),
    el('div', { class: `metric-value ${valCls}` }, value),
    el('div', { class: 'metric-sub' }, sub)
  );

  $('#totals').replaceChildren(
    card('Rendimento somado', `${profitPerHour >= 0 ? '+' : '−'}$ ${fmt(Math.abs(profitPerHour))}/h`, `$ ${fmt(sum('gold'))} em caixa`, profitPerHour >= 0 ? 'pos' : 'neg'),
    card('Velocidade de caça', `${fmt(totalKillsPerHour)} kills/h`, `${online} contas online sem interrupção`),
    card('Ocupação de Box', `${totalBox} / ${totalCapacity || 100} (${boxPct}%)`, `${junkCount} Pokémons para vender`, boxPct >= 90 ? 'warn' : ''),
    card('Destaques da Sessão', `✨ ${shiniesCount} Shinies`, `${matrizCount} Matrizes IV 160+ salvas`)
  );
}

function estimateTime(remaining, ratePerHour) {
  if (remaining == null || ratePerHour == null || ratePerHour <= 0 || remaining <= 0) return null;
  const hours = remaining / ratePerHour;
  if (!isFinite(hours) || hours <= 0) return null;
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 48) return '> 2d';
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ''}`;
  return `${m}m`;
}

function supplyLine(label, value, min, extra = '') {
  const cls = value === 0 ? 'out' : value != null && value !== Infinity && value < min ? 'low' : '';
  const text = `${label}: ${fmt(value)}${extra}`;
  return el('span', { class: cls, title: text }, text);
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`;
}

function duration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function huntingStatus(a) {
  if (a.status === 'handedOff') {
    if (a.lastKillAt && Date.now() - a.lastKillAt < 120000) {
      return ['No navegador (Observando)', 'ok'];
    }
    return ['No navegador', 'info'];
  }
  if (a.status !== 'online') return STATUS[a.status] ?? [a.status, 'warn'];
  if (a.lastKillAt && Date.now() - a.lastKillAt < 120000) return [`Online`, 'ok'];
  return [a.lastKillAt ? `Online · sem kill` : 'Online', 'warn'];
}

function sessionVisor(z, a) {
  const capturesPerHour = z?.seconds > 60 && z.captures > 0 ? (z.captures / z.seconds) * 3600 : 0;
  const isOnline = a.status === 'online' || a.status === 'handedOff';
  const isObserving = a.status === 'handedOff';
  return el('div', { class: 'session-visor' },
    el('div', { class: 'session-visor-top' },
      el('div', { class: 'session-visor-title' },
        el('span', { class: `session-visor-dot ${isOnline ? 'active' : 'idle'}` }),
        el('span', { class: 'mono' }, isObserving ? 'SESSÃO NO NAVEGADOR' : 'VISOR DE SESSÃO'),
        a.hunt ? el('span', { class: 'session-visor-hunt' }, `· ${a.hunt}`) : null
      ),
      el('span', { class: 'session-visor-xp mono' }, z?.xpPerHour ? `✨ ${fmt(z.xpPerHour)} XP/h` : '')
    ),
    el('div', { class: 'session-visor-grid' },
      el('div', { class: 'session-cell' },
        el('span', { class: 'session-cell-label' }, '⏱️ Duração'),
        el('span', { class: 'session-cell-val mono' }, duration(z?.seconds || 0)),
        el('span', { class: 'session-cell-sub mono' }, isOnline ? (z?.seconds > 0 ? (isObserving ? 'observando ao vivo' : 'sessão ativa') : 'iniciando…') : 'pausada')
      ),
      el('div', { class: 'session-cell' },
        el('span', { class: 'session-cell-label' }, '⚔️ Kills'),
        el('span', { class: 'session-cell-val mono' }, fmt(z?.kills || 0)),
        el('span', { class: 'session-cell-sub mono' }, `${fmt(z?.killsPerHour || 0)}/h`)
      ),
      el('div', { class: 'session-cell' },
        el('span', { class: 'session-cell-label' }, '🔴 Capturas'),
        el('span', { class: 'session-cell-val mono' },
          fmt(z?.captures || 0),
          z?.shinyCaptures ? el('span', { class: 'shiny-badge' }, `✨${z.shinyCaptures}`) : null
        ),
        el('span', { class: 'session-cell-sub mono' }, `${fmt(Math.round(capturesPerHour))}/h`)
      )
    )
  );
}

async function changeHunt(accountId, currentHunt) {
  const slug = prompt('Slug da hunt (ex: furious_scyther, gastly, wobbuffet, pinsir):', currentHunt || '');
  if (!slug || !slug.trim()) return;
  await act(`/api/accounts/${accountId}/hunt`, { slug: slug.trim() });
}

function renderAccountCard(a) {
  const [statusText, statusKind] = huntingStatus(a);
  const cooldown = a.cooldownUntil && a.cooldownUntil > Date.now() ? ` · cd ${Math.ceil((a.cooldownUntil - Date.now()) / 1000)}s` : '';
  const leader = a.leader;
  const box = a.box;
  const boxRatio = box ? box.count / box.capacity : 0;
  const limits = state.config?.alerts ?? { ballsMin: 100, potionsMin: 20, boxRatio: 0.9 };
  const s = a.supplies;
  const z = a.analyzer;

  const capturesPerHour = z?.seconds > 60 && z.captures > 0 ? (z.captures / z.seconds) * 3600 : null;
  const remainingSlots = box ? Math.max(0, box.capacity - box.count) : null;
  const boxTime = estimateTime(remainingSlots, capturesPerHour);

  const ballsPerHour = z?.seconds > 60 && z.ballsUsed > 0 ? (z.ballsUsed / z.seconds) * 3600 : null;
  const activeBalls = s?.ball ? (s.ball.infinite ? Infinity : s.ball.quantity) : s?.ballsTotal;
  const ballsTime = estimateTime(activeBalls, ballsPerHour);

  const actions = [
    a.junkCount > 0 ? el('button', { class: 'btn-crimson small', onclick: () => openSell(a.id) }, `💰 Limpar lixo ($ ${fmt(a.junkCount * 800)})`) : null,
    el('button', { class: 'btn-hardware-subtle small', onclick: () => openCollection(a.id) }, '📋 Coleção'),
    el('button', { class: 'btn-hardware-subtle small', onclick: () => openSession(a.id) }, '🌐 Sessão'),
    ['replaced', 'error', 'offline', 'handedOff'].includes(a.status) ? el('button', { class: 'btn-hardware-subtle small', onclick: () => act(`/api/accounts/${a.id}/reconnect`) }, '🔌 Reconectar') : null,
    el('button', { class: 'btn-hardware-subtle small', title: 'Remover do cockpit', onclick: () => removeAccount(a) }, '✕')
  ].filter(Boolean);

  const spriteUrl = leader ? pokeSpriteUrl(leader.speciesId, leader.shiny) : null;
  const fallbackUrl = leader ? pokeStaticSpriteUrl(leader.speciesId, leader.shiny) : null;
  const spriteImg = spriteUrl ? el('img', {
    src: spriteUrl, alt: leader.name, class: 'pixelated sprite-leader-large',
    onerror: e => { if (e.target.src !== fallbackUrl) e.target.src = fallbackUrl; else e.target.style.display = 'none'; }
  }) : (leader ? el('div', { class: 'avatar' }, (leader.name ?? '?').slice(0, 2).toUpperCase()) : null);

  const profit = z?.profitPerHour || 0;

  return el('article', { class: 'account-card' },
    el('div', { class: 'account-card-header' },
      el('div', { class: 'account-info' },
        el('div', { class: 'account-title-row' },
          el('h3', { class: 'name' }, a.trainer?.name ?? a.name, a.trainer?.level != null ? el('span', { class: 'muted' }, ` · Nv ${a.trainer.level}`) : ''),
          el('span', { class: `pill-status ${statusKind}`, title: a.error ?? '' }, statusText + cooldown)
        ),
        el('p', { class: 'hunt-target' },
          a.hunt ? 'Caçando: ' : 'Fora de hunt',
          a.hunt
            ? el('b', {
                style: 'cursor:pointer; text-decoration:underline dotted;',
                title: 'Clique para trocar hunt',
                onclick: () => changeHunt(a.id, a.hunt)
              }, a.hunt)
            : el('span', {
                style: 'cursor:pointer; text-decoration:underline dotted;',
                title: 'Clique para definir hunt',
                onclick: () => changeHunt(a.id, '')
              }, '(definir)'),
          el('button', {
            class: 'btn-hardware-subtle small',
            style: 'margin-left:6px; padding:0 5px; font-size:10px; height:18px; line-height:16px;',
            title: 'Trocar Hunt',
            onclick: () => changeHunt(a.id, a.hunt)
          }, '🎯 Trocar'),
          a.lastKillAt ? ` · kill há ${ago(a.lastKillAt)}` : ''
        ),
        el('div', { class: 'account-financials' },
          el('span', { class: 'mono bold' }, `$ ${fmt(a.gold)}`),
          el('span', { class: `mono font-semibold ${profit >= 0 ? 'pos' : 'neg'}` }, `${profit >= 0 ? '+' : '−'}$ ${fmt(Math.abs(profit))}/h`)
        )
      ),
      leader ? el('div', { class: 'lcd-pocket-large' },
        spriteImg,
        el('div', { class: 'drop-floor' }),
        el('div', { class: 'leader-caption' },
          el('span', { class: 'leader-name' }, `${leader.shiny ? '✨ ' : ''}${leader.name}`),
          el('span', { class: 'leader-lvl mono' }, `Nv ${fmt(leader.level)}`)
        )
      ) : el('div', { class: 'lcd-pocket-large muted' }, 'Sem líder')
    ),
    sessionVisor(z, a),
    el('div', { class: 'gauges-panel' },
      el('div', { class: 'gauge-item' },
        el('div', { class: 'gauge-label' },
          el('span', {}, `Box: ${fmt(box?.count ?? 0)} / ${fmt(box?.capacity ?? 0)}`),
          el('span', { class: `mono ${boxRatio >= limits.boxRatio ? 'warn' : 'pos'}` }, boxTime ? `~${boxTime} restante` : '> 5h')
        ),
        bar(boxRatio, boxRatio >= 1 ? 'bad' : boxRatio >= limits.boxRatio ? 'warn' : 'ok')
      ),
      el('div', { class: 'gauge-item' },
        el('div', { class: 'gauge-label' },
          el('span', {}, `🔴 Pokébolas: ${fmt(activeBalls)}`),
          el('span', { class: 'mono muted' }, ballsTime ? `~${ballsTime} de munição` : '')
        ),
        bar(activeBalls != null && activeBalls !== Infinity ? Math.min(1, activeBalls / 400) : 1, activeBalls < limits.ballsMin ? 'warn' : 'ok')
      )
    ),
    el('div', { class: 'account-footer' },
      el('span', { class: 'muted mono', style: 'font-size:11px' }, a.lastKillAt ? `Último kill há ${ago(a.lastKillAt)}` : (a.status === 'online' ? 'Sessão ativa · aguardando kill' : (a.status === 'handedOff' ? 'Observando no navegador' : 'Conta pausada'))),
      el('div', { class: 'account-actions' }, actions)
    ),
    a.alerts?.length ? el('div', { class: 'alerts' }, a.alerts.map(al => el('div', { class: `alert ${al.level}` }, al.text))) : null
  );
}

function renderAccounts() {
  const list = [...state.accounts.values()];
  $('#accounts').replaceChildren(...(list.length ? list.map(renderAccountCard)
    : [el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhuma conta ainda. Clique em “+ Conta”.')]));
  const warnNodes = state.warnings.map(w => el('div', { class: 'warning-banner' },
    el('div', { class: 'warning-banner-left' },
      el('span', { class: 'warning-dot' }),
      el('span', {}, w)
    )
  ));
  $('#warnings').replaceChildren(...warnNodes);
  renderTotals();
  refreshAccountSelects();
}

function renderLogs() {
  $('#logs').replaceChildren(...state.logs.slice(0, 100).map(l =>
    el('li', {}, el('time', {}, time(l.at)), l.accountName ? `${l.accountName}: ` : '', l.text)));
}

function renderSessionShinies() {
  const container = $('#session-shinies-list');
  const badge = $('#shinies-counter-badge');
  const summary = $('#shinies-stats-summary');
  if (!container) return;

  const shinies = state.shinies || [];
  const spawns = shinies.filter(s => s.type === 'spawn').length;
  const kills = shinies.filter(s => s.type === 'kill').length;
  const captures = shinies.filter(s => s.type === 'capture').length;

  if (badge) {
    badge.textContent = `${shinies.length} encontrado${shinies.length === 1 ? '' : 's'}`;
    badge.classList.toggle('has-shinies', shinies.length > 0);
  }
  if (summary) {
    if (shinies.length > 0) {
      summary.textContent = `👁️ ${spawns} spawns · ⚔️ ${kills} derrotados · 🔴 ${captures} capturados`;
    } else {
      summary.textContent = soundEnabled ? 'Radar sonoro ativo' : 'Radar sonoro mudo';
    }
  }

  if (shinies.length === 0) {
    container.replaceChildren(
      el('div', { class: 'empty-shinies-state' },
        el('div', { class: 'empty-shinies-icon' }, '✨'),
        el('div', { class: 'empty-shinies-text' }, 'Nenhum shiny avistado nesta sessão ainda'),
        el('div', { class: 'empty-shinies-sub' }, 'O radar do Cockpit está monitorando as hunts com alerta sonoro. Ao spawnar ou derrotar um shiny, você ouvirá o aviso sonoro e o registro aparecerá aqui.')
      )
    );
    return;
  }

  const items = shinies.map(item => {
    const spriteUrl = item.speciesId ? pokeSpriteUrl(item.speciesId, true) : null;
    const fallbackUrl = item.speciesId ? pokeStaticSpriteUrl(item.speciesId, true) : null;
    const spriteImg = spriteUrl ? el('img', {
      src: spriteUrl, alt: item.speciesName, class: 'pixelated',
      onerror: e => { if (e.target.src !== fallbackUrl) e.target.src = fallbackUrl; else e.target.style.display = 'none'; }
    }) : el('span', { style: 'font-size:22px;' }, '✨');

    const pillClass = item.type === 'kill' ? 'kill' : item.type === 'capture' ? 'capture' : 'spawn';
    const pillText = item.type === 'kill' ? '⚔️ Derrotado' : item.type === 'capture' ? '🔴 Capturado' : '👁️ Spawnou';

    let lootText = '';
    if (item.loot && Array.isArray(item.loot) && item.loot.length > 0) {
      lootText = ' · Loot: ' + item.loot.map(l => `${l.name} (${l.qty || 1})`).join(', ');
    }

    return el('div', { class: 'shiny-log-item' },
      el('div', { class: 'shiny-log-sprite' },
        spriteImg,
        el('div', { class: 'drop-floor mini' })
      ),
      el('div', { class: 'shiny-log-content' },
        el('div', { class: 'shiny-log-title' },
          el('span', { class: 'shiny-log-name' }, `✨ ${item.speciesName}`),
          el('span', { class: `shiny-event-pill ${pillClass}` }, pillText)
        ),
        el('div', { class: 'shiny-log-meta' },
          el('span', {}, 'Conta: '),
          el('b', {}, item.accountName),
          el('span', {}, ' · Hunt: '),
          el('span', { class: 'mono' }, item.hunt),
          lootText ? el('span', { class: 'muted' }, lootText) : null
        )
      ),
      el('div', { class: 'shiny-log-time mono' },
        el('div', {}, time(item.at)),
        el('div', { class: 'muted' }, `há ${ago(item.at)}`)
      )
    );
  });

  container.replaceChildren(...items);
}

function refreshAccountSelects() {
  for (const [sel, allowAll] of [['#col-account', false], ['#hl-account', true], ['#mk-account', false], ['#bag-account', false], ['#route-account', false], ['#breeder-account', false]]) {
    const select = $(sel);
    if (!select) continue;
    const current = select.value;
    const options = [...state.accounts.values()].map(a => el('option', { value: a.id }, a.trainer?.name ?? a.name));
    select.replaceChildren(...(allowAll ? [el('option', { value: '' }, 'Todas')] : []), ...options);
    if ([...select.options].some(o => o.value === current)) select.value = current;
  }
}

async function act(path, body) {
  try { await api(path, { method: 'POST', body: body ?? {} }); }
  catch (error) { alert(error.message); }
}

async function openSession(id) {
  try {
    const { url } = await api(`/api/accounts/${id}/open`, { method: 'POST', body: {} });
    window.open(url, '_blank');
  } catch (error) { alert(error.message); }
}

async function removeAccount(a) {
  if (!confirm(`Remover ${a.trainer?.name ?? a.name} do cockpit? (A conta no jogo não é afetada.)`)) return;
  try { await api(`/api/accounts/${a.id}`, { method: 'DELETE' }); }
  catch (error) { alert(error.message); }
}

// ---------- Coleção ----------

const COLUMNS = [
  ['sel', ''], ['name', 'Pokémon'], ['tags', 'Tags'], ['level', 'Nv', true], ['ivTotal', 'IV', true],
  ['quality', 'Q', true], ['power', 'Power', true], ['types', 'Tipos'], ['category', 'Ataque'],
  ['best', 'Forte / fraco'], ['sellValue', 'Venda', true], ['lock', '']
];

async function openCollection(id) {
  switchTab('colecao');
  $('#col-account').value = id;
  await loadCollection();
}

async function loadCollection() {
  const id = $('#col-account').value;
  state.collection.accountId = id;
  state.collection.selected.clear();
  if (!id) { state.collection.items = []; return renderCollection(); }
  try {
    state.collection.items = (await api(`/api/accounts/${id}/pokes`)).pokes;
  } catch (error) {
    state.collection.items = [];
    $('#col-count').textContent = error.message;
  }
  renderCollection();
}

function collectionRows() {
  const tag = $('#col-tag').value;
  const type = $('#col-type').value;
  const text = $('#col-text').value.trim().toLowerCase();
  const { sort, dir } = state.collection;

  return state.collection.items
    .filter(p => !tag || p.tags.includes(tag) || (tag === 'none' && !p.tags.length))
    .filter(p => !type || p.profile?.types.includes(type))
    .filter(p => !text || p.name.toLowerCase().includes(text) || (p.profile?.family ?? '').toLowerCase().includes(text))
    .sort((a, b) => {
      if (sort === 'tags') return dir * ((TAG_ORDER.indexOf(primaryTag(a.tags)) + 1 || 9) - (TAG_ORDER.indexOf(primaryTag(b.tags)) + 1 || 9));
      if (sort === 'name') return dir * a.name.localeCompare(b.name);
      return dir * ((a[sort] ?? -1) - (b[sort] ?? -1));
    });
}

function renderCollection() {
  const rows = collectionRows();
  const selected = state.collection.selected;
  const selectableRows = rows.filter(p => !(p.team || p.starter || p.locked || p.tags.includes('raro') || p.shiny));
  const allFilteredSelected = selectableRows.length > 0 && selectableRows.every(p => selected.has(String(p.id)));
  const someFilteredSelected = selectableRows.some(p => selected.has(String(p.id)));

  const head = el('tr', {}, COLUMNS.map(([key, label, numeric]) => {
    if (key === 'sel') {
      const chk = el('input', {
        type: 'checkbox',
        title: 'Marcar / desmarcar todos os filtrados',
        checked: allFilteredSelected,
        onchange: e => {
          if (e.target.checked) {
            for (const p of selectableRows) selected.add(String(p.id));
          } else {
            for (const p of rows) selected.delete(String(p.id));
          }
          renderCollection();
        }
      });
      chk.indeterminate = !allFilteredSelected && someFilteredSelected;
      return el('th', {}, chk);
    }
    return el('th', {
      class: numeric ? 'num' : '',
      onclick: () => {
        if (['sel', 'lock', 'types', 'category', 'best'].includes(key)) return;
        state.collection.dir = state.collection.sort === key ? -state.collection.dir : -1;
        state.collection.sort = key;
        renderCollection();
      }
    }, label + (state.collection.sort === key ? (state.collection.dir < 0 ? ' ▼' : ' ▲') : ''));
  }));
  const body = rows.map(p => {
    const prot = p.team || p.starter || p.locked;
    const spriteUrl = pokeSpriteUrl(p.speciesId, p.shiny);
    const fallbackUrl = pokeStaticSpriteUrl(p.speciesId, p.shiny);
    const spriteImg = spriteUrl ? el('img', {
      src: spriteUrl, alt: p.name, class: 'pixelated sprite-row',
      onerror: e => { if (e.target.src !== fallbackUrl) e.target.src = fallbackUrl; else e.target.style.display = 'none'; }
    }) : null;

    return el('tr', { class: prot ? 'protected' : '' },
      el('td', {}, el('input', {
        type: 'checkbox', disabled: prot || p.tags.includes('raro') || p.shiny, checked: selected.has(String(p.id)),
        onchange: e => { e.target.checked ? selected.add(String(p.id)) : selected.delete(String(p.id)); updateCollectionCount(rows); renderCollection(); }
      })),
      el('td', { class: 'poke-cell' },
        spriteImg,
        el('span', {}, `${p.shiny ? '✨ ' : ''}${p.name}`, (p.team ? el('span', { class: 'muted' }, ' (time)') : null))
      ),
      el('td', {}, tagBadges(p.tags, p.reasons)),
      el('td', { class: 'num' }, fmt(p.level)),
      el('td', { class: 'num' }, fmt(p.ivTotal)),
      el('td', { class: 'num' }, p.quality != null ? p.quality.toFixed(2) : '—'),
      el('td', { class: 'num' }, fmt(p.power)),
      el('td', {}, typeBadges(p.profile?.types)),
      el('td', {}, CATEGORY_LABELS[p.profile?.category] ?? '—'),
      el('td', { class: 'muted' }, p.profile ? `↑ ${p.profile.best} · ↓ ${p.profile.worst}` : '—'),
      el('td', { class: 'num' }, p.sellValue != null ? `$ ${fmt(p.sellValue)}` : '—'),
      el('td', {}, el('button', {
        class: 'small', title: p.locked ? 'Destravar' : 'Travar',
        onclick: async () => {
          await act(`/api/accounts/${state.collection.accountId}/lock`, { pokeId: p.id, locked: !p.locked });
          await loadCollection();
        }
      }, p.locked ? '🔒' : '🔓'))
    );
  });
  $('#col-table').replaceChildren(el('thead', {}, head), el('tbody', {}, body));

  // Cards Grid Mode
  const gridCards = rows.map(p => {
    const prot = p.team || p.starter || p.locked;
    const isChecked = selected.has(String(p.id));
    const isLixo = p.tags.includes('lixo');
    const spriteUrl = pokeSpriteUrl(p.speciesId, p.shiny);
    const fallbackUrl = pokeStaticSpriteUrl(p.speciesId, p.shiny);
    const spriteImg = spriteUrl ? el('img', {
      src: spriteUrl, alt: p.name, class: 'pixelated sprite-card',
      onerror: e => { if (e.target.src !== fallbackUrl) e.target.src = fallbackUrl; else e.target.style.display = 'none'; }
    }) : null;

    const chk = el('input', {
      type: 'checkbox',
      disabled: prot || p.tags.includes('raro') || p.shiny,
      checked: isChecked,
      onchange: e => {
        e.target.checked ? selected.add(String(p.id)) : selected.delete(String(p.id));
        updateCollectionCount(rows);
        renderCollection();
      }
    });

    const topBadge = p.shiny
      ? el('span', { class: 'pill-status warn mono' }, '✨ SHINY')
      : (p.tags.length ? tagBadges(p.tags.slice(0, 1), p.reasons) : (p.team ? el('span', { class: 'pill-status info mono' }, 'TIME') : null));

    return el('div', { class: `poke-card ${prot ? 'protected' : ''} ${isLixo ? 'is-lixo' : ''}` },
      el('div', { class: 'card-top' }, chk, topBadge),
      el('div', { class: 'lcd-pocket card-view' },
        spriteImg,
        el('div', { class: 'drop-floor' })
      ),
      el('div', { class: 'card-title' }, `${p.shiny ? '✨ ' : ''}${p.name} Nv ${fmt(p.level)}`),
      el('div', { class: 'card-stats mono' }, `IV ${fmt(p.ivTotal)} · Q ${p.quality != null ? p.quality.toFixed(2) : '—'}`),
      el('div', { class: 'card-foot' },
        typeBadges(p.profile?.types),
        el('button', {
          type: 'button',
          class: 'btn-hardware-subtle mini',
          style: 'padding: 2px 6px; font-size: 10px; margin-left: auto;',
          title: 'Ver preço médio no mercado',
          onclick: (e) => { e.stopPropagation(); openMarketEstimate(p); }
        }, '💡 Mercado'),
        (p.sellValue != null) ? el('span', { class: 'muted mono' }, `$ ${fmt(p.sellValue)}`) : null
      )
    );
  });

  const emptyMsg = [el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhum Pokémon encontrado com estes filtros.')];
  $('#col-grid-wrap').replaceChildren(...(rows.length ? gridCards : emptyMsg));

  setCollectionView(state.collection.viewMode || 'grid');
  updateCollectionCount(rows);
}

function setCollectionView(mode) {
  state.collection.viewMode = mode;
  $('#col-view-grid')?.classList.toggle('on', mode === 'grid');
  $('#col-view-table')?.classList.toggle('on', mode === 'table');
  if ($('#col-grid-wrap')) $('#col-grid-wrap').hidden = mode !== 'grid';
  if ($('#col-table-wrap')) $('#col-table-wrap').hidden = mode !== 'table';
  try { localStorage.setItem('piw:colView', mode); } catch {}
}

function updateCollectionCount(rows) {
  const selected = state.collection.items.filter(p => state.collection.selected.has(String(p.id)));
  const gold = selected.reduce((s, p) => s + (p.sellValue ?? 0), 0);
  $('#col-count').textContent = `${rows.length} de ${state.collection.items.length} Pokémon · ${selected.length} selecionados ($ ${fmt(gold)})`;

  const dock = $('#col-floating-dock');
  if (dock) {
    if (selected.length > 0) {
      dock.classList.remove('hidden');
      $('#dock-text').innerHTML = `<b>${selected.length}</b> marcados · Total: <span class="mono" style="color:var(--ok)">$ ${fmt(gold)}</span>`;
    } else {
      dock.classList.add('hidden');
    }
  }
}

function addSpeciesToRouteQueue(speciesId, name) {
  switchTab('rota');
  if (typeof addToCustomQueue === 'function') {
    addToCustomQueue({ speciesId, name });
  }
}

// ---------- Venda rápida ----------

async function openSell(id, preselected) {
  const s = state.sell;
  s.accountId = id;
  try {
    const all = (await api(`/api/accounts/${id}/pokes`)).pokes;
    s.items = preselected
      ? all.filter(p => preselected.has(String(p.id)))
      : all.filter(p => p.tags.includes('lixo'));
  } catch (error) { return alert(error.message); }
  s.selected = new Set(s.items.map(p => String(p.id)));
  const account = state.accounts.get(id);
  $('#sell-title').textContent = `${preselected ? 'Vender selecionados' : 'Vender lixo'} — ${account?.trainer?.name ?? account?.name ?? id}`;
  $('#sell-error').textContent = '';
  renderSell();
  $('#dlg-sell').showModal();
}

function renderSell() {
  const s = state.sell;
  const head = el('tr', {}, ['', 'Pokémon', 'Nv', 'IV', 'Q', 'Venda'].map(h => el('th', {}, h)));
  const body = s.items.map(p => el('tr', {},
    el('td', {}, el('input', {
      type: 'checkbox', checked: s.selected.has(String(p.id)),
      onchange: e => { e.target.checked ? s.selected.add(String(p.id)) : s.selected.delete(String(p.id)); updateSellTotal(); }
    })),
    el('td', {}, p.name, ' ', tagBadges(p.tags, p.reasons)),
    el('td', {}, fmt(p.level)), el('td', {}, fmt(p.ivTotal)),
    el('td', {}, p.quality != null ? p.quality.toFixed(2) : '—'),
    el('td', {}, `$ ${fmt(p.sellValue)}`)));
  $('#sell-table').replaceChildren(el('thead', {}, head), el('tbody', {}, s.items.length ? body
    : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nada para vender agora.'))]));
  updateSellTotal();
}

function updateSellTotal() {
  const s = state.sell;
  const chosen = s.items.filter(p => s.selected.has(String(p.id)));
  $('#sell-total').textContent = `${chosen.length} marcados · $ ${fmt(chosen.reduce((sum, p) => sum + (p.sellValue ?? 0), 0))}`;
  $('#sell-confirm').textContent = `Vender ${chosen.length}`;
}

// ---------- Destaques ----------

function renderHighlights() {
  const account = $('#hl-account').value;
  const tag = $('#hl-tag').value;
  const list = state.highlights.filter(h => (!account || h.account === account) && (!tag || h.poke.tags.includes(tag)));

  const cards = list.length ? list.slice(0, 300).map(h => {
    let spriteNode = null;
    if (h.poke.speciesId) {
      const spriteUrl = pokeSpriteUrl(h.poke.speciesId, h.poke.shiny);
      const fallbackUrl = pokeStaticSpriteUrl(h.poke.speciesId, h.poke.shiny);
      spriteNode = el('div', { class: 'lcd-pocket mini' },
        el('img', {
          src: spriteUrl,
          alt: h.poke.name,
          class: 'pixelated sprite-mini',
          onerror: e => {
            if (e.target.src !== fallbackUrl) e.target.src = fallbackUrl;
            else e.target.style.display = 'none';
          }
        }),
        el('div', { class: 'drop-floor mini' })
      );
    }
    return el('article', { class: 'highlight-card' },
      spriteNode,
      el('div', { class: 'highlight-info' },
        el('div', { class: 'highlight-meta' },
          el('time', {}, time(h.at)),
          el('span', { class: 'highlight-trainer' }, h.accountName)
        ),
        el('div', { class: `highlight-name ${h.poke.shiny ? 'shiny' : ''}` },
          `${h.poke.shiny ? '✨ ' : ''}${h.poke.name}${h.poke.level ? ` Nv ${fmt(h.poke.level)}` : ''}`
        ),
        el('div', { class: 'highlight-stats' },
          `IV ${fmt(h.poke.ivTotal)} · Q ${h.poke.quality?.toFixed(2) ?? '—'}`
        ),
        el('div', { style: 'margin-top:3px' },
          typeBadges(h.poke.profile?.types),
          tagBadges(h.poke.tags, h.poke.reasons)
        )
      )
    );
  }) : [el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhuma captura notável na sessão ainda. O lixo é filtrado automaticamente.')];

  $('#highlights').replaceChildren(...cards);
  const junk = [...state.accounts.values()].map(a => `${a.trainer?.name ?? a.name}: +${a.junkRecent ?? 0}`).join(' · ');
  $('#hl-junk').textContent = junk ? `Lixo capturado nas últimas 2 h — ${junk}` : '';
}

// ---------- Mercado ----------

async function fastSearchMarket() {
  const accountId = $('#mk-account').value;
  if (!accountId) return alert('Adicione uma conta primeiro: o mercado é comparado com a sua coleção.');
  const query = $('#mk-text').value.trim();
  const minIv = Number($('#mk-min-iv').value) || 0;
  const shiny = $('#mk-shiny-only').checked;
  const sort = $('#mk-sort').value === 'price' ? 'price-asc' : ($('#mk-sort').value === 'iv' ? 'iv-desc' : 'price-asc');

  let speciesId = null;
  if (query) {
    const sp = state.speciesList?.find(s => s.name.toLowerCase() === query.toLowerCase());
    if (sp) speciesId = sp.pokeId;
  }

  $('#mk-fast-search').disabled = true;
  $('#mk-status').textContent = 'Buscando na API do jogo…';
  $('#mk-results').replaceChildren();

  try {
    const data = await api('/api/market/search', {
      method: 'POST',
      body: {
        accountId,
        speciesId,
        q: speciesId ? undefined : (query || undefined),
        shiny,
        ivMin: minIv > 0 ? minIv : undefined,
        sort
      }
    });

    state.market.rawResults = data.results || [];
    state.market.accountId = accountId;
    state.market.lastMeta = {
      total: data.total,
      pages: data.pages,
      complete: true,
      stats: data.stats
    };
    renderMarket();
    if (data.stats && data.stats.total > 0) {
      const s = data.stats;
      $('#mk-status').innerHTML = `<b>${fmt(data.total)}</b> anúncios encontrados · Menor: <span class="mono pos">$ ${fmt(s.minPrice)}</span> · Média: <span class="mono">$ ${fmt(s.avgPrice)}</span> · Mediana: <span class="mono">$ ${fmt(s.medianPrice)}</span>`;
    }
  } catch (error) {
    $('#mk-status').textContent = error.message;
  } finally {
    $('#mk-fast-search').disabled = false;
  }
}

async function searchMarket() {
  const accountId = $('#mk-account').value;
  if (!accountId) return alert('Adicione uma conta primeiro: o mercado é comparado com a sua coleção.');
  $('#mk-search').disabled = true;
  $('#mk-cancel').hidden = false;
  $('#mk-results').replaceChildren();
  $('#mk-status').textContent = 'Consultando o Mercado Global…';
  try {
    const data = await api('/api/market/scan', { method: 'POST', body: {
      accountId, tag: $('#mk-tag').value, element: $('#mk-element').value, sort: $('#mk-sort').value
    } });
    state.market.rawResults = data.results || [];
    state.market.accountId = accountId;
    state.market.lastMeta = data;
    renderMarket();
  } catch (error) {
    $('#mk-status').textContent = error.message;
  } finally {
    $('#mk-search').disabled = false;
    $('#mk-cancel').hidden = true;
  }
}

function renderMarket() {
  const { rawResults, lastMeta } = state.market;
  if (!rawResults || !rawResults.length) {
    if (lastMeta) {
      $('#mk-status').textContent = `${fmt(lastMeta.total)} anúncios lidos em ${lastMeta.pages} página(s), nenhum anúncio compatível.`;
    }
    $('#mk-results').replaceChildren();
    return;
  }

  const query = $('#mk-text').value.trim().toLowerCase();
  const minIv = Number($('#mk-min-iv').value) || 0;
  const minQ = Number($('#mk-min-q').value) || 0;
  const maxPrice = Number($('#mk-max-price').value) || Infinity;
  const currency = $('#mk-currency').value;
  const shinyOnly = $('#mk-shiny-only').checked;
  const hideOffers = $('#mk-hide-offers').checked;
  const bargainOnly = $('#mk-bargain-only')?.checked;
  const tagFilter = $('#mk-tag').value;
  const elementFilter = $('#mk-element').value;
  const sortBy = $('#mk-sort').value;

  const filtered = rawResults.filter(item => {
    if (query && !item.name.toLowerCase().includes(query) && !item.comparison?.myBest?.name?.toLowerCase().includes(query)) return false;
    if (bargainOnly && !item.isBargain) return false;
    if (minIv > 0 && item.ivTotal < minIv) return false;
    if (minQ > 0 && item.quality < minQ) return false;
    if (shinyOnly && !item.shiny) return false;
    if (hideOffers && item.offerOnly) return false;
    if (currency && item.currency !== currency) return false;
    if (maxPrice < Infinity && !item.offerOnly && (item.price == null || item.price > maxPrice)) return false;
    if (tagFilter !== 'all' && !item.tags.includes(tagFilter)) return false;
    if (elementFilter && !item.types.includes(elementFilter)) return false;
    return true;
  });

  const SORTERS = {
    quality: (a, b) => b.quality - a.quality || b.ivTotal - a.ivTotal,
    iv: (a, b) => b.ivTotal - a.ivTotal || b.quality - a.quality,
    price: (a, b) => (a.offerOnly ? Infinity : a.price) - (b.offerOnly ? Infinity : b.price),
    diff: (a, b) => ((b.comparison?.ivDiff ?? -999) - (a.comparison?.ivDiff ?? -999)) || (b.ivTotal - a.ivTotal)
  };

  const sorted = [...filtered].sort(SORTERS[sortBy] ?? SORTERS.iv);

  if (lastMeta) {
    $('#mk-status').textContent = `${fmt(lastMeta.total)} anúncios lidos em ${lastMeta.pages} página(s), exibindo ${fmt(sorted.length)} de ${fmt(rawResults.length)} encontrados. ${lastMeta.complete ? 'Busca completa.' : 'Cobertura não confirmada.'} ${lastMeta.reason || ''}`;
  }

  $('#mk-results').replaceChildren(...sorted.map(item => {
    let splitNode = null;
    if (item.comparison) {
      const { myBest, ivDiff, qualityDiff, isUpgrade } = item.comparison;
      const ivDiffStr = ivDiff > 0 ? `+${ivDiff} IV` : (ivDiff === 0 ? `0 IV` : `${ivDiff} IV`);
      const qDiffStr = qualityDiff > 0 ? `+${qualityDiff.toFixed(2)} Q` : (qualityDiff === 0 ? `0 Q` : `${qualityDiff.toFixed(2)} Q`);
      splitNode = el('div', { class: 'market-split-compare' },
        el('div', { class: 'split-side left' },
          el('span', { class: 'split-label' }, 'Anúncio'),
          el('span', { class: 'split-val' }, `IV ${item.ivTotal}`),
          el('span', { class: 'split-sub' }, `Q ${item.quality != null ? item.quality.toFixed(2) : '—'}`)
        ),
        el('div', { class: `split-center ${isUpgrade ? 'upgrade' : 'downgrade'}` },
          el('span', { class: 'split-upgrade-title' }, isUpgrade ? 'Upgrade' : 'Downgrade'),
          el('span', { class: 'split-upgrade-diff' }, ivDiffStr),
          el('span', { class: 'split-upgrade-sub' }, qDiffStr)
        ),
        el('div', { class: 'split-side right' },
          el('span', { class: 'split-label' }, `Seu (${myBest.name})`),
          el('span', { class: 'split-val' }, `IV ${myBest.ivTotal}`),
          el('span', { class: 'split-sub' }, `Q ${myBest.quality != null ? myBest.quality.toFixed(2) : '—'}`)
        )
      );
    } else if (item.isNewSpecies) {
      splitNode = el('div', { class: 'market-split-compare new-species' },
        el('div', { class: 'split-side left' },
          el('span', { class: 'split-label' }, 'Anúncio'),
          el('span', { class: 'split-val' }, `IV ${item.ivTotal} · Q ${item.quality != null ? item.quality.toFixed(2) : '—'}${item.level ? ` (Nv ${fmt(item.level)})` : ''}`)
        ),
        el('div', { class: 'split-center badge-blue' },
          el('span', {}, '✨ Linha Inédita')
        )
      );
    } else {
      splitNode = el('div', { class: 'market-split-compare new-species' },
        el('div', { class: 'split-side left' },
          el('span', { class: 'split-label' }, 'Anúncio'),
          el('span', { class: 'split-val' }, `IV ${item.ivTotal} · Q ${item.quality != null ? item.quality.toFixed(2) : '—'}`)
        ),
        el('div', { class: 'split-side right' },
          el('span', { class: 'split-label' }, 'Tags'),
          el('span', { class: 'split-sub' }, item.tags?.length ? item.tags.join(', ') : 'Sem tag')
        )
      );
    }

    let spriteNode = null;
    if (item.speciesId) {
      const spriteUrl = pokeSpriteUrl(item.speciesId, item.shiny);
      const fallbackUrl = pokeStaticSpriteUrl(item.speciesId, item.shiny);
      spriteNode = el('div', { class: 'lcd-pocket mini' },
        el('img', {
          src: spriteUrl,
          alt: item.name,
          class: 'pixelated sprite-mini',
          onerror: e => {
            if (e.target.src !== fallbackUrl) e.target.src = fallbackUrl;
            else e.target.style.display = 'none';
          }
        }),
        el('div', { class: 'drop-floor mini' })
      );
    }

    const priceText = item.offerOnly ? 'Só oferta' : `${item.currency === 'DIAMONDS' ? '💎' : '$'} ${fmt(item.price)}`;

    // Suporte a múltiplos selos simultâneos (todos aparecem se aplicáveis)
    const badges = [];
    if (item.isBargain) {
      const pctText = item.bargainPct ? ` -${item.bargainPct}%` : '';
      badges.push(el('span', { class: 'market-badge mono bargain-badge' }, `🏷️ Pechincha${pctText}`));
    }
    if (item.comparison?.isUpgrade) {
      const diffText = item.comparison.ivDiff > 0 ? ` (+${item.comparison.ivDiff} IV)` : '';
      badges.push(el('span', { class: 'market-badge mono badge-upgrade' }, `🧬 Upgrade${diffText}`));
    } else if (item.isNewSpecies) {
      badges.push(el('span', { class: 'market-badge mono badge-new-species' }, '✨ Linha Inédita'));
    }
    if (item.pricePerIv) {
      const currIcon = item.currency === 'DIAMONDS' ? '💎' : '$';
      badges.push(el('span', { class: 'market-badge mono badge-cpi', title: 'Custo por ponto de IV' }, `${currIcon} ${fmt(item.pricePerIv)}/IV`));
    }

    return el('article', { class: `market-card ${item.isBargain ? 'is-bargain' : ''}` },
      el('div', { class: 'market-header' },
        spriteNode,
        el('div', { class: 'market-title' },
          el('div', { class: 'market-name' }, `${item.shiny ? '✨ ' : ''}${item.name}${item.level ? ` Nv ${fmt(item.level)}` : ''}`),
          item.listingId ? el('div', { class: 'market-sub-seller' }, `Anúncio #${item.listingId}${item.seller ? ` · ${item.seller}` : ''}`) : null,
          el('div', { style: 'margin-top:3px' }, typeBadges(item.types), tagBadges(item.tags, item.reasons))
        ),
        el('div', { class: 'market-price-box' },
          el('div', { class: 'market-price mono' }, priceText),
          el('div', { class: 'market-badges-row' }, ...badges)
        )
      ),
      splitNode
    );
  }));
}

async function openMarketEstimate(p) {
  const dlg = $('#dlg-estimate');
  $('#est-title').textContent = `💡 Mercado — ${p.shiny ? '✨ ' : ''}${p.name}`;
  $('#est-loading').hidden = false;
  $('#est-content').hidden = true;
  $('#est-open-market').onclick = () => {
    dlg.close();
    switchTab('mercado');
    $('#mk-text').value = p.name;
    fastSearchMarket();
  };
  dlg.showModal();

  try {
    const data = await api(`/api/market/estimate?speciesId=${p.speciesId || ''}&q=${encodeURIComponent(p.name)}`);
    $('#est-loading').hidden = true;
    $('#est-content').hidden = false;
    $('#est-min-price').textContent = data.minPrice ? `$ ${fmt(data.minPrice)}` : 'Nenhum ativo';
    $('#est-median-price').textContent = data.medianPrice ? `$ ${fmt(data.medianPrice)}` : '—';
    $('#est-total').textContent = `${fmt(data.total)} anúncios`;

    const samplesList = (data.sample || []).map(s => el('div', { class: 'est-sample-row mono text-xs' },
      el('span', { class: 'bold' }, `${s.shiny ? '✨ ' : ''}${s.name}`),
      el('span', { class: 'muted' }, `IV ${s.ivTotal} · Q ${s.quality ? s.quality.toFixed(2) : '—'}`),
      el('span', { class: 'pos bold' }, `${s.currency === 'DIAMONDS' ? '💎' : '$'} ${fmt(s.price)}`)
    ));
    $('#est-samples-list').replaceChildren(...(samplesList.length ? samplesList : [el('div', { class: 'muted text-xs' }, 'Sem anúncios ativos para esta espécie.')]));
  } catch (err) {
    $('#est-loading').textContent = `Erro ao consultar mercado: ${err.message}`;
  }
}

// ---------- Cotações de Commodities (Diamante & Feromônio) ----------

async function loadCommodityTickers() {
  try {
    const data = await api('/api/market/tickers');
    state.tickers = data;
    renderCommodityTickers();
  } catch (err) {
    console.error('Falha ao carregar cotações:', err);
  }
}

function renderSparklineSvg(points, field = 'min') {
  if (!points || points.length < 2) return null;
  const values = points.map(p => p[field]).filter(v => v != null);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 200;
  const h = 32;
  const coords = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 8) + 4;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'ticker-sparkline-svg');

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', coords);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'var(--accent-mint)');
  polyline.setAttribute('stroke-width', '2');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(polyline);
  return svg;
}

function renderDepthBars(depthItems, unit = '$', isGold = false) {
  if (!depthItems || !depthItems.length) return el('div', { class: 'empty-chart muted text-xs' }, 'Sem ofertas ativas');
  const maxQty = Math.max(...depthItems.map(d => d.qty), 1);
  return el('div', { class: 'depth-bars-container' },
    ...depthItems.map(d => {
      const pct = Math.min(100, Math.max(14, Math.round((d.qty / maxQty) * 100)));
      const priceStr = isGold ? (d.price >= 1000000 ? `${(d.price / 1000000).toFixed(2)}M` : `${Math.round(d.price / 1000)}k`) : `${d.price}`;
      return el('div', { class: 'depth-bar-col', title: `${unit} ${fmt(d.price)}: ${fmt(d.qty)} un (${d.sellers} vendedor${d.sellers > 1 ? 'es' : ''})` },
        el('div', { class: 'depth-bar-fill-wrap' },
          el('div', { class: 'depth-bar-fill', style: `height: ${pct}%` })
        ),
        el('div', { class: 'depth-bar-label mono' }, priceStr),
        el('div', { class: 'depth-bar-qty mono text-xs muted' }, `${d.qty}`)
      );
    })
  );
}

function renderCommodityTickers() {
  const t = state.tickers;
  if (!t) return;

  // 1. Diamante
  if (t.diamonds && t.diamonds.minPrice) {
    $('#dia-price').textContent = `$ ${fmt(t.diamonds.minPrice)}`;
    $('#dia-sub').textContent = `Mediana $ ${fmt(t.diamonds.medianPrice)} · ${fmt(t.diamonds.totalQty)} 💎 ativos`;
    $('#dia-stat').textContent = `${t.diamonds.listingsCount} ofertas ativas`;

    const chartBox = $('#dia-chart');
    if (chartBox) {
      const sparkline = renderSparklineSvg(t.history?.diamonds, 'min');
      const depthBars = renderDepthBars(t.diamonds.depth, '$', true);
      const nodes = [
        sparkline ? el('div', { class: 'sparkline-wrap' }, el('div', { class: 'sparkline-label text-xs muted mono' }, 'Histórico de Preço'), sparkline) : null,
        el('div', { class: 'depth-wrap' }, el('div', { class: 'depth-header text-xs muted mono' }, 'Profundidade das Menores Ofertas'), depthBars)
      ].filter(Boolean);
      chartBox.replaceChildren(...nodes);
    }
  }

  // 2. Feromônio
  if (t.pheromones) {
    const diaPrice = t.pheromones.diamonds?.minPrice ? `${t.pheromones.diamonds.minPrice} 💎` : '';
    const goldPrice = t.pheromones.gold?.minPrice ? `$ ${fmt(t.pheromones.gold.minPrice)}` : '';
    $('#phero-price').textContent = [diaPrice, goldPrice].filter(Boolean).join(' ou ') || 'Sem ofertas';
    const totalQty = (t.pheromones.diamonds?.totalQty || 0) + (t.pheromones.gold?.totalQty || 0);
    $('#phero-sub').textContent = `Mediana: ${t.pheromones.diamonds?.medianPrice ? `${t.pheromones.diamonds.medianPrice} 💎` : '—'} · ${fmt(totalQty)} un no mercado`;
    $('#phero-stat').textContent = `${t.pheromones.diamonds?.listingsCount || 0} em 💎 · ${t.pheromones.gold?.listingsCount || 0} em $`;

    const chartBox = $('#phero-chart');
    if (chartBox) {
      const sparkline = renderSparklineSvg(t.history?.pheromones, 'diaMin');
      const depthBars = renderDepthBars(t.pheromones.diamonds?.depth, '💎', false);
      const nodes = [
        sparkline ? el('div', { class: 'sparkline-wrap' }, el('div', { class: 'sparkline-label text-xs muted mono' }, 'Histórico em 💎'), sparkline) : null,
        el('div', { class: 'depth-wrap' }, el('div', { class: 'depth-header text-xs muted mono' }, 'Profundidade em 💎 (Menores Preços)'), depthBars)
      ].filter(Boolean);
      chartBox.replaceChildren(...nodes);
    }
  }
}

async function loadSpeciesCatalog() {
  try {
    const data = await api('/api/species');
    state.speciesList = data.species || [];
    const dl = $('#species-datalist');
    if (dl && state.speciesList.length) {
      dl.replaceChildren(...state.speciesList.map(s => el('option', { value: s.name })));
    }
  } catch {}
}

function setupSpeciesAutocomplete(inputId, dropdownId, onSelect) {
  const input = $(inputId);
  const dropdown = $(dropdownId);
  if (!input || !dropdown) return;

  function show(list) {
    if (!list.length) {
      dropdown.classList.add('hidden');
      return;
    }
    const items = list.slice(0, 10).map(s => {
      const row = el('div', { class: 'autocomplete-item' },
        el('span', { class: 'autocomplete-name bold' }, s.name),
        el('span', { class: 'autocomplete-types' },
          el('span', { class: 'type-badge mini', style: `--type:var(--type-${s.type1})` }, s.type1),
          s.type2 ? el('span', { class: 'type-badge mini', style: `--type:var(--type-${s.type2})` }, s.type2) : null
        )
      );
      row.onmousedown = e => {
        e.preventDefault();
        input.value = s.name;
        dropdown.classList.add('hidden');
        if (onSelect) onSelect(s);
      };
      return row;
    });
    dropdown.replaceChildren(...items);
    dropdown.classList.remove('hidden');
  }

  function filter() {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      dropdown.classList.add('hidden');
      return;
    }
    const matches = (state.speciesList || []).filter(s => s.name.toLowerCase().includes(q));
    show(matches);
  }

  input.addEventListener('input', filter);
  input.addEventListener('focus', filter);
  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') dropdown.classList.add('hidden');
  });
}

// ---------- Radar & Wishlist ----------

async function loadRadar() {
  try {
    const data = await api('/api/radar');
    state.radar.wishlist = data.wishlist || [];
    state.radar.matches = data.matches || [];
    renderRadar();
  } catch (err) {
    console.error('Falha ao carregar radar:', err);
  }
}

function renderRadar() {
  const { wishlist, matches } = state.radar;
  if ($('#wishlist-count')) $('#wishlist-count').textContent = `${wishlist.length} ${wishlist.length === 1 ? 'regra' : 'regras'}`;

  // Render wishlist rules
  const ruleNodes = wishlist.map(rule => {
    const critParts = [];
    if (rule.minIv) critParts.push(`IV ≥ ${rule.minIv}`);
    if (rule.minQuality) critParts.push(`Q ≥ ${Number(rule.minQuality).toFixed(2)}`);
    if (rule.maxPrice) {
      critParts.push(`Teto: ${rule.currency === 'DIAMONDS' ? '💎' : '$'} ${fmt(rule.maxPrice)}`);
    } else {
      critParts.push('Qualquer preço');
    }

    return el('div', { class: 'wishlist-item-card' },
      el('div', { class: 'wishlist-item-main' },
        el('div', { class: 'wishlist-item-title' },
          el('b', {}, rule.name),
          rule.speciesName ? el('span', { class: 'tag', style: '--tag:var(--accent-blue)' }, rule.speciesName) : el('span', { class: 'tag', style: '--tag:var(--text-muted)' }, 'Qualquer Poke'),
          rule.currency ? (rule.currency === 'DIAMONDS' ? el('span', { class: 'tag', style: '--tag:var(--accent-blue)' }, '💎 Só Diamonds') : el('span', { class: 'tag', style: '--tag:var(--accent-mint)' }, '💰 Só Gold')) : el('span', { class: 'tag', style: '--tag:var(--text-muted)' }, '🌐 Gold ou 💎'),
          rule.shinyOnly ? el('span', { class: 'tag', style: '--tag:#f0b71e' }, '✨ Só Shiny') : null
        ),
        el('div', { class: 'wishlist-item-crit mono text-xs muted' }, critParts.join(' · '))
      ),
      el('button', {
        type: 'button',
        class: 'btn-icon-subtle',
        title: 'Remover regra',
        onclick: async () => {
          if (!confirm(`Remover regra "${rule.name}"?`)) return;
          await api(`/api/radar/wishlist/${rule.id}`, { method: 'DELETE' });
          loadRadar();
        }
      }, '✕')
    );
  });

  const wlContainer = $('#wishlist-container');
  if (wlContainer) {
    wlContainer.replaceChildren(...(ruleNodes.length ? ruleNodes : [
      el('div', { class: 'empty-subtle text-xs' }, 'Nenhum desejo cadastrado. Crie um acima para ser alertado quando alguém anunciar!')
    ]));
  }

  // Render matches filtered by currency
  const filteredMatches = matches.filter(m => {
    if (state.radar.currencyFilter && m.currency !== state.radar.currencyFilter) return false;
    return true;
  });

  if ($('#radar-matches-badge')) {
    $('#radar-matches-badge').textContent = `${filteredMatches.length} ${filteredMatches.length === 1 ? 'oportunidade' : 'oportunidades'}`;
  }

  const matchNodes = filteredMatches.map(m => {
    let sprite = pokeStaticSpriteUrl(m.speciesId, m.shiny);
    const currBadge = m.currency === 'DIAMONDS'
      ? el('span', { class: 'tag', style: '--tag:var(--accent-blue)' }, '💎 Diamonds')
      : el('span', { class: 'tag', style: '--tag:var(--accent-mint)' }, '💰 Gold');

    return el('div', { class: 'radar-match-card' },
      sprite ? el('img', { src: sprite, class: 'radar-match-sprite', alt: m.name }) : null,
      el('div', { class: 'radar-match-body' },
        el('div', { class: 'radar-match-top' },
          el('span', { class: 'radar-match-name bold' }, `${m.shiny ? '✨ ' : ''}${m.name}`),
          currBadge,
          el('span', { class: 'radar-match-rule mono text-xs muted' }, `Regra: ${m.ruleName}`)
        ),
        el('div', { class: 'radar-match-stats mono text-xs' },
          el('span', {}, `IV ${m.ivTotal}`),
          el('span', { class: 'muted' }, `Q ${m.quality ? m.quality.toFixed(2) : '—'}`),
          el('span', { class: 'pos bold' }, `${m.currency === 'DIAMONDS' ? '💎' : '$'} ${fmt(m.price)}`)
        )
      ),
      el('button', {
        type: 'button',
        class: 'btn-hardware-subtle small',
        title: 'Ver no Mercado',
        onclick: () => {
          switchTab('mercado');
          $('#mk-text').value = m.name.replace(/\s+Lv\.\d+/i, '').replace(/^✨\s*/, '').replace(/^Shiny\s+/i, '').trim();
          fastSearchMarket();
        }
      }, 'Ver no Mercado ➔')
    );
  });

  const matchesContainer = $('#radar-matches-list');
  if (matchesContainer) {
    matchesContainer.replaceChildren(...(matchNodes.length ? matchNodes : [
      el('div', { class: 'empty-subtle text-xs' }, 'Nenhuma oportunidade encontrada no momento. O radar checa a cada 5 minutos.')
    ]));
  }
}

async function checkRadarNow() {
  const btn = $('#radar-check-now');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🔄 Checando…';
  }
  try {
    const res = await api('/api/radar/check', { method: 'POST' });
    state.radar.matches = res.matches || [];
    renderRadar();
  } catch (err) {
    alert(`Erro ao checar radar: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Checar Agora';
    }
  }
}

async function clearRadar() {
  try {
    await api('/api/radar/clear', { method: 'POST' });
    state.radar.matches = [];
    renderRadar();
  } catch (err) {
    alert(`Erro ao limpar radar: ${err.message}`);
  }
}

async function handleAddWishlistRule(e) {
  e.preventDefault();
  const name = $('#wl-name').value.trim();
  const speciesName = $('#wl-species').value.trim();
  const currency = $('#wl-currency').value;
  const maxPriceRaw = $('#wl-max-price').value.trim();
  const maxPrice = maxPriceRaw ? Number(maxPriceRaw) : undefined;
  const minIv = $('#wl-min-iv').value ? Number($('#wl-min-iv').value) : undefined;
  const minQuality = $('#wl-min-q')?.value ? Number($('#wl-min-q').value) : undefined;
  const shinyOnly = $('#wl-shiny-only').checked;

  let speciesId;
  if (speciesName && state.speciesList?.length) {
    const found = state.speciesList.find(s => s.name.toLowerCase() === speciesName.toLowerCase());
    if (found) speciesId = found.pokeId || found.id;
  }

  try {
    await api('/api/radar/wishlist', {
      method: 'POST',
      body: { name, speciesId, speciesName, currency, maxPrice, minIv, minQuality, shinyOnly }
    });
    $('#wl-name').value = '';
    $('#wl-species').value = '';
    $('#wl-max-price').value = '';
    $('#wl-min-iv').value = '';
    if ($('#wl-min-q')) $('#wl-min-q').value = '';
    $('#wl-shiny-only').checked = false;
    await loadRadar();
  } catch (err) {
    alert(`Erro ao salvar regra: ${err.message}`);
  }
}

// ---------- Bag & Venda de Itens ----------

const CATEGORY_NAMES = {
  loot: 'Loot',
  heal: 'Poção / Cura',
  evolution: 'Pedra Evolutiva',
  stone: 'Pedra Evolutiva',
  stones: 'Pedra Evolutiva',
  held: 'Equipável',
  equipment: 'Equipável',
  ball: 'Pokébola',
  craft: 'Crafting',
  boost: 'Boost',
  item: 'Geral'
};

async function loadBag(fresh = false) {
  const accountId = $('#bag-account')?.value || [...state.accounts.keys()][0] || '';
  if (!accountId) {
    state.bag.items = [];
    renderBag();
    return;
  }
  state.bag.accountId = accountId;
  const countEl = $('#bag-count');
  if (countEl && !state.bag.items.length) {
    countEl.textContent = 'Carregando inventário e mercado…';
  }

  const refreshBtn = $('#bag-refresh-btn');
  if (fresh && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳ Atualizando…';
  }

  try {
    const [bagData, marketData] = await Promise.all([
      api(`/api/accounts/${accountId}/bag${fresh ? '?fresh=1' : ''}`),
      api(`/api/market/items-summary?accountId=${accountId}`).catch(() => ({ summary: {}, mine: [] }))
    ]);

    state.bag.items = Array.isArray(bagData?.items) ? bagData.items : [];
    state.bag.marketSummary = marketData?.summary || {};
    state.bag.myListings = Array.isArray(marketData?.mine) ? marketData.mine : [];
    renderBag();
    renderBagMyListings();
  } catch (err) {
    if (countEl) countEl.textContent = `Erro: ${err.message}`;
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 Atualizar Bag';
    }
  }
}

function bagFilteredItems() {
  const cat = state.bag.categoryFilter;
  const search = (state.bag.search || '').toLowerCase().trim();
  const cats = cat ? cat.split(',').map(c => c.trim()) : [];

  return state.bag.items.filter(item => {
    if (cats.length && !cats.includes(item.category)) return false;
    if (search && !item.name.toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderBag() {
  const items = bagFilteredItems();
  const summary = state.bag.marketSummary || {};
  const selected = state.bag.selected;

  $('#bag-count').textContent = `${items.length} de ${state.bag.items.length} itens na bag`;

  const cards = items.map(item => {
    const isSelected = selected.has(item.key);
    const mkt = summary[item.key];
    const iconUrl = item.icon || '/assets/markitems/pokeball.png';

    const card = el('article', {
      class: `bag-item-card ${isSelected ? 'selected' : ''}`,
      onclick: (e) => {
        if (e.target.tagName === 'INPUT' || e.target.closest('input')) return;
        openItemPricingModal(item);
      }
    },
      el('input', {
        type: 'checkbox',
        checked: isSelected,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => {
          if (e.target.checked) selected.add(item.key);
          else selected.delete(item.key);
          card.classList.toggle('selected', e.target.checked);
          updateBagDock();
        }
      }),
      el('div', { class: 'bag-item-icon-wrap' },
        el('img', {
          src: iconUrl,
          alt: item.name,
          onerror: (e) => { e.target.style.display = 'none'; }
        })
      ),
      el('div', { class: 'bag-item-info' },
        el('div', { class: 'bag-item-name', title: item.name }, item.name),
        el('div', { class: 'bag-item-meta' },
          el('span', { class: 'tag' }, CATEGORY_NAMES[item.category] || item.category),
          el('b', { class: 'mono pos' }, `x${fmt(item.quantity)}`),
          item.npcPrice ? el('span', { class: 'muted mono', title: 'Preço fixo de compra pelo NPC' }, `Piso: $ ${fmt(item.npcPrice)}`) : null
        ),
        el('div', { class: 'bag-item-prices-row mono' },
          mkt?.minGold != null
            ? el('span', { class: 'price-pill-gold', title: `Mediana: $ ${fmt(mkt.medianGold)} · Total à venda: ${fmt(mkt.totalGoldQty)}` }, `Mín: $ ${fmt(mkt.minGold)}`)
            : el('span', { class: 'muted text-xs' }, 'Sem ofertas $'),
          mkt?.minDia != null
            ? el('span', { class: 'price-pill-dia', title: `Mediana: 💎 ${fmt(mkt.medianDia)} · Total à venda: ${fmt(mkt.totalDiaQty)}` }, `💎 ${fmt(mkt.minDia)}`)
            : null
        )
      )
    );

    return card;
  });

  const container = $('#bag-grid');
  if (container) {
    container.replaceChildren(...(cards.length ? cards : [
      el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhum item encontrado na bag desta conta.')
    ]));
  }

  updateBagDock();
}

function updateBagDock() {
  const dock = $('#bag-floating-dock');
  if (!dock) return;
  const selected = state.bag.selected;
  if (!selected.size) {
    dock.classList.add('hidden');
    return;
  }
  dock.classList.remove('hidden');

  const summary = state.bag.marketSummary || {};
  let totalEstGold = 0;

  for (const item of state.bag.items) {
    if (!selected.has(item.key)) continue;
    const mkt = summary[item.key];
    const npcFloor = item.npcPrice || 1;
    let unitPrice = 0;
    if (mkt?.minGold && mkt.minGold > 1) {
      unitPrice = Math.max(npcFloor, mkt.minGold - 1);
    } else {
      unitPrice = Math.max(1, npcFloor * 2);
    }
    totalEstGold += unitPrice * item.quantity;
  }

  $('#bag-dock-text').textContent = `${selected.size} itens marcados · Estimativa: $ ${fmt(totalEstGold)}`;
}

async function executeQuickSell() {
  const selected = state.bag.selected;
  if (!selected.size) return;
  const accountId = state.bag.accountId;
  if (!accountId) return;

  const itemsToSell = [];
  for (const item of state.bag.items) {
    if (selected.has(item.key)) {
      itemsToSell.push({
        kind: item.kind,
        refId: item.refId,
        quantity: item.quantity,
        currency: 'GOLD'
      });
    }
  }

  if (!confirm(`Confirmar Venda Rápida de ${itemsToSell.length} tipos de itens pelo MENOR PREÇO do mercado (- $1)?`)) return;

  const btn = $('#bag-dock-quicksell');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Anunciando no mercado…';
  }

  try {
    const res = await api('/api/market/quick-sell', {
      method: 'POST',
      body: { accountId, items: itemsToSell }
    });

    const success = res.results.filter(r => r.success);
    const failed = res.results.filter(r => !r.success);

    let msg = `✅ ${success.length} itens anunciados com sucesso no mercado!`;
    if (failed.length) {
      msg += `\n⚠️ ${failed.length} falharam: ` + failed.map(f => `${f.name}: ${f.error}`).join('; ');
    }
    alert(msg);

    state.bag.selected.clear();
    await loadBag();
  } catch (err) {
    alert(`Erro na venda rápida: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Venda Rápida (Menor Preço - $1)';
    }
  }
}

function renderBagMyListings() {
  const listings = state.bag.myListings || [];
  $('#bag-my-listings-count').textContent = `${listings.length} ativos`;

  const cards = listings.map(l => {
    const isDia = l.currency === 'DIAMONDS';
    return el('div', { class: 'my-listing-card' },
      el('div', { class: 'my-listing-left' },
        el('div', { class: 'my-listing-info' },
          el('div', { class: 'my-listing-name' }, l.name),
          el('div', { class: 'mono text-xs' },
            `Qtd: `, el('b', {}, fmt(l.quantity)), ` · `,
            el('span', { class: isDia ? 'price-pill-dia' : 'price-pill-gold' }, `${isDia ? '💎' : '$'} ${fmt(l.price)}/un`)
          )
        )
      ),
      el('button', {
        type: 'button',
        class: 'btn-hardware-subtle small',
        title: 'Cancelar anúncio e devolver itens para a bag',
        onclick: async () => {
          if (!confirm(`Cancelar anúncio de ${l.name}?`)) return;
          try {
            await api('/api/market/cancel-item', {
              method: 'POST',
              body: { accountId: state.bag.accountId, listingId: l.id }
            });
            await loadBag();
          } catch (err) {
            alert(`Erro ao cancelar: ${err.message}`);
          }
        }
      }, '✕ Cancelar')
    );
  });

  $('#bag-my-listings-list').replaceChildren(...(cards.length ? cards : [
    el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Você não tem nenhum anúncio de item ativo no mercado.')
  ]));
}

function openItemPricingModal(item) {
  state.bag.activeItem = item;
  const summary = state.bag.marketSummary || {};
  const mkt = summary[item.key] || {};

  $('#item-pricing-name').textContent = item.name;
  $('#item-pricing-cat').textContent = CATEGORY_NAMES[item.category] || item.category;
  $('#item-pricing-owned').textContent = `Na bag: ${fmt(item.quantity)}`;
  $('#item-pricing-npc').textContent = item.npcPrice ? `Piso NPC: $ ${fmt(item.npcPrice)}` : 'Piso NPC: —';

  const iconWrap = $('#item-pricing-icon');
  iconWrap.replaceChildren(el('img', { src: item.icon || '/assets/markitems/pokeball.png', alt: item.name }));

  // Gold quotes
  $('#quote-gold-min').textContent = mkt.minGold != null ? `$ ${fmt(mkt.minGold)}` : '—';
  $('#quote-gold-med').textContent = mkt.medianGold != null ? `$ ${fmt(mkt.medianGold)}` : '—';
  $('#quote-gold-qty').textContent = mkt.totalGoldQty != null ? fmt(mkt.totalGoldQty) : '0';

  const goldDepthContainer = $('#quote-gold-depth');
  if (mkt.goldDepth?.length) {
    goldDepthContainer.replaceChildren(...mkt.goldDepth.map(d => el('div', { class: 'depth-row mono' },
      el('span', {}, `$ ${fmt(d.price)}`),
      el('span', { class: 'muted' }, `x${fmt(d.qty)} (${d.sellers} sel)`)
    )));
  } else {
    goldDepthContainer.replaceChildren(el('div', { class: 'muted text-xs' }, 'Nenhum anúncio em Gold'));
  }

  // Diamonds quotes
  $('#quote-dia-min').textContent = mkt.minDia != null ? `💎 ${fmt(mkt.minDia)}` : '—';
  $('#quote-dia-med').textContent = mkt.medianDia != null ? `💎 ${fmt(mkt.medianDia)}` : '—';
  $('#quote-dia-qty').textContent = mkt.totalDiaQty != null ? fmt(mkt.totalDiaQty) : '0';

  const diaDepthContainer = $('#quote-dia-depth');
  if (mkt.diaDepth?.length) {
    diaDepthContainer.replaceChildren(...mkt.diaDepth.map(d => el('div', { class: 'depth-row mono' },
      el('span', {}, `💎 ${fmt(d.price)}`),
      el('span', { class: 'muted' }, `x${fmt(d.qty)} (${d.sellers} sel)`)
    )));
  } else {
    diaDepthContainer.replaceChildren(el('div', { class: 'muted text-xs' }, 'Nenhum anúncio em 💎'));
  }

  // Form initialization
  const qtyInput = $('#item-pricing-qty');
  qtyInput.max = item.quantity;
  qtyInput.value = item.quantity;

  const currSelect = $('#item-pricing-currency');
  currSelect.value = 'GOLD';

  const priceInput = $('#item-pricing-unit-price');
  const npcFloor = item.npcPrice || 1;
  let defaultPrice = 1;
  if (mkt.minGold && mkt.minGold > 1) {
    defaultPrice = Math.max(npcFloor, mkt.minGold - 1);
  } else if (mkt.minGold === 1) {
    defaultPrice = 1;
  } else {
    defaultPrice = Math.max(1, npcFloor * 2);
  }
  priceInput.value = defaultPrice;

  $('#item-pricing-error').textContent = '';
  updateItemPricingTotals();

  $('#dlg-item-pricing').showModal();
}

function updateItemPricingTotals() {
  const item = state.bag.activeItem;
  if (!item) return;

  const qty = Math.max(1, Math.min(item.quantity, Number($('#item-pricing-qty').value) || 1));
  const price = Math.max(1, Number($('#item-pricing-unit-price').value) || 1);
  const currency = $('#item-pricing-currency').value;

  const gross = qty * price;
  const isDia = currency === 'DIAMONDS';
  const fee = isDia ? 0 : Math.min(1000000, Math.floor(gross * 0.03));
  const net = isDia ? gross : gross - fee;

  $('#item-pricing-total-rev').textContent = `${isDia ? '💎' : '$'} ${fmt(net)} (bruto: ${isDia ? '💎' : '$'} ${fmt(gross)})`;
  $('#item-pricing-fee').textContent = isDia ? 'Isento em Diamantes (0%)' : `$ ${fmt(fee)} (3%)`;
}

async function submitItemListing() {
  const item = state.bag.activeItem;
  if (!item) return;
  const accountId = state.bag.accountId;
  if (!accountId) return;

  const qty = Math.max(1, Math.min(item.quantity, Number($('#item-pricing-qty').value) || 1));
  const price = Math.max(1, Number($('#item-pricing-unit-price').value) || 1);
  const currency = $('#item-pricing-currency').value;

  if (currency === 'GOLD' && item.npcPrice && price < item.npcPrice) {
    $('#item-pricing-error').textContent = `O preço não pode ser menor que o piso do NPC ($ ${fmt(item.npcPrice)}).`;
    return;
  }

  const btn = $('#item-pricing-submit');
  btn.disabled = true;
  btn.textContent = '⏳ Criando Anúncio…';
  $('#item-pricing-error').textContent = '';

  try {
    const res = await api('/api/market/sell-item', {
      method: 'POST',
      body: {
        accountId,
        kind: item.kind,
        refId: item.refId,
        quantity: qty,
        price,
        currency
      }
    });

    if (res.results?.[0]?.success) {
      $('#dlg-item-pricing').close();
      await loadBag();
    } else {
      $('#item-pricing-error').textContent = res.results?.[0]?.error || 'Erro ao criar anúncio.';
    }
  } catch (err) {
    $('#item-pricing-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '📢 Criar Anúncio';
  }
}

// ---------- Rota Automática ----------

async function loadRouteData(force = false) {
  const accountSelect = $('#route-account');
  const accountId = accountSelect?.value || state.route.accountId || [...state.accounts.keys()][0] || '';
  if (!accountId) return;
  state.route.accountId = accountId;

  try {
    const [presetsData, customPresetsData, statusData] = await Promise.all([
      api(`/api/routes/presets?accountId=${encodeURIComponent(accountId)}`),
      api('/api/routes/custom').catch(() => ({ presets: [] })),
      api(`/api/accounts/${encodeURIComponent(accountId)}/route`)
    ]);

    state.route.presets = presetsData.presets || [];
    state.route.customPresets = customPresetsData.presets || [];
    state.route.status = statusData || null;

    renderSavedCustomPresetsDropdown();

    if (statusData && statusData.running) {
      state.route.queue = statusData.queue || [];
      const defaultPreset = (state.route.presets.find(p => p.id === 'unowned_final' && p.count > 0))
        || state.route.presets.find(p => p.id === 'all_unlocked')
        || state.route.presets[0];
      if (defaultPreset) {
        selectRoutePreset(defaultPreset.id);
      }
    }

    renderRoutePresets();
    renderRouteDashboard();
    renderRouteQueue();
    updateRouteBadge();
  } catch (err) {
    console.error('Erro ao carregar rota automática:', err);
  }
}

function renderSavedCustomPresetsDropdown() {
  const select = $('#route-saved-presets');
  if (!select) return;
  const current = select.value;
  const options = (state.route.customPresets || []).map(p => el('option', { value: p.id }, `${p.name} (${p.queue?.length || 0} pokes)`));
  select.replaceChildren(el('option', { value: '' }, '-- Selecione um preset salvo --'), ...options);
  if ([...select.options].some(o => o.value === current)) select.value = current;
}

function selectRoutePreset(presetId) {
  const preset = state.route.presets.find(p => p.id === presetId);
  if (!preset) return;
  state.route.activePresetId = presetId;
  const list = preset.items || preset.route || [];
  state.route.queue = JSON.parse(JSON.stringify(list));
  renderRoutePresets();
  renderRouteQueue();
}

function renderRoutePresets() {
  const container = $('#route-preset-chips');
  if (!container) return;

  const chips = state.route.presets.map(p => {
    const isSelected = state.route.activePresetId === p.id;
    const isRunning = Boolean(state.route.status && state.route.status.running);
    const label = p.title || p.name || p.id;
    return el('button', {
      type: 'button',
      class: `preset-chip ${isSelected ? 'active' : ''}`,
      title: p.description,
      disabled: isRunning,
      onclick: () => selectRoutePreset(p.id)
    },
      label,
      el('span', { class: 'chip-badge' }, `${p.count}`)
    );
  });

  container.replaceChildren(...chips);
}

function renderRouteDashboard() {
  const st = state.route.status;
  const isRunning = Boolean(st && st.running && !st.paused);
  const isPaused = Boolean(st && st.running && st.paused);
  const hasActiveSession = isRunning || isPaused;

  const btnStart = $('#route-btn-start');
  const btnPause = $('#route-btn-pause');
  const btnResume = $('#route-btn-resume');
  const btnSkip = $('#route-btn-skip');
  const btnStop = $('#route-btn-stop');

  if (btnStart) btnStart.hidden = hasActiveSession;
  if (btnPause) btnPause.hidden = !isRunning;
  if (btnResume) btnResume.hidden = !isPaused;
  if (btnSkip) btnSkip.hidden = !hasActiveSession;
  if (btnStop) btnStop.hidden = !hasActiveSession;

  const dashboard = $('#route-active-dashboard');
  if (!dashboard) return;

  if (hasActiveSession) {
    dashboard.classList.remove('hidden');
    dashboard.hidden = false;

    const spriteBox = $('#route-target-sprite-box');
    if (spriteBox) {
      const cur = st.currentTarget;
      if (cur) {
        const gif = pokeSpriteUrl(cur.speciesId);
        const png = pokeStaticSpriteUrl(cur.speciesId);
        spriteBox.replaceChildren(el('img', {
          src: gif,
          alt: cur.name,
          onerror: (e) => { if (png && e.target.src !== png) e.target.src = png; }
        }));
      } else {
        spriteBox.replaceChildren(el('span', { class: 'text-2xl' }, '🏠'));
      }
    }

    const pill = $('#route-status-pill');
    if (pill) {
      pill.className = `route-status-pill ${isRunning ? 'running' : 'paused'}`;
      if (isRunning) pill.textContent = '🎯 CAÇANDO AGORA';
      else if (isPaused) pill.textContent = '⏸️ PAUSADO';
    }

    const homeInd = $('#route-home-indicator');
    if (homeInd) {
      const homeName = st.originalHuntName || st.originalHunt || 'Hunt Atual';
      homeInd.textContent = `🏠 Retorno: ${homeName}`;
    }

    const targetTitle = $('#route-target-title');
    if (targetTitle) {
      if (st.currentTarget) {
        targetTitle.textContent = `${st.currentTarget.name} (Nv. ${st.currentTarget.level || 1})`;
      } else {
        targetTitle.textContent = 'Aguardando próximo Pokémon…';
      }
    }

    const huntSlug = $('#route-target-hunt-slug');
    if (huntSlug) {
      huntSlug.textContent = st.currentTarget ? `Hunt: ${st.currentTarget.slug}` : `Status: Em andamento`;
    }

    const capFill = $('#route-captures-bar-fill');
    const capText = $('#route-captures-text');
    const capCurrent = st.currentCaptures || 0;
    const capTarget = st.targetCapturesPerSpecies || 1;
    const capPct = Math.min(100, Math.round((capCurrent / capTarget) * 100));

    if (capFill) capFill.style.width = `${capPct}%`;
    if (capText) capText.textContent = `${capCurrent} / ${capTarget} capturado(s) nesta hunt`;

    const total = st.totalTargets || st.queue?.length || state.route.queue.length || 0;
    const completed = st.completedTargets ?? 0;
    const overallPct = st.progressPct ?? (total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0);

    const progNum = $('#route-progress-num');
    const progText = $('#route-progress-text');
    if (progNum) progNum.textContent = `${overallPct}%`;
    if (progText) progText.textContent = `${completed} de ${total} concluídos`;
  } else {
    dashboard.classList.add('hidden');
    dashboard.hidden = true;
  }
}

function renderRouteQueue() {
  const container = $('#route-queue-list');
  const countBadge = $('#route-queue-count');
  if (!container) return;

  const queue = (state.route.status && state.route.status.running && state.route.status.queue?.length)
    ? state.route.status.queue
    : state.route.queue;
  const currentIndex = state.route.status?.currentIndex ?? -1;
  const isRunning = Boolean(state.route.status && state.route.status.running);

  if (countBadge) {
    countBadge.textContent = `${queue.length} Pokémon${queue.length === 1 ? '' : 's'}`;
  }

  if (!queue.length) {
    container.replaceChildren(el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhum Pokémon na fila. Selecione um Preset acima para carregar a rota.'));
    return;
  }

  const cards = queue.map((item, idx) => {
    let cardState = 'pending';
    let statusLabel = 'Na Fila';
    if (item.status === 'completed' || (isRunning && idx < currentIndex)) {
      cardState = 'completed';
      statusLabel = '✅ Capturado';
    } else if (item.status === 'hunting' || item.status === 'active' || (isRunning && idx === currentIndex)) {
      cardState = 'active';
      statusLabel = '🎯 Atual';
    } else if (item.status === 'skipped') {
      cardState = 'skipped';
      statusLabel = '⏭️ Pulado';
    }

    const sprite = pokeStaticSpriteUrl(item.speciesId);
    const types = item.types || [];

    return el('div', { class: `route-queue-card ${cardState}` },
      el('div', { class: 'queue-card-index mono' }, `#${idx + 1}`),
      el('div', { class: 'queue-card-sprite' },
        sprite ? el('img', { src: sprite, alt: item.name, loading: 'lazy' }) : null
      ),
      el('div', { class: 'queue-card-info' },
        el('div', { class: 'queue-card-header' },
          el('span', { class: 'queue-card-name' }, item.name),
          el('span', { class: 'queue-card-lvl mono' }, `Nv ${item.level || 1}`)
        ),
        el('div', { class: 'queue-card-meta' },
          el('span', { class: 'queue-card-slug mono' }, item.slug),
          typeBadges(types)
        ),
        el('div', { class: 'queue-card-status-bar' },
          el('span', { class: `status-tag ${cardState}` }, statusLabel),
          item.captures != null && item.captures > 0
            ? el('span', { class: 'mono text-xs muted' }, `${item.captures} capturado(s)`)
            : null
        )
      ),
      !isRunning ? el('div', { class: 'queue-card-actions' },
        idx > 0 ? el('button', {
          type: 'button',
          class: 'btn-hardware-subtle mini',
          title: 'Mover para cima',
          onclick: (e) => { e.stopPropagation(); moveRouteQueueItem(idx, -1); }
        }, '▲') : null,
        idx < queue.length - 1 ? el('button', {
          type: 'button',
          class: 'btn-hardware-subtle mini',
          title: 'Mover para baixo',
          onclick: (e) => { e.stopPropagation(); moveRouteQueueItem(idx, 1); }
        }, '▼') : null,
        el('button', {
          type: 'button',
          class: 'btn-queue-remove',
          title: 'Remover da fila',
          onclick: (e) => {
            e.stopPropagation();
            state.route.queue.splice(idx, 1);
            renderRouteQueue();
          }
        }, '✕')
      ) : null
    );
  });

  container.replaceChildren(...cards);
}

function moveRouteQueueItem(index, dir) {
  const newIdx = index + dir;
  if (newIdx < 0 || newIdx >= state.route.queue.length) return;
  const [item] = state.route.queue.splice(index, 1);
  state.route.queue.splice(newIdx, 0, item);
  renderRouteQueue();
}

function addToCustomQueue(pokeOrSpecies) {
  if (!pokeOrSpecies) return;
  const speciesId = Number(pokeOrSpecies.speciesId || pokeOrSpecies.pokeId || pokeOrSpecies.id);
  const name = pokeOrSpecies.name || `Pokémon #${speciesId}`;
  const slug = toSlug(name);
  state.route.queue.push({
    speciesId,
    name,
    slug,
    level: pokeOrSpecies.level || 1,
    types: pokeOrSpecies.types || (pokeOrSpecies.type1 ? [pokeOrSpecies.type1, pokeOrSpecies.type2].filter(Boolean).map(t => String(t).toLowerCase()) : []),
    target: Number($('#route-target-captures')?.value) || 1,
    targetKills: Number($('#route-target-kills')?.value) || 0,
    captures: 0,
    kills: 0,
    status: 'pending'
  });
  state.route.activePresetId = null;
  renderRoutePresets();
  renderRouteQueue();
}

async function addPokedexMissingToRouteQueue() {
  const accountId = state.route.accountId || $('#route-account').value;
  if (!accountId) return alert('Selecione uma conta.');
  let userPokes = state.collection.items;
  if (!userPokes || !userPokes.length) {
    try {
      const res = await api(`/api/accounts/${encodeURIComponent(accountId)}/pokes`);
      userPokes = res.pokes || [];
    } catch {}
  }
  const ownedSpeciesSet = new Set((userPokes || []).map(p => Number(p.speciesId)).filter(Boolean));
  const allSpecies = state.speciesList?.length ? state.speciesList : [];
  const missing = allSpecies.filter(s => !ownedSpeciesSet.has(Number(s.pokeId)));
  if (!missing.length) {
    return alert('Parabéns! Esta conta já possui todos os Pokémon catalogados!');
  }
  let count = 0;
  for (const m of missing) {
    if (!state.route.queue.some(q => q.speciesId === m.pokeId)) {
      state.route.queue.push({
        speciesId: m.pokeId,
        name: m.name,
        slug: toSlug(m.name),
        level: 1,
        types: [m.type1, m.type2].filter(Boolean).map(t => String(t).toLowerCase()),
        target: Number($('#route-target-captures')?.value) || 1,
        targetKills: Number($('#route-target-kills')?.value) || 0,
        captures: 0,
        kills: 0,
        status: 'pending'
      });
      count++;
    }
  }
  state.route.activePresetId = null;
  renderRoutePresets();
  renderRouteQueue();
  alert(`Adicionados ${count} Pokémon faltantes da Pokédex à fila de rota!`);
}

async function saveCurrentRouteAsPreset() {
  if (!state.route.queue || !state.route.queue.length) {
    return alert('A fila de rota está vazia! Adicione Pokémon antes de salvar como preset.');
  }
  const defaultName = `Preset Rota (${state.route.queue.length} pokes)`;
  const name = prompt('Digite um nome para este preset:', defaultName);
  if (!name || !name.trim()) return;

  const targetCaptures = Number($('#route-target-captures')?.value) || 1;
  const targetKills = Number($('#route-target-kills')?.value) || 0;
  const maxTimeSec = Number($('#route-max-time')?.value) || 300;
  const noKillTimeoutSec = Number($('#route-no-kill-timeout')?.value ?? 60);
  const returnHome = $('#route-return-home')?.checked ?? true;

  try {
    const res = await api('/api/routes/custom', {
      method: 'POST',
      body: {
        name: name.trim(),
        queue: state.route.queue,
        settings: { targetCaptures, targetKills, maxTimeSec, noKillTimeoutSec, returnHome }
      }
    });
    if (res.preset) {
      state.route.customPresets = state.route.customPresets.filter(p => p.id !== res.preset.id);
      state.route.customPresets.push(res.preset);
      renderSavedCustomPresetsDropdown();
      $('#route-saved-presets').value = res.preset.id;
      alert(`Preset "${res.preset.name}" salvo com sucesso!`);
    }
  } catch (err) {
    alert(`Erro ao salvar preset: ${err.message}`);
  }
}

function loadSelectedRoutePreset() {
  const presetId = $('#route-saved-presets')?.value;
  if (!presetId) return alert('Selecione um preset salvo no menu dropdown.');
  const preset = state.route.customPresets.find(p => p.id === presetId);
  if (!preset) return alert('Preset não encontrado.');

  state.route.queue = JSON.parse(JSON.stringify(preset.queue || []));
  state.route.activePresetId = null;

  if (preset.settings) {
    if (preset.settings.targetCaptures && $('#route-target-captures')) $('#route-target-captures').value = String(preset.settings.targetCaptures);
    if (preset.settings.targetKills !== undefined && $('#route-target-kills')) $('#route-target-kills').value = String(preset.settings.targetKills);
    if (preset.settings.maxTimeSec && $('#route-max-time')) $('#route-max-time').value = String(preset.settings.maxTimeSec);
    if (preset.settings.noKillTimeoutSec !== undefined && $('#route-no-kill-timeout')) $('#route-no-kill-timeout').value = String(preset.settings.noKillTimeoutSec);
    if (preset.settings.returnHome !== undefined && $('#route-return-home')) $('#route-return-home').checked = Boolean(preset.settings.returnHome);
  }

  renderRoutePresets();
  renderRouteQueue();
}

async function deleteSelectedRoutePreset() {
  const presetId = $('#route-saved-presets')?.value;
  if (!presetId) return alert('Selecione um preset salvo para excluir.');
  const preset = state.route.customPresets.find(p => p.id === presetId);
  if (!confirm(`Deseja realmente excluir o preset "${preset?.name || presetId}"?`)) return;

  try {
    await api(`/api/routes/custom/${encodeURIComponent(presetId)}`, { method: 'DELETE' });
    state.route.customPresets = state.route.customPresets.filter(p => p.id !== presetId);
    renderSavedCustomPresetsDropdown();
    alert('Preset excluído com sucesso.');
  } catch (err) {
    alert(`Erro ao excluir preset: ${err.message}`);
  }
}

function exportRouteAsJson() {
  const payload = {
    version: 1,
    name: 'Rota Exportada Cockpit',
    queue: state.route.queue,
    settings: {
      targetCaptures: Number($('#route-target-captures')?.value) || 1,
      targetKills: Number($('#route-target-kills')?.value) || 0,
      maxTimeSec: Number($('#route-max-time')?.value) || 300,
      noKillTimeoutSec: Number($('#route-no-kill-timeout')?.value ?? 60),
      returnHome: $('#route-return-home')?.checked ?? true
    }
  };
  const dlg = $('#dlg-route-io');
  if (dlg) {
    $('#route-io-title').textContent = '📤 Exportar Rota (JSON)';
    $('#route-io-desc').textContent = 'Copie o JSON abaixo para salvar ou compartilhar sua rota customizada.';
    $('#route-io-json').value = JSON.stringify(payload, null, 2);
    $('#route-io-submit').hidden = true;
    dlg.showModal();
  }
}

function importRouteFromJson() {
  const dlg = $('#dlg-route-io');
  if (dlg) {
    $('#route-io-title').textContent = '📥 Importar Rota (JSON)';
    $('#route-io-desc').textContent = 'Cole o JSON da rota abaixo e clique em "Aplicar Rota".';
    $('#route-io-json').value = '';
    $('#route-io-submit').hidden = false;
    dlg.showModal();
  }
}

function applyRouteJson() {
  const text = $('#route-io-json')?.value?.trim();
  if (!text) return alert('Cole o JSON da rota.');
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.queue || data.items || []);
    if (!list.length) throw new Error('O JSON não contém uma lista de Pokémon.');

    state.route.queue = list.map(q => ({
      speciesId: Number(q.speciesId || q.pokeId || q.id),
      name: q.name || `Pokémon #${q.speciesId}`,
      slug: q.slug || toSlug(q.name),
      level: q.level || 1,
      types: q.types || [],
      target: Number(q.target || q.targetCaptures) || 1,
      targetKills: Number(q.targetKills) || 0,
      captures: 0,
      kills: 0,
      status: 'pending'
    }));

    if (data.settings) {
      if (data.settings.targetCaptures && $('#route-target-captures')) $('#route-target-captures').value = String(data.settings.targetCaptures);
      if (data.settings.targetKills !== undefined && $('#route-target-kills')) $('#route-target-kills').value = String(data.settings.targetKills);
      if (data.settings.maxTimeSec && $('#route-max-time')) $('#route-max-time').value = String(data.settings.maxTimeSec);
      if (data.settings.noKillTimeoutSec !== undefined && $('#route-no-kill-timeout')) $('#route-no-kill-timeout').value = String(data.settings.noKillTimeoutSec);
      if (data.settings.returnHome !== undefined && $('#route-return-home')) $('#route-return-home').checked = Boolean(data.settings.returnHome);
    }

    state.route.activePresetId = null;
    renderRoutePresets();
    renderRouteQueue();
    $('#dlg-route-io')?.close();
    alert(`Rota com ${state.route.queue.length} Pokémon carregada com sucesso!`);
  } catch (err) {
    alert(`JSON inválido: ${err.message}`);
  }
}

function updateRouteBadge() {
  const badge = $('#route-badge');
  if (!badge) return;
  const st = state.route.status;
  if (st && st.running && !st.paused) {
    badge.textContent = 'Ativa';
    badge.classList.remove('hidden');
    badge.classList.add('running');
  } else if (st && st.running && st.paused) {
    badge.textContent = 'Pausada';
    badge.classList.remove('hidden');
    badge.classList.remove('running');
  } else {
    badge.classList.add('hidden');
  }
}

function handleRouteStatusUpdate(status) {
  if (!status) return;
  if (state.route.accountId && status.accountId !== state.route.accountId) {
    return;
  }

  state.route.status = status;
  if (status.running && status.queue && status.queue.length > 0) {
    state.route.queue = status.queue;
  }

  renderRoutePresets();
  renderRouteDashboard();
  renderRouteQueue();
  updateRouteBadge();
}

async function startAutoRoute() {
  const accountId = state.route.accountId || $('#route-account').value;
  if (!accountId) return alert('Selecione uma conta.');

  const queue = state.route.queue;
  if (!queue || !queue.length) return alert('A fila de rota está vazia. Adicione Pokémon ou selecione um Preset antes de iniciar.');

  const targetPerPoke = Number($('#route-target-captures').value) || 1;
  const targetKills = Number($('#route-target-kills')?.value) || 0;
  const timeoutSec = Number($('#route-max-time').value) || 300;
  const noKillTimeoutSec = Number($('#route-no-kill-timeout')?.value ?? 60);
  const returnToHome = $('#route-return-home').checked;

  try {
    const status = await api(`/api/accounts/${encodeURIComponent(accountId)}/route-start`, {
      method: 'POST',
      body: {
        queue,
        route: queue,
        targetCaptures: targetPerPoke,
        targetPerPoke,
        targetKills,
        maxTimeSec: timeoutSec,
        timeoutSec,
        noKillTimeoutSec,
        maxTimeWithoutKillSec: noKillTimeoutSec,
        returnHome: returnToHome
      }
    });
    handleRouteStatusUpdate(status);
  } catch (err) {
    alert(`Erro ao iniciar rota: ${err.message}`);
  }
}

async function pauseAutoRoute() {
  const accountId = state.route.accountId || $('#route-account').value;
  if (!accountId) return;
  try {
    const status = await api(`/api/accounts/${encodeURIComponent(accountId)}/route-pause`, { method: 'POST', body: {} });
    handleRouteStatusUpdate(status);
  } catch (err) {
    alert(`Erro ao pausar: ${err.message}`);
  }
}

async function resumeAutoRoute() {
  const accountId = state.route.accountId || $('#route-account').value;
  if (!accountId) return;
  try {
    const status = await api(`/api/accounts/${encodeURIComponent(accountId)}/route-resume`, { method: 'POST', body: {} });
    handleRouteStatusUpdate(status);
  } catch (err) {
    alert(`Erro ao continuar: ${err.message}`);
  }
}

async function skipAutoRouteTarget() {
  const accountId = state.route.accountId || $('#route-account').value;
  if (!accountId) return;
  try {
    const status = await api(`/api/accounts/${encodeURIComponent(accountId)}/route-skip`, { method: 'POST', body: {} });
    handleRouteStatusUpdate(status);
  } catch (err) {
    alert(`Erro ao pular: ${err.message}`);
  }
}

async function stopAutoRoute() {
  const accountId = state.route.accountId || $('#route-account').value;
  if (!accountId) return;
  if (!confirm('Deseja parar a rota automática agora? A conta retornará à hunt base configurada.')) return;
  try {
    const status = await api(`/api/accounts/${encodeURIComponent(accountId)}/route-stop`, { method: 'POST', body: {} });
    handleRouteStatusUpdate(status);
  } catch (err) {
    alert(`Erro ao parar rota: ${err.message}`);
  }
}

// ---------- Breeder (Calculadora & Simulador PIW Oficial) ----------

const BREEDER_FREE_BONUSES = [
  { bonus: 0.005, probability: 0.50, label: 'Cenário 1 (+0.005)' },
  { bonus: 0.010, probability: 0.35, label: 'Cenário 2 (+0.010)' },
  { bonus: 0.020, probability: 0.12, label: 'Cenário 3 (+0.020)' },
  { bonus: 0.040, probability: 0.03, label: 'Cenário 4 (+0.040)' }
];

const BREEDER_PHERO_BONUSES = [
  { bonus: 0.150, probability: 0.50, label: 'Cenário 1 (+0.150)' },
  { bonus: 0.200, probability: 0.30, label: 'Cenário 2 (+0.200)' },
  { bonus: 0.250, probability: 0.15, label: 'Cenário 3 (+0.250)' },
  { bonus: 0.300, probability: 0.05, label: 'Cenário 4 (+0.300)' }
];

const BREEDER_QUALITY_CAP = 2.600;

async function loadBreeder(force = false) {
  const accountSelect = $('#breeder-account');
  const accountId = accountSelect?.value || state.breeder.accountId || [...state.accounts.keys()][0] || '';
  if (!accountId) return;
  state.breeder.accountId = accountId;

  // Garante que temos a coleção da conta carregada para o simulador
  if (!state.collection.items?.length || state.collection.accountId !== accountId) {
    try {
      const res = await api(`/api/accounts/${encodeURIComponent(accountId)}/pokes`);
      state.collection.items = res.pokes || [];
      state.collection.accountId = accountId;
    } catch {}
  }

  try {
    const data = await api(`/api/accounts/${encodeURIComponent(accountId)}/breeder`);
    state.breeder.data = data;
    populateBreederSelects();
    updateBreederSimulator();
    renderBreeder();
  } catch (err) {
    console.error('Erro ao carregar dados de breeder:', err);
  }
}

function setBreederView(view) {
  state.breeder.currentView = view;
  for (const btn of document.querySelectorAll('#breeder-subtabs .pill-filter')) {
    btn.classList.toggle('active', btn.dataset.bview === view);
  }
  renderBreeder();
}

function populateBreederSelects() {
  const s1 = $('#breeder-select-p1');
  const s2 = $('#breeder-select-p2');
  if (!s1 || !s2) return;

  const pokes = [...(state.collection.items || [])].sort((a, b) => {
    const n = (a.name || '').localeCompare(b.name || '');
    if (n !== 0) return n;
    return (b.quality || 0) - (a.quality || 0);
  });

  const buildOptions = (selectedId) => {
    const opts = ['<option value="">Selecione um Pokémon da conta...</option>'];
    for (const p of pokes) {
      const q = p.quality != null ? Number(p.quality).toFixed(3) : '1.000';
      const iv = p.ivTotal || 0;
      const sh = p.shiny ? '✨ ' : '';
      const sel = String(p.id) === String(selectedId) ? 'selected' : '';
      opts.push(`<option value="${p.id}" ${sel}>${sh}${p.name} · Q ${q} · IV ${iv} (Nv ${p.level || 1})</option>`);
    }
    return opts.join('');
  };

  const curr1 = state.breeder.sim.parent1Id || s1.value;
  const curr2 = state.breeder.sim.parent2Id || s2.value;

  s1.innerHTML = buildOptions(curr1);
  s2.innerHTML = buildOptions(curr2);
}

function renderBreederSlotDisplay(slotNum, poke, isDonor) {
  const container = $(`#breeder-slot${slotNum}-display`);
  if (!container) return;

  if (!poke) {
    container.innerHTML = `<div class="slot-placeholder">${slotNum === 1 ? 'Escolha um Pokémon no seletor acima' : 'Escolha um parceiro da mesma espécie'}</div>`;
    return;
  }

  const sprite = pokeSpriteUrl(poke.speciesId, poke.shiny);
  const fallback = pokeStaticSpriteUrl(poke.speciesId, poke.shiny);
  const qStr = Number(poke.quality || 1.0).toFixed(3);
  const ivs = {
    hp: poke.ivHp ?? poke.ivs?.hp ?? 0,
    atk: poke.ivAttack ?? poke.ivs?.attack ?? 0,
    def: poke.ivDefense ?? poke.ivs?.defense ?? 0,
    spa: poke.ivSpecialAttack ?? poke.ivs?.specialAttack ?? 0,
    spd: poke.ivSpecialDefense ?? poke.ivs?.specialDefense ?? 0,
    vel: poke.ivSpeed ?? poke.ivs?.speed ?? 0
  };

  const chips = [
    { label: 'HP', val: ivs.hp },
    { label: 'ATK', val: ivs.atk },
    { label: 'DEF', val: ivs.def },
    { label: 'SPA', val: ivs.spa },
    { label: 'SPD', val: ivs.spd },
    { label: 'VEL', val: ivs.vel }
  ].map(c => `
    <div class="slot-iv-chip ${isDonor ? 'donor-highlight' : ''}">
      <span class="iv-name">${c.label}</span>
      <span class="iv-val">${c.val}</span>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="slot-poke-display">
      <img src="${sprite}" alt="${poke.name}" class="slot-poke-sprite" onerror="this.src='${fallback}'">
      <div class="slot-poke-info">
        <div class="slot-poke-name">${poke.shiny ? '✨ ' : ''}${poke.name} <small class="muted mono">Nv ${poke.level || 1}</small></div>
        <div class="slot-poke-stats">
          <span class="mono bold text-amber">Quality: ×${qStr}</span>
          <span class="mono bold text-cyan">IV Total: ${poke.ivTotal || 0}/192</span>
        </div>
        ${isDonor ? '<div class="mono text-xs text-green" style="font-weight:700;">⭐ Doador Oficial de IVs (Maior Quality)</div>' : ''}
        <div class="slot-iv-chips">${chips}</div>
      </div>
    </div>
  `;
}

function updateBreederSimulator() {
  const s1 = $('#breeder-select-p1');
  const s2 = $('#breeder-select-p2');
  const id1 = s1?.value || state.breeder.sim.parent1Id;
  const id2 = s2?.value || state.breeder.sim.parent2Id;
  state.breeder.sim.parent1Id = id1;
  state.breeder.sim.parent2Id = id2;

  const modeRadio = document.querySelector('input[name="breed-mode"]:checked');
  const mode = modeRadio?.value || 'free';
  const doubleStones = Boolean($('#breed-double-stones')?.checked);
  state.breeder.sim.mode = mode;
  state.breeder.sim.doubleStones = doubleStones;

  const pokes = state.collection.items || [];
  const p1 = pokes.find(p => String(p.id) === String(id1));
  const p2 = pokes.find(p => String(p.id) === String(id2));

  const diffEl = $('#breeder-diff-display');
  const compatEl = $('#breeder-compat-status');
  const heartEl = $('#breeder-connector-heart');
  const resultsPanel = $('#breeder-results-panel');
  const statusBadge = $('#breeder-sim-status-badge');

  if (!p1 && !p2) {
    renderBreederSlotDisplay(1, null, false);
    renderBreederSlotDisplay(2, null, false);
    if (diffEl) diffEl.textContent = 'Δ Q: —';
    if (compatEl) { compatEl.textContent = 'Selecione 2 Pokémon'; compatEl.className = 'breeder-compat-badge'; }
    if (heartEl) heartEl.textContent = '🧬';
    if (statusBadge) statusBadge.textContent = 'Aguardando seleção';
    if (resultsPanel) resultsPanel.style.display = 'none';
    return;
  }

  if (p1 && !p2) {
    renderBreederSlotDisplay(1, p1, false);
    renderBreederSlotDisplay(2, null, false);
    if (diffEl) diffEl.textContent = 'Δ Q: —';
    if (compatEl) { compatEl.textContent = 'Selecione o Slot 2 da mesma espécie'; compatEl.className = 'breeder-compat-badge'; }
    if (heartEl) heartEl.textContent = '🧬';
    if (statusBadge) statusBadge.textContent = 'Pai B pendente';
    if (resultsPanel) resultsPanel.style.display = 'none';
    return;
  }

  if (!p1 && p2) {
    renderBreederSlotDisplay(1, null, false);
    renderBreederSlotDisplay(2, p2, false);
    if (diffEl) diffEl.textContent = 'Δ Q: —';
    if (compatEl) { compatEl.textContent = 'Selecione o Slot 1 da mesma espécie'; compatEl.className = 'breeder-compat-badge'; }
    if (heartEl) heartEl.textContent = '🧬';
    if (statusBadge) statusBadge.textContent = 'Pai A pendente';
    if (resultsPanel) resultsPanel.style.display = 'none';
    return;
  }

  // Ambos selecionados: validação das regras oficiais do PIW
  const sameSpecies = (p1.speciesId && p2.speciesId && p1.speciesId === p2.speciesId) ||
    (p1.name && p2.name && p1.name.toLowerCase() === p2.name.toLowerCase());

  const q1 = Math.round((Number(p1.quality) || 1.0) * 1000) / 1000;
  const q2 = Math.round((Number(p2.quality) || 1.0) * 1000) / 1000;
  const diffQ = Math.round(Math.abs(q1 - q2) * 1000) / 1000;

  if (diffEl) diffEl.textContent = `Δ Q: ${diffQ.toFixed(3)}`;

  if (!sameSpecies) {
    renderBreederSlotDisplay(1, p1, false);
    renderBreederSlotDisplay(2, p2, false);
    if (compatEl) {
      compatEl.textContent = '❌ Espécies Diferentes (PIW exige mesma espécie)';
      compatEl.className = 'breeder-compat-badge compat-err';
    }
    if (heartEl) heartEl.textContent = '💔';
    if (statusBadge) statusBadge.textContent = 'Incompatível';
    if (resultsPanel) resultsPanel.style.display = 'none';
    return;
  }

  if (diffQ > 0.150001) {
    renderBreederSlotDisplay(1, p1, false);
    renderBreederSlotDisplay(2, p2, false);
    if (compatEl) {
      compatEl.textContent = `❌ Δ Q (${diffQ.toFixed(3)}) ultrapassa limite de 0.150`;
      compatEl.className = 'breeder-compat-badge compat-err';
    }
    if (heartEl) heartEl.textContent = '⚠️';
    if (statusBadge) statusBadge.textContent = 'Limite Q excedido';
    if (resultsPanel) resultsPanel.style.display = 'none';
    return;
  }

  // 100% COMPATÍVEL!
  const inheritsFromSlot = q2 > q1 ? 2 : 1;
  renderBreederSlotDisplay(1, p1, inheritsFromSlot === 1);
  renderBreederSlotDisplay(2, p2, inheritsFromSlot === 2);

  if (compatEl) {
    compatEl.textContent = '✅ Par 100% Compatível!';
    compatEl.className = 'breeder-compat-badge compat-ok';
  }
  if (heartEl) heartEl.textContent = '💖';
  if (statusBadge) statusBadge.textContent = 'Pronto para Cruza';

  // Executa Projeção Matemática
  const donor = inheritsFromSlot === 2 ? p2 : p1;
  const baseQ = Math.max(q1, q2);
  const bonuses = mode === 'pheromone' ? BREEDER_PHERO_BONUSES : BREEDER_FREE_BONUSES;
  const scenarios = bonuses.map(b => {
    const rawQ = Math.round((baseQ + b.bonus) * 1000) / 1000;
    const finalQ = Math.round(Math.min(rawQ, BREEDER_QUALITY_CAP) * 1000) / 1000;
    const capHit = rawQ > BREEDER_QUALITY_CAP;
    return { ...b, rawQ, finalQ, capHit };
  });

  const qMin = scenarios[0].finalQ;
  const qMax = scenarios[scenarios.length - 1].finalQ;
  const qExp = Math.round(scenarios.reduce((acc, s) => acc + (s.finalQ * s.probability), 0) * 1000) / 1000;

  if (resultsPanel) resultsPanel.style.display = 'flex';

  // 1. Herança de IVs
  const ivInfo = $('#breeder-iv-heritage-info');
  if (ivInfo) {
    ivInfo.innerHTML = `O filhote herda <strong>100% dos IVs do Slot ${inheritsFromSlot} (${donor.name})</strong>, porque possui maior Quality (<strong>Q ${inheritsFromSlot === 1 ? q1.toFixed(3) : q2.toFixed(3)}</strong> vs Q ${inheritsFromSlot === 1 ? q2.toFixed(3) : q1.toFixed(3)}).`;
  }

  const ivStatsGrid = $('#breeder-inherited-stats-grid');
  if (ivStatsGrid) {
    const dIvs = {
      hp: donor.ivHp ?? donor.ivs?.hp ?? 0,
      atk: donor.ivAttack ?? donor.ivs?.attack ?? 0,
      def: donor.ivDefense ?? donor.ivs?.defense ?? 0,
      spa: donor.ivSpecialAttack ?? donor.ivs?.specialAttack ?? 0,
      spd: donor.ivSpecialDefense ?? donor.ivs?.specialDefense ?? 0,
      vel: donor.ivSpeed ?? donor.ivs?.speed ?? 0
    };
    ivStatsGrid.innerHTML = `
      <div class="slot-iv-chips" style="margin-top:6px;">
        <div class="slot-iv-chip donor-highlight"><span class="iv-name">HP</span><span class="iv-val">${dIvs.hp}</span></div>
        <div class="slot-iv-chip donor-highlight"><span class="iv-name">ATK</span><span class="iv-val">${dIvs.atk}</span></div>
        <div class="slot-iv-chip donor-highlight"><span class="iv-name">DEF</span><span class="iv-val">${dIvs.def}</span></div>
        <div class="slot-iv-chip donor-highlight"><span class="iv-name">SPA</span><span class="iv-val">${dIvs.spa}</span></div>
        <div class="slot-iv-chip donor-highlight"><span class="iv-name">SPD</span><span class="iv-val">${dIvs.spd}</span></div>
        <div class="slot-iv-chip donor-highlight"><span class="iv-name">VEL</span><span class="iv-val">${dIvs.vel}</span></div>
      </div>
      <div class="mono bold text-cyan text-xs" style="margin-top:4px;">Total Herdado: ${donor.ivTotal || 0}/192 IVs</div>
    `;
  }

  const warnBox = $('#breeder-heritage-warning');
  if (warnBox) {
    if (inheritsFromSlot === 2 && (p1.ivTotal || 0) > (p2.ivTotal || 0)) {
      warnBox.style.display = 'block';
      warnBox.innerHTML = `⚠️ <strong>Atenção de Estratégia:</strong> O Slot 2 possui maior Quality e substituirá os IVs do Slot 1! O filhote nascerá com IV ${p2.ivTotal || 0} em vez de IV ${p1.ivTotal || 0}. Se você queria os IVs do Slot 1, ele precisaria ter a maior Quality.`;
    } else if (q1 === q2) {
      warnBox.style.display = 'block';
      warnBox.innerHTML = `ℹ️ <strong>Empate de Quality:</strong> Ambos os pais possuem exatamente Q ${q1.toFixed(3)}. Pela regra do jogo, os IVs foram herdados do <strong>Slot 1</strong>.`;
    } else {
      warnBox.style.display = 'none';
    }
  }

  // 2. Projeção de Quality
  if ($('#breeder-res-qmin')) $('#breeder-res-qmin').textContent = qMin.toFixed(3);
  if ($('#breeder-res-qexp')) $('#breeder-res-qexp').textContent = qExp.toFixed(3);
  if ($('#breeder-res-qmax')) $('#breeder-res-qmax').textContent = qMax.toFixed(3);

  const tbody = $('#breeder-scenarios-tbody');
  if (tbody) {
    tbody.innerHTML = scenarios.map((s, idx) => `
      <tr>
        <td class="bold">${s.label}</td>
        <td class="mono">${Math.round(s.probability * 100)}%</td>
        <td class="mono pos bold">+${s.bonus.toFixed(3)}</td>
        <td class="mono bold ${s.capHit ? 'text-amber' : 'text-green'}">Q ${s.finalQ.toFixed(3)}</td>
        <td>${s.capHit ? '<span class="tag" style="--tag:#f59e0b;color:#fde68a;">⚠️ Teto 2.600 Atingido</span>' : '<span class="tag" style="--tag:#22c55e;color:#86efac;">100% Eficaz</span>'}</td>
      </tr>
    `).join('');
  }

  // 3. Custos & Extras
  const costsList = $('#breeder-costs-list');
  if (costsList) {
    const stoneQty = doubleStones ? 40 : 20;
    const pheroQty = mode === 'pheromone' ? 9 : 0;
    costsList.innerHTML = `
      <div class="cost-row"><span>💵 Gold Obrigatório:</span><strong class="mono text-amber">R$ 2.000.000</strong></div>
      <div class="cost-row"><span>💎 Evolution Stones:</span><strong class="mono text-cyan">${stoneQty} Stones</strong></div>
      <div class="cost-row"><span>🧪 Strange Pheromones:</span><strong class="mono ${pheroQty > 0 ? 'text-purple' : 'muted'}">${pheroQty} Pheromones</strong></div>
      ${doubleStones ? '<div class="cost-row" style="background:rgba(6,182,212,0.15);"><span>✨ Double Stones Ativo:</span><strong class="text-cyan mono">5% de chance de +1 IV aleatório</strong></div>' : ''}
    `;
  }

  const shinyBox = $('#breeder-shiny-chance-box');
  if (shinyBox) {
    const hasShiny = Boolean(p1.shiny || p2.shiny);
    shinyBox.innerHTML = hasShiny
      ? '✨ <strong>Filhote 100% Shiny Garantido!</strong> (Um dos pais é Shiny)'
      : '🎲 <strong>5% de chance espontânea</strong> de o ovo chocar Shiny.';
  }
}

function loadBreederPairIntoSim(p1Id, p2Id) {
  const s1 = $('#breeder-select-p1');
  const s2 = $('#breeder-select-p2');
  if (s1) s1.value = p1Id;
  if (s2) s2.value = p2Id;
  state.breeder.sim.parent1Id = p1Id;
  state.breeder.sim.parent2Id = p2Id;
  updateBreederSimulator();

  const card = document.querySelector('.breeder-simulator-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderBreeder() {
  const data = state.breeder.data;
  if (!data) return;

  const s = data.summary || {};
  if ($('#breeder-m-pairs')) $('#breeder-m-pairs').textContent = fmt(s.readyPairsCount || 0);
  if ($('#breeder-m-matrizes')) $('#breeder-m-matrizes').textContent = fmt(s.totalMatrizes || 0);
  if ($('#breeder-m-highq')) $('#breeder-m-highq').textContent = fmt(s.totalHighQ || 0);
  if ($('#breeder-m-near')) $('#breeder-m-near').textContent = fmt(s.nearPairsCount || 0);

  const view = state.breeder.currentView || 'ready';
  const container = $('#breeder-content-list');
  const countBadge = $('#breeder-pairs-count');
  const viewTitle = $('#breeder-view-title');
  if (!container) return;

  if (view === 'ready') {
    if (viewTitle) viewTitle.textContent = '🧬 Pares Compatíveis na Sua Coleção (Prontos)';
    const pairs = data.readyPairs || [];
    if (countBadge) countBadge.textContent = `${pairs.length} pares compatíveis`;

    if (!pairs.length) {
      container.replaceChildren(el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhum par compatível encontrado. Para cruzar no Poke Idle World, você precisa de 2 Pokémon da mesma espécie com diferença de Quality de até 0.150.'));
      return;
    }

    const cards = pairs.map(p => {
      const isPerfect = p.tier === 'PERFEITO';
      const starIcons = '⭐'.repeat(p.stars || 1);
      const donorSlot = p.simFree?.inheritsFromSlot || 1;

      const renderParent = (parent, isD) => el('div', { class: `breeder-parent-box ${isD ? 'donor-box' : ''}` },
        el('img', { src: pokeStaticSpriteUrl(parent.speciesId), class: 'breeder-parent-sprite', alt: parent.name, onerror: e => e.target.style.display = 'none' }),
        el('div', { class: 'breeder-parent-details' },
          el('span', { class: `breeder-parent-role ${isD ? 'role-iv' : 'role-q'}` }, isD ? 'Doador de IV' : 'Parceiro Q'),
          el('span', { class: 'breeder-parent-name' }, `${parent.shiny ? '✨ ' : ''}${parent.name}`),
          el('span', { class: 'mono text-xs muted' }, `IV ${parent.ivTotal} · Q ${parent.quality.toFixed(3)}`)
        )
      );

      return el('div', { class: `breeder-match-card ${isPerfect ? 'is-perfect' : ''}` },
        el('div', { class: 'breeder-card-top' },
          el('div', { class: 'breeder-fam-title' },
            el('span', {}, p.speciesName),
            el('span', { class: 'tag', style: isPerfect ? '--tag:#fcd34d; color:#78350f;' : '--tag:#22c55e; color:#86efac;' }, `${starIcons} ${p.tier}`),
            el('span', { class: 'mono text-xs muted' }, `Δ Q: ${p.diffQuality.toFixed(3)}`)
          ),
          el('button', {
            type: 'button',
            class: 'btn-hardware-action small',
            title: 'Carregar este par diretamente no simulador de bancada',
            onclick: () => loadBreederPairIntoSim(p.parentA.id, p.parentB.id)
          }, '🧪 Testar na Bancada')
        ),
        el('div', { class: 'breeder-parents-row' },
          renderParent(p.parentA, donorSlot === 1),
          el('span', { class: 'breeder-heart' }, '❤️'),
          renderParent(p.parentB, donorSlot === 2)
        ),
        el('div', { class: 'breeder-result-bar' },
          el('span', { class: 'bold' }, '✨ Filhote Esperado:'),
          el('span', { class: 'mono pos bold' }, `IV ${p.simFree?.donorIvTotal || '—'} · Q ~${p.simFree?.expectedQuality?.toFixed(3) || '—'} (Free) / ~${p.simPhero?.expectedQuality?.toFixed(3) || '—'} (Phero)`)
        )
      );
    });

    container.replaceChildren(...cards);

  } else if (view === 'near') {
    if (viewTitle) viewTitle.textContent = '⚠️ Quase Compatíveis (Diferença de Quality > 0.150)';
    const nearPairs = data.nearPairs || [];
    if (countBadge) countBadge.textContent = `${nearPairs.length} pares`;

    if (!nearPairs.length) {
      container.replaceChildren(el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Nenhum par na faixa de 0.151 a 0.350 de diferença de Quality.'));
      return;
    }

    const cards = nearPairs.map(n => el('div', { class: 'breeder-missing-card' },
      el('div', { class: 'breeder-missing-top' },
        el('span', { class: 'bold' }, n.speciesName),
        el('span', { class: 'tag', style: '--tag:#f59e0b; color:#78350f;' }, `Δ Q: ${n.diffQuality.toFixed(3)} (Acima de 0.150)`)
      ),
      el('div', { class: 'breeder-missing-body' },
        el('img', { src: pokeStaticSpriteUrl(n.speciesId), class: 'breeder-parent-sprite', alt: n.speciesName }),
        el('div', { class: 'breeder-parent-details' },
          el('span', { class: 'breeder-parent-name' }, `Pai A (Q ${n.parentA.quality.toFixed(3)}) × Pai B (Q ${n.parentB.quality.toFixed(3)})`),
          el('span', { class: 'text-xs muted' }, n.reason)
        )
      ),
      el('div', { class: 'breeder-missing-actions' },
        el('button', {
          type: 'button',
          class: 'btn-hardware-subtle small',
          title: 'Adicionar espécie à Rota de Caça Automática',
          onclick: () => addSpeciesToRouteQueue(n.speciesId, n.speciesName)
        }, '🧭 Caçar Exemplar Intermediário na Rota')
      )
    ));

    container.replaceChildren(...cards);

  } else if (view === 'solo') {
    if (viewTitle) viewTitle.textContent = '💎 Matrizes Solitárias (Precisam de Parceiro da Mesma Espécie)';
    const soloList = data.soloMatrizes || [];
    if (countBadge) countBadge.textContent = `${soloList.length} matrizes`;

    if (!soloList.length) {
      container.replaceChildren(el('div', { class: 'empty', style: 'grid-column: 1/-1' }, 'Todas as suas matrizes e Pokémon de alta qualidade já possuem companheiros da mesma espécie.'));
      return;
    }

    const cards = soloList.map(s => {
      const p = s.pokemon;
      const sprite = pokeStaticSpriteUrl(p.speciesId);

      return el('div', { class: 'breeder-missing-card' },
        el('div', { class: 'breeder-missing-top' },
          el('span', { class: 'bold' }, `${p.shiny ? '✨ ' : ''}${p.name} (Espécie Única)`),
          el('span', { class: 'tag', style: '--tag:#60a5fa;' }, `PRECISA DE Q ${s.targetQualityMin.toFixed(3)} a ${s.targetQualityMax.toFixed(3)}`)
        ),
        el('div', { class: 'breeder-missing-body' },
          sprite ? el('img', { src: sprite, class: 'breeder-parent-sprite', alt: p.name }) : null,
          el('div', { class: 'breeder-parent-details' },
            el('span', { class: 'breeder-parent-name' }, `Seu exemplar: ${p.name} (IV ${p.ivTotal} · Q ${p.quality.toFixed(3)})`),
            el('span', { class: 'text-xs muted' }, s.reason)
          )
        ),
        el('div', { class: 'breeder-missing-actions' },
          el('button', {
            type: 'button',
            class: 'btn-hardware-action small',
            title: 'Criar regra automática no Radar de Mercado',
            onclick: () => handleAddWishlistFromBreeder({
              familyName: p.name,
              familyId: p.speciesId,
              need: `Q ${s.targetQualityMin.toFixed(3)} - ${s.targetQualityMax.toFixed(3)}`,
              minQuality: s.targetQualityMin
            })
          }, '🎯 Vigiar Parceiro no Mercado'),
          el('button', {
            type: 'button',
            class: 'btn-hardware-subtle small',
            title: 'Adicionar à Rota de Caça Automática',
            onclick: () => addSpeciesToRouteQueue(p.speciesId, p.name)
          }, '🧭 Caçar Parceiro na Rota')
        )
      );
    });

    container.replaceChildren(...cards);
  }
}

async function handleAddWishlistFromBreeder(m) {
  const name = `Breeder: ${m.familyName} (${m.need})`;
  const speciesName = m.familyName;
  const speciesId = m.familyId;
  const minIv = m.minIv || undefined;
  const minQuality = m.minQuality || undefined;

  try {
    await api('/api/radar/wishlist', {
      method: 'POST',
      body: {
        name,
        speciesId,
        speciesName,
        currency: 'GOLD',
        minIv,
        minQuality,
        shinyOnly: false
      }
    });
    alert(`🎯 Regra criada no Radar!\nO Cockpit avisará você assim que um ${m.familyName} com ${m.need} for anunciado no Mercado.`);
    loadRadar();
  } catch (err) {
    alert(`Erro ao criar regra de radar: ${err.message}`);
  }
}

// ---------- Geral ----------

function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tabs button, .tabs-nav button, nav button[data-tab]')) {
    const isThis = button.dataset.tab === tab;
    button.classList.toggle('active', isThis);
    button.classList.toggle('on', isThis);
  }
  for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== `tab-${tab}`;
  if (tab === 'colecao' && $('#col-account').value !== state.collection.accountId) loadCollection();
  if (tab === 'destaques') renderHighlights();
  if (tab === 'mercado') loadCommodityTickers();
  if (tab === 'bag') loadBag();
  if (tab === 'rota') loadRouteData();
  if (tab === 'breeder') loadBreeder();
  if (tab === 'radar') {
    $('#radar-badge')?.classList.add('hidden');
    loadRadar();
  }
}

function fillStaticSelects() {
  const tagOptions = TAG_ORDER.map(t => el('option', { value: t }, TAGS[t].label));
  $('#col-tag').append(...tagOptions.map(o => o.cloneNode(true)), el('option', { value: 'none' }, 'Sem tag'));
  $('#hl-tag').append(...tagOptions.filter(o => ['raro', 'top', 'matriz'].includes(o.value)).map(o => o.cloneNode(true)));
  $('#mk-tag').append(...tagOptions.filter(o => o.value !== 'lixo').map(o => o.cloneNode(true)));
  const typeOptions = Object.entries(TYPE_LABELS).map(([k, v]) => el('option', { value: k }, v));
  $('#col-type').append(...typeOptions.map(o => o.cloneNode(true)));
  $('#mk-element').append(...typeOptions.map(o => o.cloneNode(true)));
}

function connectEvents() {
  const source = new EventSource('/events');
  source.onopen = () => { $('#conn').classList.add('ok'); loadState(); };
  source.onerror = () => $('#conn').classList.remove('ok');
  source.addEventListener('account', e => {
    const a = JSON.parse(e.data);
    state.accounts.set(a.id, a);
    renderAccounts();
  });
  source.addEventListener('removed', e => { state.accounts.delete(JSON.parse(e.data).id); renderAccounts(); });
  source.addEventListener('log', e => { state.logs.unshift(JSON.parse(e.data)); renderLogs(); });
  source.addEventListener('highlight', e => {
    state.highlights.unshift(JSON.parse(e.data));
    if (state.tab === 'destaques') renderHighlights();
    renderTotals();
  });
  source.addEventListener('shiny-encounter', e => {
    const encounter = JSON.parse(e.data);
    state.shinies.unshift(encounter);
    if (state.shinies.length > 100) state.shinies.pop();

    if (encounter.type === 'spawn') {
      playShinySpawnSound();
    } else if (encounter.type === 'kill' || encounter.type === 'capture') {
      playShinyKillSound();
    }

    renderSessionShinies();
    renderTotals();
  });
  source.addEventListener('market-progress', e => {
    const { page, count } = JSON.parse(e.data);
    $('#mk-status').textContent = `Página ${page}: ${fmt(count)} anúncios recebidos…`;
  });
  source.addEventListener('radar', e => {
    const data = JSON.parse(e.data);
    state.radar.matches = data.matches || [];
    renderRadar();
    if (data.newCount > 0) {
      const badge = $('#radar-badge');
      if (badge) {
        badge.textContent = data.newCount;
        badge.classList.remove('hidden');
      }
      playRadarChime();
    }
  });
  source.addEventListener('inventory', e => {
    const data = JSON.parse(e.data);
    if (state.tab === 'bag' && (!data?.accountId || data.accountId === state.bag.accountId)) {
      loadBag();
    }
  });
  source.addEventListener('route-status', e => {
    handleRouteStatusUpdate(JSON.parse(e.data));
  });
}

async function loadState() {
  const data = await api('/api/state');
  state.accounts = new Map(data.accounts.map(a => [a.id, a]));
  state.highlights = data.highlights;
  state.shinies = data.shinies || [];
  state.logs = data.logs;
  state.warnings = data.warnings;
  state.config = data.config;
  if (data.routes && data.routes.length > 0) {
    const currentAcc = state.route.accountId || $('#route-account')?.value || data.accounts[0]?.id;
    const myRoute = data.routes.find(r => r.accountId === currentAcc) || data.routes[0];
    if (myRoute) handleRouteStatusUpdate(myRoute);
  }
  renderAccounts();
  renderLogs();
  renderSessionShinies();
  renderHighlights();
}

function bindUi() {
  for (const button of document.querySelectorAll('.tabs button, .tabs-nav button, nav button[data-tab]')) button.addEventListener('click', () => switchTab(button.dataset.tab));
  $('#add-account').addEventListener('click', () => { $('#add-error').textContent = ''; $('#dlg-add').showModal(); });
  $('#add-submit').addEventListener('click', async event => {
    event.preventDefault();
    const raw = $('#add-token').value.trim();
    let body;
    try { body = raw.startsWith('{') ? JSON.parse(raw) : { refreshToken: raw }; }
    catch { $('#add-error').textContent = 'JSON inválido.'; return; }
    if (!body.refreshToken) { $('#add-error').textContent = 'Cole o refreshToken.'; return; }
    try {
      await api('/api/accounts', { method: 'POST', body: { refreshToken: body.refreshToken, accessToken: body.accessToken } });
      $('#add-token').value = '';
      $('#dlg-add').close();
    } catch (error) { $('#add-error').textContent = error.message; }
  });
  for (const id of ['#col-tag', '#col-type']) $(id).addEventListener('change', renderCollection);
  $('#col-text').addEventListener('input', renderCollection);
  $('#col-account').addEventListener('change', loadCollection);
  $('#col-select-all').addEventListener('click', () => {
    const rows = collectionRows();
    for (const p of rows) {
      if (!(p.team || p.starter || p.locked || p.tags.includes('raro') || p.shiny)) {
        state.collection.selected.add(String(p.id));
      }
    }
    renderCollection();
  });
  $('#col-select-none').addEventListener('click', () => {
    const rows = collectionRows();
    for (const p of rows) state.collection.selected.delete(String(p.id));
    renderCollection();
  });
  $('#col-view-grid')?.addEventListener('click', () => setCollectionView('grid'));
  $('#col-view-table')?.addEventListener('click', () => setCollectionView('table'));
  for (const btn of document.querySelectorAll('#col-quick-filters .pill-filter')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('#col-quick-filters .pill-filter')) b.classList.remove('active');
      btn.classList.add('active');
      $('#col-tag').value = btn.dataset.tag;
      renderCollection();
    });
  }
  $('#dock-sell')?.addEventListener('click', () => {
    if (!state.collection.selected.size) return;
    openSell(state.collection.accountId, new Set(state.collection.selected));
  });
  $('#dock-clear')?.addEventListener('click', () => {
    state.collection.selected.clear();
    const rows = collectionRows();
    updateCollectionCount(rows);
    renderCollection();
  });
  $('#dock-lock')?.addEventListener('click', async () => {
    const ids = [...state.collection.selected];
    if (!ids.length) return;
    for (const pokeId of ids) {
      const p = state.collection.items.find(x => String(x.id) === pokeId);
      if (p) await act(`/api/accounts/${state.collection.accountId}/lock`, { pokeId: p.id, locked: !p.locked });
    }
    await loadCollection();
  });
  $('#col-sell')?.addEventListener('click', () => {
    if (!state.collection.selected.size) return alert('Marque algum Pokémon.');
    openSell(state.collection.accountId, new Set(state.collection.selected));
  });
  for (const id of ['#hl-account', '#hl-tag']) $(id).addEventListener('change', renderHighlights);
  $('#sell-all').addEventListener('click', () => { state.sell.selected = new Set(state.sell.items.map(p => String(p.id))); renderSell(); });
  $('#sell-none').addEventListener('click', () => { state.sell.selected.clear(); renderSell(); });
  $('#sell-confirm').addEventListener('click', async event => {
    event.preventDefault();
    const s = state.sell;
    if (!s.selected.size) { $('#sell-error').textContent = 'Nada marcado.'; return; }
    const button = $('#sell-confirm');
    button.disabled = true;
    try {
      const result = await api(`/api/accounts/${s.accountId}/sell`, { method: 'POST', body: { pokeIds: [...s.selected] } });
      $('#dlg-sell').close();
      const skipped = result.rejected?.length ? ` (${result.rejected.length} protegidos foram ignorados)` : '';
      alert(`Vendidos ${result.sold ?? s.selected.size} por $ ${fmt(result.goldGained)}${skipped}.`);
      if (state.tab === 'colecao') setTimeout(loadCollection, 800);
    } catch (error) {
      $('#sell-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('#sound-toggle')?.addEventListener('click', toggleSound);
  $('#test-sound-btn')?.addEventListener('click', () => {
    getAudioContext();
    playShinySpawnSound();
  });
  $('#theme-btn-dark')?.addEventListener('click', () => applyTheme('dark'));
  $('#theme-btn-light')?.addEventListener('click', () => applyTheme('light'));
  $('#theme-toggle')?.addEventListener('click', () => applyTheme(document.body.classList.contains('light-mode') ? 'dark' : 'light'));
  $('#mk-fast-search')?.addEventListener('click', fastSearchMarket);
  $('#mk-search').addEventListener('click', searchMarket);
  $('#mk-cancel').addEventListener('click', () => act('/api/market/cancel'));
  for (const id of ['#mk-tag', '#mk-element', '#mk-sort', '#mk-currency']) $(id).addEventListener('change', renderMarket);
  for (const id of ['#mk-shiny-only', '#mk-hide-offers', '#mk-bargain-only']) $(id)?.addEventListener('change', renderMarket);
  for (const id of ['#mk-text', '#mk-min-iv', '#mk-min-q', '#mk-max-price']) $(id).addEventListener('input', renderMarket);
  $('#radar-check-now')?.addEventListener('click', checkRadarNow);
  $('#radar-clear-btn')?.addEventListener('click', clearRadar);
  $('#radar-add-form')?.addEventListener('submit', handleAddWishlistRule);
  $('#ticker-refresh-btn')?.addEventListener('click', loadCommodityTickers);
  $('#ticker-diamond')?.addEventListener('click', () => {
    $('#mk-currency').value = 'DIAMONDS';
    renderMarket();
  });
  $('#ticker-pheromone')?.addEventListener('click', () => {
    $('#mk-text').value = 'Strange Pheromone';
    fastSearchMarket();
  });
  setupSpeciesAutocomplete('#mk-text', '#mk-text-dropdown', () => {
    fastSearchMarket();
  });
  setupSpeciesAutocomplete('#wl-species', '#wl-species-dropdown');
  for (const btn of document.querySelectorAll('#radar-currency-filters button')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('#radar-currency-filters button')) b.classList.remove('active');
      btn.classList.add('active');
      state.radar.currencyFilter = btn.dataset.curr || '';
      renderRadar();
    });
  }

  // Bag & Venda de Itens
  $('#bag-account')?.addEventListener('change', () => loadBag(true));
  $('#bag-refresh-btn')?.addEventListener('click', () => loadBag(true));
  $('#bag-refresh-market-btn')?.addEventListener('click', () => loadBag(true));
  $('#bag-search')?.addEventListener('input', (e) => {
    state.bag.search = e.target.value;
    renderBag();
  });
  for (const btn of document.querySelectorAll('#bag-quick-filters .pill-filter')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('#bag-quick-filters .pill-filter')) b.classList.remove('active');
      btn.classList.add('active');
      state.bag.categoryFilter = btn.dataset.cat;
      renderBag();
    });
  }
  $('#bag-select-all')?.addEventListener('click', () => {
    const items = bagFilteredItems();
    for (const item of items) state.bag.selected.add(item.key);
    renderBag();
  });
  $('#bag-select-none')?.addEventListener('click', () => {
    state.bag.selected.clear();
    renderBag();
  });
  $('#bag-dock-quicksell')?.addEventListener('click', executeQuickSell);
  $('#bag-dock-clear')?.addEventListener('click', () => {
    state.bag.selected.clear();
    renderBag();
  });

  // Modal de Precificação / Anúncio
  $('#item-pricing-qty')?.addEventListener('input', updateItemPricingTotals);
  $('#item-pricing-unit-price')?.addEventListener('input', updateItemPricingTotals);
  $('#item-pricing-currency')?.addEventListener('change', (e) => {
    const item = state.bag.activeItem;
    if (item) {
      const summary = state.bag.marketSummary || {};
      const mkt = summary[item.key] || {};
      const isDia = e.target.value === 'DIAMONDS';
      if (isDia) {
        $('#item-pricing-unit-price').value = mkt.minDia || 1;
      } else {
        const npcFloor = item.npcPrice || 1;
        $('#item-pricing-unit-price').value = mkt.minGold && mkt.minGold > 1 ? Math.max(npcFloor, mkt.minGold - 1) : Math.max(1, npcFloor * 2);
      }
    }
    updateItemPricingTotals();
  });

  for (const btn of document.querySelectorAll('.quick-qty-btns button')) {
    btn.addEventListener('click', () => {
      const item = state.bag.activeItem;
      if (!item) return;
      const raw = btn.dataset.qty;
      let qty = 1;
      if (raw === '100%') qty = item.quantity;
      else if (raw === '50%') qty = Math.max(1, Math.floor(item.quantity * 0.5));
      else if (raw === '25%') qty = Math.max(1, Math.floor(item.quantity * 0.25));
      else qty = Math.max(1, Math.min(item.quantity, Number(raw) || 1));
      $('#item-pricing-qty').value = qty;
      updateItemPricingTotals();
    });
  }

  $('#item-btn-undercut')?.addEventListener('click', () => {
    const item = state.bag.activeItem;
    if (!item) return;
    const summary = state.bag.marketSummary || {};
    const mkt = summary[item.key] || {};
    const currency = $('#item-pricing-currency').value;
    if (currency === 'DIAMONDS') {
      $('#item-pricing-unit-price').value = mkt.minDia && mkt.minDia > 1 ? mkt.minDia - 1 : (mkt.minDia || 1);
    } else {
      const npcFloor = item.npcPrice || 1;
      $('#item-pricing-unit-price').value = mkt.minGold && mkt.minGold > 1 ? Math.max(npcFloor, mkt.minGold - 1) : npcFloor;
    }
    updateItemPricingTotals();
  });

  $('#item-btn-match-min')?.addEventListener('click', () => {
    const item = state.bag.activeItem;
    if (!item) return;
    const summary = state.bag.marketSummary || {};
    const mkt = summary[item.key] || {};
    const currency = $('#item-pricing-currency').value;
    if (currency === 'DIAMONDS') {
      $('#item-pricing-unit-price').value = mkt.minDia || 1;
    } else {
      const npcFloor = item.npcPrice || 1;
      $('#item-pricing-unit-price').value = mkt.minGold || npcFloor;
    }
    updateItemPricingTotals();
  });

  $('#item-btn-median')?.addEventListener('click', () => {
    const item = state.bag.activeItem;
    if (!item) return;
    const summary = state.bag.marketSummary || {};
    const mkt = summary[item.key] || {};
    const currency = $('#item-pricing-currency').value;
    if (currency === 'DIAMONDS') {
      $('#item-pricing-unit-price').value = mkt.medianDia || mkt.minDia || 1;
    } else {
      const npcFloor = item.npcPrice || 1;
      $('#item-pricing-unit-price').value = mkt.medianGold || (mkt.minGold || npcFloor * 2);
    }
    updateItemPricingTotals();
  });

  $('#item-pricing-submit')?.addEventListener('click', submitItemListing);

  // Rota Automática
  $('#route-account')?.addEventListener('change', () => loadRouteData(true));
  $('#route-btn-start')?.addEventListener('click', startAutoRoute);
  $('#route-btn-pause')?.addEventListener('click', pauseAutoRoute);
  $('#route-btn-resume')?.addEventListener('click', resumeAutoRoute);
  $('#route-btn-skip')?.addEventListener('click', skipAutoRouteTarget);
  $('#route-btn-stop')?.addEventListener('click', stopAutoRoute);
  $('#route-clear-queue-btn')?.addEventListener('click', () => {
    state.route.queue = [];
    renderRouteQueue();
  });
  $('#route-add-poke-btn')?.addEventListener('click', () => {
    const rawVal = $('#route-add-search')?.value?.trim();
    if (!rawVal) return;

    const lines = rawVal.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    let addedCount = 0;
    const notFound = [];

    for (const line of lines) {
      if (line.toLowerCase().includes('todos os tipos') || line.toLowerCase().includes('buscar por')) continue;
      if (line === '🔒' || line === '🔓') continue;

      const found = findSpeciesInCatalog(line);
      if (found) {
        addToCustomQueue(found);
        addedCount++;
      } else {
        notFound.push(line);
      }
    }

    if (addedCount > 0) {
      $('#route-add-search').value = '';
      if (notFound.length > 0) {
        alert(`Adicionados ${addedCount} Pokémon à fila. Não encontrados (${notFound.length}): ${notFound.slice(0, 5).join(', ')}`);
      }
    } else {
      alert(`Nenhum Pokémon encontrado no catálogo para: "${rawVal}"`);
    }
  });
  $('#route-add-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#route-add-poke-btn')?.click();
    }
  });
  $('#route-save-preset-btn')?.addEventListener('click', saveCurrentRouteAsPreset);
  $('#route-load-preset-btn')?.addEventListener('click', loadSelectedRoutePreset);
  $('#route-delete-preset-btn')?.addEventListener('click', deleteSelectedRoutePreset);
  $('#route-export-preset-btn')?.addEventListener('click', exportRouteAsJson);
  $('#route-import-preset-btn')?.addEventListener('click', importRouteFromJson);
  $('#route-io-submit')?.addEventListener('click', applyRouteJson);

  // Breeder (Calculadora & Bancada)
  $('#breeder-account')?.addEventListener('change', () => loadBreeder(true));
  $('#breeder-btn-refresh')?.addEventListener('click', () => loadBreeder(true));
  $('#breeder-select-p1')?.addEventListener('change', updateBreederSimulator);
  $('#breeder-select-p2')?.addEventListener('change', updateBreederSimulator);
  document.querySelectorAll('input[name="breed-mode"]').forEach(r => r.addEventListener('change', updateBreederSimulator));
  $('#breed-double-stones')?.addEventListener('change', updateBreederSimulator);

  $('#breeder-swap-parents-btn')?.addEventListener('click', () => {
    const s1 = $('#breeder-select-p1');
    const s2 = $('#breeder-select-p2');
    if (!s1 || !s2) return;
    const v1 = s1.value;
    const v2 = s2.value;
    s1.value = v2;
    s2.value = v1;
    updateBreederSimulator();
  });

  $('#breeder-clear-sim-btn')?.addEventListener('click', () => {
    const s1 = $('#breeder-select-p1');
    const s2 = $('#breeder-select-p2');
    if (s1) s1.value = '';
    if (s2) s2.value = '';
    state.breeder.sim.parent1Id = null;
    state.breeder.sim.parent2Id = null;
    updateBreederSimulator();
  });

  for (const btn of document.querySelectorAll('#breeder-subtabs .pill-filter')) {
    btn.addEventListener('click', () => setBreederView(btn.dataset.bview));
  }

  setInterval(renderAccounts, 5000);
}

initTheme();
updateSoundToggleUi();
setupAudioUnlock();
fillStaticSelects();
bindUi();
connectEvents();
loadSpeciesCatalog();
loadRadar();
loadCommodityTickers();
setInterval(loadCommodityTickers, 60000);



