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
  accounts: new Map(), highlights: [], logs: [], warnings: [], config: null, tab: 'contas',
  collection: { accountId: '', items: [], sort: 'ivTotal', dir: -1, selected: new Set() },
  sell: { accountId: '', items: [], selected: new Set() }
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

// ---------- Contas ----------

function renderTotals() {
  const list = [...state.accounts.values()];
  const online = list.filter(a => a.status === 'online').length;
  const hunting = list.filter(a => a.status === 'online' && a.lastKillAt && Date.now() - a.lastKillAt < 120000).length;
  const sum = key => list.reduce((s, a) => s + (Number(a[key]) || 0), 0);
  const profitPerHour = list.reduce((s, a) => s + (a.analyzer?.profitPerHour || 0), 0);
  const metric = (label, value) => el('div', { class: 'metric' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
  $('#totals').replaceChildren(
    metric('Caçando / online', `${hunting} / ${online} / ${list.length}`),
    metric('Gold total', `$ ${fmt(sum('gold'))}`),
    metric('Lucro/h somado', `${profitPerHour >= 0 ? '+' : '−'}$ ${fmt(Math.abs(profitPerHour))}`),
    metric('Diamantes', fmt(sum('diamonds'))),
    metric('Lixo na caixa', fmt(sum('junkCount'))),
    metric('Destaques', fmt(state.highlights.length))
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
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function huntingStatus(a) {
  if (a.status !== 'online') return STATUS[a.status] ?? [a.status, 'warn'];
  if (a.lastKillAt && Date.now() - a.lastKillAt < 120000) return [`⚔️ Caçando · kill há ${ago(a.lastKillAt)}`, 'ok'];
  return [a.lastKillAt ? `Online · sem kill há ${ago(a.lastKillAt)}` : 'Online · sem kills ainda', 'warn'];
}

function analyzerBlock(z) {
  if (!z) return el('div', { class: 'muted' }, '📊 Estatísticas ainda não chegaram');
  const profitClass = z.profitPerHour >= 0 ? 'pos' : 'neg';
  return el('div', { class: 'analyzer' },
    el('div', { class: 'row muted' }, el('span', {}, `📊 Sessão de ${duration(z.seconds)}`),
      el('span', {}, `${fmt(z.kills)} kills · ${fmt(z.captures)} capturas${z.shinyCaptures ? ` (✨${z.shinyCaptures})` : ''}`)),
    el('div', { class: 'rates' },
      el('span', { class: profitClass, title: `Loot $ ${fmt(z.lootGold)} · gasto $ ${fmt(z.supplyGold)} · saldo $ ${fmt(z.profit)}` },
        `${z.profitPerHour >= 0 ? '📈 +' : '📉 −'}$ ${fmt(Math.abs(z.profitPerHour))}/h`),
      el('span', {}, `✨ ${fmt(z.xpPerHour)} XP/h`),
      el('span', {}, `⚔️ ${fmt(z.killsPerHour)}/h`)));
}

function renderAccountCard(a) {
  const [statusText, statusKind] = huntingStatus(a);
  const cooldown = a.cooldownUntil && a.cooldownUntil > Date.now() ? ` · cooldown ${Math.ceil((a.cooldownUntil - Date.now()) / 1000)}s` : '';
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
    el('button', { class: 'small', onclick: () => openCollection(a.id) }, '📋 Coleção'),
    el('button', { class: 'small', onclick: () => openSell(a.id) }, `🗑 Lixo (${fmt(a.junkCount)})`),
    el('button', { class: 'small', onclick: () => openSession(a.id) }, '🌐 Abrir sessão')
  ];
  if (['replaced', 'error', 'offline', 'handedOff'].includes(a.status)) {
    actions.push(el('button', { class: 'small', onclick: () => act(`/api/accounts/${a.id}/reconnect`) }, '🔌 Reconectar'));
  }
  actions.push(el('button', { class: 'small', title: 'Remover do cockpit', onclick: () => removeAccount(a) }, '✕'));

  return el('article', { class: 'card' },
    el('div', { class: 'card-col' },
      el('div', { class: 'row' },
        el('span', { class: 'name' }, a.trainer?.name ?? a.name, el('span', { class: 'muted' }, a.trainer?.level != null ? ` · Nv ${a.trainer.level}` : '')),
        el('span', { class: `pill ${statusKind}`, title: a.error ?? '' }, statusText + cooldown)),
      el('div', { class: 'muted' }, a.hunt ? `📍 ${a.hunt}` : '📍 Fora de hunt: abra a sessão e entre numa hunt'),
      leader ? el('div', { class: 'leader' },
        el('div', { class: 'avatar' }, (leader.name ?? '?').slice(0, 2).toUpperCase()),
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { class: 'row' },
            el('span', {}, `${leader.shiny ? '✨ ' : ''}${leader.name} Nv ${fmt(leader.level)}`),
            el('span', { class: 'muted' }, `Q ${leader.quality != null ? Number(leader.quality).toFixed(2) : '—'} · IV ${fmt(leader.ivTotal)}`)),
          leader.maxHp ? bar(leader.hp / leader.maxHp, leader.hp / leader.maxHp < 0.3 ? 'bad' : 'ok') : el('div', {}, typeBadges(leader.types))))
        : el('div', { class: 'leader muted' }, 'Líder ainda não carregado')),
    el('div', { class: 'card-col' },
      analyzerBlock(a.analyzer),
      el('div', {},
        el('div', { class: 'row muted' },
          el('span', {}, box ? `Caixa ${fmt(box.count)} / ${fmt(box.capacity)}${boxTime ? ` · cheia em ~${boxTime}` : ''}` : 'Caixa —'),
          el('span', {}, a.junkRecent ? `+${a.junkRecent} lixo em 2 h` : '')),
        bar(boxRatio, boxRatio >= 1 ? 'bad' : boxRatio >= limits.boxRatio ? 'warn' : 'ok')),
      el('div', { class: 'card-actions' }, actions)),
    el('div', { class: 'stats' },
      el('span', {}, `💲 ${fmt(a.gold)}`),
      el('span', {}, `💎 ${fmt(a.diamonds)}`),
      s ? supplyLine(`🔴 ${s.ball?.name ?? 'Pokébolas'}`, activeBalls, limits.ballsMin, ballsTime ? ` (~${ballsTime})` : '') : el('span', { class: 'muted' }, '🔴 Pokébolas: —'),
      s ? supplyLine(`🧪 ${s.potion?.name ?? 'Poções'}`, s.potion ? s.potion.quantity : s.potionsTotal, limits.potionsMin) : el('span', { class: 'muted' }, '🧪 Poções: —'),
      s?.revives != null ? supplyLine('💊 Revives', s.revives, limits.potionsMin) : null,
      s ? el('span', { class: 'muted wide' }, `Auto: ${[s.autoCatch && 'captura', s.autoPotion && 'poção', s.autoRevive && 'revive'].filter(Boolean).join(', ') || 'desligado'}`) : null,
      a.sessionExpiresAt ? el('span', { class: 'muted wide' }, `🔑 Sessão até ${new Date(a.sessionExpiresAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`) : null),
    a.alerts?.length ? el('div', { class: 'alerts' }, a.alerts.map(al => el('div', { class: `alert ${al.level}` }, al.text))) : null
  );
}

function renderAccounts() {
  const list = [...state.accounts.values()];
  $('#accounts').replaceChildren(...(list.length ? list.map(renderAccountCard)
    : [el('div', { class: 'empty' }, 'Nenhuma conta ainda. Clique em “+ Conta”.')]));
  $('#warnings').replaceChildren(...state.warnings.map(w => el('div', { class: 'warning' }, w)));
  renderTotals();
  refreshAccountSelects();
}

function renderLogs() {
  $('#logs').replaceChildren(...state.logs.slice(0, 100).map(l =>
    el('li', {}, el('time', {}, time(l.at)), l.accountName ? `${l.accountName}: ` : '', l.text)));
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
    return el('tr', { class: prot ? 'protected' : '' },
      el('td', {}, el('input', {
        type: 'checkbox', disabled: prot || p.tags.includes('raro') || p.shiny, checked: selected.has(String(p.id)),
        onchange: e => { e.target.checked ? selected.add(String(p.id)) : selected.delete(String(p.id)); updateCollectionCount(rows); }
      })),
      el('td', {}, `${p.shiny ? '✨ ' : ''}${p.name}`, p.team ? el('span', { class: 'muted' }, ' (time)') : null),
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
  updateCollectionCount(rows);
}

function updateCollectionCount(rows) {
  const selected = state.collection.items.filter(p => state.collection.selected.has(String(p.id)));
  const gold = selected.reduce((s, p) => s + (p.sellValue ?? 0), 0);
  $('#col-count').textContent = `${rows.length} de ${state.collection.items.length} · ${selected.length} selecionados ($ ${fmt(gold)})`;
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
  $('#highlights').replaceChildren(...(list.length ? list.slice(0, 300).map(h => el('li', {},
    el('time', {}, time(h.at)),
    el('b', {}, h.accountName),
    el('span', { class: h.poke.shiny ? 'shiny' : '' }, `${h.poke.shiny ? '✨ ' : ''}${h.poke.name} Nv ${fmt(h.poke.level)}`),
    el('span', { class: 'muted' }, `IV ${fmt(h.poke.ivTotal)} · Q ${h.poke.quality?.toFixed(2) ?? '—'}`),
    typeBadges(h.poke.profile?.types),
    tagBadges(h.poke.tags, h.poke.reasons)))
    : [el('li', { class: 'muted' }, 'Nenhuma captura boa desde que o cockpit abriu. O lixo é só contado.')]));
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
    $('#mk-status').textContent = `${fmt(data.total)} anúncios lidos em ${data.pages} página(s), ${fmt(data.results.length)} com tag. ${data.complete ? 'Busca completa.' : 'Cobertura não confirmada.'} ${data.reason}`;
    $('#mk-results').replaceChildren(...data.results.map(item => el('article', { class: 'listing' },
      el('b', {}, `${item.shiny ? '✨ ' : ''}${item.name}`),
      el('span', { class: 'muted' }, `IV ${item.ivTotal} · Q ${item.quality.toFixed(2)} · Nv ${fmt(item.level)} · ${item.offerOnly ? 'Só oferta' : `${item.currency === 'DIAMONDS' ? '💎' : '$'} ${fmt(item.price)}`}`),
      el('div', {}, typeBadges(item.types), tagBadges(item.tags, item.reasons)),
      item.listingId ? el('small', { class: 'muted' }, `Anúncio ${item.listingId}`) : null)));
  } catch (error) {
    $('#mk-status').textContent = error.message;
  } finally {
    $('#mk-search').disabled = false;
    $('#mk-cancel').hidden = true;
  }
}

// ---------- Geral ----------

function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tabs button')) button.classList.toggle('on', button.dataset.tab === tab);
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
  source.addEventListener('market-progress', e => {
    const { page, count } = JSON.parse(e.data);
    $('#mk-status').textContent = `Página ${page}: ${fmt(count)} anúncios recebidos…`;
  });
}

async function loadState() {
  const data = await api('/api/state');
  state.accounts = new Map(data.accounts.map(a => [a.id, a]));
  state.highlights = data.highlights;
  state.logs = data.logs;
  state.warnings = data.warnings;
  state.config = data.config;
  renderAccounts();
  renderLogs();
  renderHighlights();
}

function bindUi() {
  for (const button of document.querySelectorAll('.tabs button')) button.addEventListener('click', () => switchTab(button.dataset.tab));
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
  $('#col-sell').addEventListener('click', () => {
    if (!state.collection.selected.size) return alert('Marque algum Pokémon na tabela.');
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
  $('#mk-search').addEventListener('click', searchMarket);
  $('#mk-cancel').addEventListener('click', () => act('/api/market/cancel'));
  setInterval(renderAccounts, 5000);
}

fillStaticSelects();
bindUi();
connectEvents();
