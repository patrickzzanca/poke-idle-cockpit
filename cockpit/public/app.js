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
  market: { rawResults: [], accountId: '', lastMeta: null }
};

const $ = sel => document.querySelector(sel);
const fmt = n => n == null ? '—' : n === Infinity ? '∞' : Number(n).toLocaleString('pt-BR');
const time = at => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

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
  if (a.status !== 'online') return STATUS[a.status] ?? [a.status, 'warn'];
  if (a.lastKillAt && Date.now() - a.lastKillAt < 120000) return [`Online`, 'ok'];
  return [a.lastKillAt ? `Online · sem kill` : 'Online', 'warn'];
}

function sessionVisor(z, a) {
  const capturesPerHour = z?.seconds > 60 && z.captures > 0 ? (z.captures / z.seconds) * 3600 : 0;
  const isOnline = a.status === 'online';
  return el('div', { class: 'session-visor' },
    el('div', { class: 'session-visor-top' },
      el('div', { class: 'session-visor-title' },
        el('span', { class: `session-visor-dot ${isOnline ? 'active' : 'idle'}` }),
        el('span', { class: 'mono' }, 'VISOR DE SESSÃO'),
        a.hunt ? el('span', { class: 'session-visor-hunt' }, `· ${a.hunt}`) : null
      ),
      el('span', { class: 'session-visor-xp mono' }, z?.xpPerHour ? `✨ ${fmt(z.xpPerHour)} XP/h` : '')
    ),
    el('div', { class: 'session-visor-grid' },
      el('div', { class: 'session-cell' },
        el('span', { class: 'session-cell-label' }, '⏱️ Duração'),
        el('span', { class: 'session-cell-val mono' }, duration(z?.seconds || 0)),
        el('span', { class: 'session-cell-sub mono' }, isOnline ? (z?.seconds > 0 ? 'sessão ativa' : 'iniciando…') : 'pausada')
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

async function setDirectHunt(accountId, slug, name) {
  if (!slug) return;
  if (!confirm(`Trocar a hunt da conta para "${name || slug}"?`)) return;
  await act(`/api/accounts/${accountId}/hunt`, { slug: slug.trim(), name: name ? name.trim() : slug.trim() });
}

function smartHunterVisor(a) {
  const rec = a.recommendation;
  const leader = a.leader;
  if (!leader) return null;

  const currentHuntNorm = (a.hunt || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!rec || (!rec.gold && !rec.xp)) {
    return el('div', { class: 'smart-hunter-visor loading' },
      el('div', { class: 'smart-hunter-header' },
        el('div', { class: 'smart-hunter-title-row' },
          el('span', { class: 'smart-hunter-icon' }, '🎯'),
          el('span', { class: 'mono bold' }, 'SMART HUNTER'),
          el('span', { class: 'smart-hunter-meta-badge' }, 'Piwdex')
        ),
        el('span', { class: 'smart-hunter-status mono muted' }, rec?.error ? 'Falha ao consultar Piwdex' : 'Calculando rota ideal…')
      )
    );
  }

  const gold = rec.gold;
  const xp = rec.xp;
  const isGoldActive = gold && currentHuntNorm && (currentHuntNorm === gold.slug.toLowerCase().replace(/[^a-z0-9]/g, '') || currentHuntNorm === gold.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const isXpActive = xp && currentHuntNorm && (currentHuntNorm === xp.slug.toLowerCase().replace(/[^a-z0-9]/g, '') || currentHuntNorm === xp.name.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const renderOption = (type, title, spot, isActive) => {
    if (!spot) return null;
    return el('div', { class: `hunter-option-card ${isActive ? 'active' : ''}` },
      el('div', { class: 'hunter-option-top' },
        el('span', { class: `hunter-option-badge ${type}` }, title),
        isActive ? el('span', { class: 'hunter-active-badge mono' }, '✓ Hunt Atual') : null
      ),
      el('div', { class: 'hunter-option-body' },
        el('div', { class: 'hunter-spot-info' },
          el('b', { class: 'hunter-spot-name' }, spot.name),
          el('span', { class: 'hunter-spot-lvl muted mono' }, ` Nv ${spot.level}`)
        ),
        el('div', { class: 'hunter-spot-metrics mono' },
          type === 'gold'
            ? [
                el('span', { class: 'pos bold' }, `$ ${fmt(spot.goldPerHour)}/h`),
                el('span', { class: 'muted text-xs' }, ` · ${fmt(spot.xpHour)} XP/h`)
              ]
            : [
                el('span', { class: 'accent bold' }, `${fmt(spot.xpHour)} XP/h`),
                el('span', { class: 'muted text-xs' }, ` · $ ${fmt(spot.goldPerHour)}/h`)
              ]
        )
      ),
      !isActive ? el('button', {
        class: 'btn-hardware-subtle hunter-switch-btn',
        title: `Mudar para ${spot.name}`,
        onclick: () => setDirectHunt(a.id, spot.slug, spot.name)
      }, `Ir para ${spot.name} ➔`) : null
    );
  };

  return el('div', { class: 'smart-hunter-visor' },
    el('div', { class: 'smart-hunter-header' },
      el('div', { class: 'smart-hunter-title-row' },
        el('span', { class: 'smart-hunter-icon' }, '🎯'),
        el('span', { class: 'mono bold' }, 'SMART HUNTER'),
        el('span', { class: 'smart-hunter-meta-badge' }, 'Piwdex'),
        rec.leader?.name ? el('span', { class: 'smart-hunter-target-poke mono muted' }, `(${rec.leader.name} Nv ${rec.leader.level})`) : null
      ),
      el('button', {
        class: 'btn-icon-subtle',
        style: 'font-size:11px; padding:2px 4px; cursor:pointer;',
        title: 'Recalcular no Piwdex',
        onclick: async (e) => {
          e.target.textContent = '⏳';
          try {
            await act(`/api/accounts/${a.id}/recommendation`);
          } finally {
            e.target.textContent = '🔄';
          }
        }
      }, '🔄')
    ),
    el('div', { class: 'smart-hunter-grid' },
      renderOption('gold', '💰 Máx Dólares', gold, isGoldActive),
      renderOption('xp', '⚡ Mais XP', xp, isXpActive)
    )
  );
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
    smartHunterVisor(a),
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
      el('span', { class: 'muted mono', style: 'font-size:11px' }, a.lastKillAt ? `Último kill há ${ago(a.lastKillAt)}` : (a.status === 'online' ? 'Sessão ativa · aguardando kill' : 'Conta pausada')),
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
  for (const [sel, allowAll] of [['#col-account', false], ['#hl-account', true], ['#mk-account', false]]) {
    const select = $(sel);
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
        el('span', {}, `${p.shiny ? '✨ ' : ''}${p.name}`, p.team ? el('span', { class: 'muted' }, ' (time)') : null)
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

  // Pokedex Grid Mode
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
        p.sellValue != null ? el('span', { class: 'muted mono' }, `$ ${fmt(p.sellValue)}`) : null
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
  $('#col-count').textContent = `${rows.length} de ${state.collection.items.length} · ${selected.length} selecionados ($ ${fmt(gold)})`;

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
  const tagFilter = $('#mk-tag').value;
  const elementFilter = $('#mk-element').value;
  const sortBy = $('#mk-sort').value;

  const filtered = rawResults.filter(item => {
    if (query && !item.name.toLowerCase().includes(query) && !item.comparison?.myBest?.name?.toLowerCase().includes(query)) return false;
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
    let badgeText = '';
    let badgeColor = '';
    if (item.comparison?.isUpgrade) {
      badgeText = 'Upgrade';
      badgeColor = 'var(--accent-mint)';
    } else if (item.isNewSpecies) {
      badgeText = 'Novo na Bag';
      badgeColor = 'var(--accent-blue)';
    }

    return el('article', { class: 'market-card' },
      el('div', { class: 'market-header' },
        spriteNode,
        el('div', { class: 'market-title' },
          el('div', { class: 'market-name' }, `${item.shiny ? '✨ ' : ''}${item.name}${item.level ? ` Nv ${fmt(item.level)}` : ''}`),
          item.listingId ? el('div', { class: 'market-sub-seller' }, `Anúncio #${item.listingId}${item.seller ? ` · ${item.seller}` : ''}`) : null,
          el('div', { style: 'margin-top:3px' }, typeBadges(item.types), tagBadges(item.tags, item.reasons))
        ),
        el('div', { class: 'market-price-box' },
          el('div', { class: 'market-price mono' }, priceText),
          badgeText ? el('span', { class: 'market-badge mono', style: `color:${badgeColor}` }, badgeText) : null
        )
      ),
      splitNode
    );
  }));
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
}

async function loadState() {
  const data = await api('/api/state');
  state.accounts = new Map(data.accounts.map(a => [a.id, a]));
  state.highlights = data.highlights;
  state.shinies = data.shinies || [];
  state.logs = data.logs;
  state.warnings = data.warnings;
  state.config = data.config;
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
  $('#mk-search').addEventListener('click', searchMarket);
  $('#mk-cancel').addEventListener('click', () => act('/api/market/cancel'));
  for (const id of ['#mk-tag', '#mk-element', '#mk-sort', '#mk-currency']) $(id).addEventListener('change', renderMarket);
  for (const id of ['#mk-shiny-only', '#mk-hide-offers']) $(id).addEventListener('change', renderMarket);
  for (const id of ['#mk-text', '#mk-min-iv', '#mk-min-q', '#mk-max-price']) $(id).addEventListener('input', renderMarket);
  setInterval(renderAccounts, 5000);
}

initTheme();
updateSoundToggleUi();
setupAudioUnlock();
fillStaticSelects();
bindUi();
connectEvents();

