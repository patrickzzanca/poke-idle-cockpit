'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const { createStore } = require('./store.js');
const { createGameApi } = require('./game-api.js');
const { Account } = require('./account.js');
const { computeAlerts, supplies } = require('./alerts.js');
const { scanMarket, searchDirectMarket, estimatePrice, fetchCommodityTickers } = require('./market.js');
const { buildSpeciesIndex } = require('../shared/species.js');
const { classifyCollection } = require('../shared/classifier.js');
const { DiscordNotifier } = require('./discord.js');
const { RouteRunner, buildPresetRoutes } = require('./route-runner.js');
const { calculateBreederMatchups } = require('./breeder.js');

const PORT = Number(process.env.PIW_PORT) || 8787;
const HOST = process.env.PIW_HOST || '0.0.0.0';
const LOCAL_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (LOCAL_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.port === String(PORT);
  } catch { return false; }
}
// A aba abre numa página sem login (Pokepedia); o userscript grava os tokens e segue para /play.
const HANDOFF_URL = 'https://poke.idleworld.online/pokepedia';
const HEARTBEAT_TIMEOUT = 300000; // 5 minutos de tolerancia para background em abas/celular
const CACHE_DIR = path.join(__dirname, '.cache');
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/shared/classifier.js': ['../shared/classifier.js', 'text/javascript; charset=utf-8'],
  '/shared/species.js': ['../shared/species.js', 'text/javascript; charset=utf-8']
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw httpError(413, 'Corpo grande demais.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'JSON inválido.'); }
}

async function loadSpecies(api) {
  const cacheFile = path.join(CACHE_DIR, 'creatures.json');
  try {
    const data = await api.creatures();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data));
    return buildSpeciesIndex(data.creatures);
  } catch (error) {
    if (fs.existsSync(cacheFile)) return buildSpeciesIndex(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).creatures);
    console.warn(`Sem creatures.json (${error.message}); Power e linha evolutiva ficam indisponíveis.`);
    return buildSpeciesIndex([]);
  }
}

function resolveItemIcon(icon) {
  if (!icon) return null;
  if (/^(https?:)?\//.test(icon)) return icon;
  return `/assets/items/${icon}`;
}

async function loadItems(api) {
  const cacheFile = path.join(CACHE_DIR, 'items.json');
  try {
    const data = await api.items();
    const rawList = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(rawList));
    const byId = new Map();
    for (const it of rawList) if (it?.id != null) byId.set(Number(it.id), it);
    return { list: rawList, byId, get: id => byId.get(Number(id)) ?? null };
  } catch (error) {
    if (fs.existsSync(cacheFile)) {
      const rawList = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const byId = new Map();
      for (const it of rawList) if (it?.id != null) byId.set(Number(it.id), it);
      return { list: rawList, byId, get: id => byId.get(Number(id)) ?? null };
    }
    console.warn(`Sem items.json (${error.message}); Metadados de itens ficam indisponíveis.`);
    return { list: [], byId: new Map(), get: () => null };
  }
}

function createApp({ store, api, species, itemsCatalog }) {
  const accounts = new Map();
  const heartbeats = new Map();
  const handoffCodes = new Map();
  const clients = new Set();
  const highlights = [];
  const sessionShinies = [];
  const logs = [];
  const junk = new Map();
  const classifiedCache = new WeakMap();
  let market = null;
  const discord = new DiscordNotifier({ getWebhookUrl: () => process.env.DISCORD_WEBHOOK_URL || store.config?.discordWebhook || null });
  const routeRunners = new Map();

  function getRouteRunner(account) {
    if (!routeRunners.has(account.id)) {
      const runner = new RouteRunner({
        account,
        speciesCatalog: species,
        onLog: pushLog,
        onStatusChange: status => broadcast('route-status', status)
      });
      routeRunners.set(account.id, runner);
    }
    return routeRunners.get(account.id);
  }

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function pushLog(entry) {
    logs.unshift(entry);
    logs.length = Math.min(logs.length, 200);
    broadcast('log', entry);
  }

  function pushShinyEncounter(account, encounter) {
    const prof = encounter.speciesId != null ? species.profile(encounter.speciesId) : null;
    const speciesName = encounter.speciesName ?? prof?.name ?? `Espécie #${encounter.speciesId ?? '?'}`;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: encounter.at || Date.now(),
      accountId: account.id,
      accountName: account.name,
      hunt: account.state.hunt || 'Hunt',
      type: encounter.type, // 'spawn' | 'kill' | 'capture'
      speciesId: encounter.speciesId,
      speciesName,
      loot: encounter.loot ?? null,
      poke: encounter.poke ?? null
    };
    sessionShinies.unshift(entry);
    sessionShinies.length = Math.min(sessionShinies.length, 100);

    broadcast('shiny-encounter', entry);

    const emoji = encounter.type === 'spawn' ? '✨👁️' : encounter.type === 'kill' ? '⚔️✨' : '🔴✨';
    const actionText = encounter.type === 'spawn' ? 'spawnou na hunt' : encounter.type === 'kill' ? 'foi derrotado na hunt' : 'foi capturado!';
    pushLog({
      at: entry.at,
      account: account.id,
      accountName: account.name,
      text: `${emoji} Shiny ${speciesName} ${actionText} (${entry.hunt})`
    });
  }

  function classified(account) {
    const list = account.pokes ?? [];
    if (!classifiedCache.has(list)) {
      classifiedCache.set(list, classifyCollection(list, { familyOf: species.familyOf, config: store.config.tags }));
    }
    return classifiedCache.get(list);
  }

  function junkRecent(id) {
    const cutoff = Date.now() - 2 * 3600000;
    const list = (junk.get(id) ?? []).filter(t => t >= cutoff);
    junk.set(id, list);
    return list.length;
  }

  function summary(account) {
    const snap = account.snapshot();
    const list = account.pokes ? classified(account) : [];
    const leaderProfile = snap.leader?.speciesId != null ? species.profile(snap.leader.speciesId) : null;
    return {
      ...snap,
      autohelper: undefined,
      supplies: snap.autohelper ? supplies(snap) : null,
      leader: snap.leader ? { ...snap.leader, types: leaderProfile?.types ?? [] } : null,
      alerts: computeAlerts(snap, store.config.alerts),
      junkCount: list.filter(p => p.tags.includes('lixo')).length,
      junkRecent: junkRecent(account.id)
    };
  }

  function addAccount(record) {
    accounts.get(record.id)?.stop();
    const account = new Account({
      record, api, getCmid: store.getCmid,
      onTokens: tokens => store.upsert({ id: record.id, tokens })
    });
    account.on('state', () => broadcast('account', summary(account)));
    account.on('pokes', () => broadcast('account', summary(account)));
    account.on('inventory', () => broadcast('inventory', { accountId: account.id }));
    account.on('balls', () => broadcast('inventory', { accountId: account.id }));
    account.on('log', pushLog);
    account.on('hunt', slug => store.upsert({ id: record.id, lastHunt: slug }));
    account.on('leader', lead => store.upsert({ id: record.id, lastLeader: lead }));
    account.on('shiny-encounter', encounter => pushShinyEncounter(account, encounter));
    account.on('capture', ({ at, poke }) => {
      const item = classified(account).find(p => String(p.id) === String(poke.id));
      if (!item) return;
      if (item.shiny) {
        pushShinyEncounter(account, {
          type: 'capture',
          at,
          speciesId: item.speciesId,
          speciesName: item.name,
          poke: item
        });
      }
      if (item.tags.includes('lixo')) {
        junk.set(account.id, [...(junk.get(account.id) ?? []), at]);
        return;
      }
      const hlCfg = store.config.highlight || { minQuality: 1.7, minIv: 130 };
      const isGoodCatch = Boolean(
        item.isDitto ||
        (item.quality != null && item.ivTotal != null &&
         item.quality >= hlCfg.minQuality && item.ivTotal >= hlCfg.minIv)
      );
      if (!isGoodCatch) return;
      const entry = { at, account: account.id, accountName: account.name, poke: { ...item, profile: species.profile(item.speciesId) } };
      highlights.unshift(entry);
      highlights.length = Math.min(highlights.length, 500);
      broadcast('highlight', entry);
      discord.sendHighlight(entry);
    });
    accounts.set(record.id, account);
    broadcast('account', summary(account));
    return account;
  }

  async function registerAccount(tokens, { fromTab }) {
    if (!tokens?.refreshToken) throw httpError(400, 'Faltou o refreshToken.');
    let current = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    if (!current.accessToken) {
      const fresh = await api.refresh(current.refreshToken);
      current = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? current.refreshToken };
    }
    const me = await api.me(current.accessToken);
    const character = me?.character ?? {};
    const name = String(character.name ?? 'Conta');
    const id = String(character.id ?? name).toLowerCase();
    store.upsert({ id, name, tokens: current, lastHunt: store.get(id)?.lastHunt ?? null });
    const existing = accounts.get(id);
    if (fromTab) {
      // A aba que enviou está jogando; o cockpit assume quando ela fechar.
      const account = existing ?? addAccount(store.get(id));
      account.updateTokens(current);
      if (account.state.status !== 'handedOff') account.handOff();
      heartbeats.set(id, Date.now());
    } else {
      addAccount(store.get(id)).start();
    }
    pushLog({ at: Date.now(), account: id, accountName: name, text: 'Conta cadastrada no cockpit.' });
    return { id, name };
  }

  function getAccount(id) {
    const account = accounts.get(id);
    if (!account) throw httpError(404, 'Conta não encontrada.');
    return account;
  }

  function collectionView(account) {
    return classified(account).map(p => ({ ...p, profile: species.profile(p.speciesId) }));
  }

  async function sell(account, requestedIds) {
    if (!account.pokes) throw httpError(409, 'A coleção ainda não carregou.');
    const byId = new Map(classified(account).map(p => [String(p.id), p]));
    const accepted = [];
    const rejected = [];
    for (const id of new Set((requestedIds ?? []).map(String))) {
      const p = byId.get(id);
      if (!p) rejected.push({ id, reason: 'não existe mais' });
      else if (p.team || p.starter || p.locked || p.shiny || p.tags.includes('raro')) rejected.push({ id, reason: 'protegido' });
      else accepted.push(p.id);
    }
    if (!accepted.length) throw httpError(400, 'Nenhum Pokémon da lista pode ser vendido.');
    const result = await account.sell(accepted);
    pushLog({ at: Date.now(), account: account.id, accountName: account.name,
      text: `Vendidos ${result.sold ?? accepted.length} Pokémon por $ ${Number(result.goldGained ?? 0).toLocaleString('pt-BR')}.` });
    return { ...result, rejected };
  }

  function openSession(account) {
    const code = crypto.randomBytes(16).toString('hex');
    handoffCodes.set(code, { accountId: account.id, expires: Date.now() + 60000 });
    account.handOff();
    heartbeats.set(account.id, Date.now());
    pushLog({ at: Date.now(), account: account.id, accountName: account.name, text: 'Sessão aberta no navegador.' });
    const payload = Buffer.from(JSON.stringify({
      accountId: account.id,
      tokens: account.tokens
    })).toString('base64url');
    return { url: `${HANDOFF_URL}#piw_tok=${payload}&piw=${code}` };
  }

  async function startMarket(body) {
    if (market) throw httpError(409, 'Já existe uma busca em andamento.');
    const account = getAccount(body.accountId);
    const controller = new AbortController();
    market = controller;
    try {
      const result = await scanMarket({
        fetchPage: page => account.withAuth(token => api.market(token, page, controller.signal)),
        species, collection: account.pokes ?? [], config: store.config.tags,
        tag: body.tag, element: body.element, sort: body.sort, signal: controller.signal,
        onProgress: (page, count) => broadcast('market-progress', { page, count })
      });
      return { ...result, results: result.results.slice(0, 1000) };
    } catch (error) {
      if (error?.name === 'AbortError') throw httpError(499, 'Busca cancelada.');
      throw error;
    } finally {
      market = null;
    }
  }

  async function fastMarketSearch(body) {
    let account = body.accountId ? accounts.get(body.accountId) : null;
    if (!account) {
      const list = [...accounts.values()].filter(a => a.tokens?.accessToken);
      if (!list.length) throw httpError(400, 'Nenhuma conta conectada para consultar o mercado.');
      account = list[0];
    }
    const params = { browse: 'pokemon', sort: body.sort || 'price-asc', page: String(body.page || 1) };
    if (body.speciesId) params.speciesId = String(body.speciesId);
    else if (body.q) params.q = String(body.q).trim();
    if (body.shiny) params.shiny = '1';
    if (body.ivMin) params.ivMin = String(body.ivMin);
    if (body.lvMin) params.lvMin = String(body.lvMin);

    return await account.withAuth(token => searchDirectMarket({
      fetchDirect: (p, signal) => api.marketSearch(token, p, signal),
      species,
      collection: account.pokes ?? [],
      config: store.config.tags,
      params
    }));
  }

  async function handleEstimatePrice(query) {
    const list = [...accounts.values()].filter(a => a.tokens?.accessToken);
    if (!list.length) throw httpError(400, 'Nenhuma conta conectada para consultar o mercado.');
    const account = list[0];
    const speciesId = query.get('speciesId');
    const q = query.get('q');
    return await account.withAuth(token => estimatePrice({
      fetchDirect: (p, signal) => api.marketSearch(token, p, signal),
      speciesId,
      q
    }));
  }

  let cachedTickers = null;
  let lastTickerFetch = 0;

  async function getCommodityTickers() {
    const now = Date.now();
    if (cachedTickers && now - lastTickerFetch < 30 * 1000) {
      return { ...cachedTickers, history: store.getTickerHistory() };
    }

    const list = [...accounts.values()].filter(a => a.tokens?.accessToken);
    if (!list.length) {
      return cachedTickers
        ? { ...cachedTickers, history: store.getTickerHistory() }
        : { at: now, diamonds: {}, pheromones: {}, history: store.getTickerHistory() };
    }

    const account = list[0];
    try {
      const data = await account.withAuth(token => fetchCommodityTickers({
        fetchCategory: (cat, signal) => api.marketCategory(token, cat, signal)
      }));

      cachedTickers = data;
      lastTickerFetch = now;

      // Persiste snapshot histórico a cada 15 min
      const hist = store.getTickerHistory();
      const lastDia = hist.diamonds[hist.diamonds.length - 1];
      if (!lastDia || now - lastDia.at > 15 * 60 * 1000) {
        if (data.diamonds.minPrice) {
          store.addTickerSnapshot('diamonds', {
            at: now,
            min: data.diamonds.minPrice,
            median: data.diamonds.medianPrice,
            qty: data.diamonds.totalQty
          });
        }
        if (data.pheromones.diamonds.minPrice) {
          store.addTickerSnapshot('pheromones', {
            at: now,
            diaMin: data.pheromones.diamonds.minPrice,
            goldMin: data.pheromones.gold.minPrice,
            diaQty: data.pheromones.diamonds.totalQty
          });
        }
      }

      return { ...cachedTickers, history: store.getTickerHistory() };
    } catch (err) {
      if (cachedTickers) return { ...cachedTickers, history: store.getTickerHistory() };
      throw err;
    }
  }

  let cachedItemsMarket = null;
  let lastItemsMarketFetch = 0;

  function formatItemsMarketSummary(payload, account) {
    const listings = Array.isArray(payload?.listings) ? payload.listings : [];
    const byKey = new Map();

    for (const l of listings) {
      const kind = l.kind || (l.category === 'Pokemon' ? 'pokemon' : 'item');
      if (kind === 'pokemon') continue;
      const refId = Number(l.refId ?? l.id);
      if (!refId) continue;
      const k = `${kind}:${refId}`;
      if (!byKey.has(k)) byKey.set(k, { gold: [], dia: [] });
      const entry = byKey.get(k);
      const price = Number(l.price ?? l.totalPrice) || 0;
      const qty = Number(l.quantity) || 1;
      const currency = String(l.currency || 'GOLD').toUpperCase();
      if (price > 0 && !l.offerOnly) {
        if (currency === 'GOLD') entry.gold.push({ price, qty, sellers: l.sellers || 1 });
        else if (currency === 'DIAMONDS') entry.dia.push({ price, qty, sellers: l.sellers || 1 });
      }
    }

    const summary = {};
    for (const [k, v] of byKey) {
      v.gold.sort((a, b) => a.price - b.price);
      v.dia.sort((a, b) => a.price - b.price);

      const goldPrices = v.gold.map(x => x.price);
      const diaPrices = v.dia.map(x => x.price);
      const totalGoldQty = v.gold.reduce((s, x) => s + x.qty, 0);
      const totalDiaQty = v.dia.reduce((s, x) => s + x.qty, 0);

      summary[k] = {
        minGold: goldPrices[0] ?? null,
        medianGold: goldPrices.length ? goldPrices[Math.floor(goldPrices.length / 2)] : null,
        avgGold: goldPrices.length ? Math.round(goldPrices.reduce((a, b) => a + b, 0) / goldPrices.length) : null,
        totalGoldQty,
        goldDepth: v.gold.slice(0, 10),
        minDia: diaPrices[0] ?? null,
        medianDia: diaPrices.length ? diaPrices[Math.floor(diaPrices.length / 2)] : null,
        avgDia: diaPrices.length ? Math.round(diaPrices.reduce((a, b) => a + b, 0) / diaPrices.length) : null,
        totalDiaQty,
        diaDepth: v.dia.slice(0, 10)
      };
    }

    const mine = Array.isArray(payload?.mine) ? payload.mine.map(m => ({
      id: String(m.id ?? ''),
      refId: Number(m.refId ?? m.id),
      kind: m.kind || 'item',
      name: m.name || m.pokemon?.name || 'Item',
      quantity: Number(m.quantity) || 1,
      price: Number(m.price ?? m.totalPrice),
      currency: String(m.currency ?? 'GOLD').toUpperCase(),
      at: m.at ?? null
    })) : [];

    return { at: Date.now(), summary, mine };
  }

  async function fetchItemsMarketData(accountId) {
    const now = Date.now();
    let account = accountId ? accounts.get(accountId) : null;
    if (!account) {
      const list = [...accounts.values()].filter(a => a.tokens?.accessToken);
      if (!list.length) throw httpError(400, 'Nenhuma conta conectada para consultar o mercado.');
      account = list[0];
    }

    if (cachedItemsMarket && now - lastItemsMarketFetch < 15 * 1000) {
      return formatItemsMarketSummary(cachedItemsMarket, account);
    }

    const payload = await account.withAuth(token => api.marketCategory(token, 'All'));
    cachedItemsMarket = payload;
    lastItemsMarketFetch = now;
    return formatItemsMarketSummary(payload, account);
  }

  async function getAccountBag(account, fresh = false) {
    if (fresh || !account.inventory) {
      await account.fetchBag(1200);
    } else {
      account.refreshBag();
    }

    const rawInv = account.inventory ?? [];
    const rawBalls = account.balls ?? { catalog: [], counts: {} };

    const items = [];
    // 1. Itens comuns da Bag
    for (const inv of rawInv) {
      if (!inv || !inv.quantity || inv.quantity <= 0) continue;
      const meta = itemsCatalog?.get(inv.itemId) || {};
      items.push({
        key: `item:${inv.itemId}`,
        kind: 'item',
        refId: Number(inv.itemId),
        name: meta.name || `Item #${inv.itemId}`,
        category: meta.category || 'loot',
        quantity: Number(inv.quantity),
        npcPrice: meta.npcPrice ?? null,
        priceGold: meta.priceGold ?? null,
        rare: Boolean(meta.rare),
        icon: resolveItemIcon(meta.icon),
        description: meta.description || ''
      });
    }

    // 2. Pokébolas não-vinculadas
    if (Array.isArray(rawBalls.catalog)) {
      for (const b of rawBalls.catalog) {
        const count = Math.floor(Number(rawBalls.counts[String(b.id)] ?? 0));
        if (count > 0 && !b.bound && !b.infinite) {
          items.push({
            key: `ball:${b.id}`,
            kind: 'ball',
            refId: Number(b.id),
            name: b.name || `Ball #${b.id}`,
            category: 'ball',
            quantity: count,
            npcPrice: b.priceGold ? Math.floor(b.priceGold / 2) : 1,
            priceGold: b.priceGold ?? null,
            rare: false,
            icon: resolveItemIcon(b.iconUrl),
            description: `Taxa de captura: x${b.catchRate || 1}`
          });
        }
      }
    }

    items.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    return {
      accountId: account.id,
      accountName: account.name,
      gold: account.state.gold,
      diamonds: account.state.diamonds,
      items
    };
  }

  async function quickSellItems(account, itemsToSell) {
    if (!Array.isArray(itemsToSell) || !itemsToSell.length) throw httpError(400, 'Nenhum item informado para venda.');
    const marketData = await fetchItemsMarketData(account.id);
    const summary = marketData.summary || {};
    const bag = await getAccountBag(account, true);
    const bagMap = new Map(bag.items.map(it => [it.key, it]));

    const results = [];
    for (const req of itemsToSell) {
      const key = `${req.kind || 'item'}:${req.refId}`;
      const bagItem = bagMap.get(key);
      if (!bagItem) {
        results.push({ key, success: false, error: 'Item não encontrado no inventário' });
        continue;
      }

      const qty = Math.min(Math.max(1, Math.floor(Number(req.quantity) || bagItem.quantity)), bagItem.quantity);
      if (qty <= 0) continue;

      const currency = req.currency === 'DIAMONDS' ? 'DIAMONDS' : 'GOLD';
      let price = Number(req.price) || 0;

      if (!price || price <= 0) {
        // Cálculo automático de menor preço
        const marketItem = summary[key];
        const npcFloor = bagItem.npcPrice || 1;
        if (currency === 'GOLD') {
          if (marketItem?.minGold && marketItem.minGold > 1) {
            // 1 Gold a menos que o menor anúncio ativo
            price = Math.max(npcFloor, marketItem.minGold - 1);
          } else if (marketItem?.minGold === 1) {
            price = 1;
          } else {
            price = Math.max(1, npcFloor * 2);
          }
        } else {
          // DIAMONDS
          if (marketItem?.minDia && marketItem.minDia > 1) {
            price = Math.max(1, marketItem.minDia - 1);
          } else {
            price = marketItem?.minDia || 1;
          }
        }
      }

      // Garante piso do NPC para ouro
      if (currency === 'GOLD' && bagItem.npcPrice && price < bagItem.npcPrice) {
        price = bagItem.npcPrice;
      }
      price = Math.max(1, Math.floor(price));

      try {
        await account.listItem({
          kind: req.kind || 'item',
          refId: Number(req.refId),
          quantity: qty,
          price,
          currency
        });

        pushLog({
          at: Date.now(),
          account: account.id,
          accountName: account.name,
          text: `🏷️ Anunciado no mercado: x${qty.toLocaleString('pt-BR')} ${bagItem.name} por ${currency === 'DIAMONDS' ? '💎' : '$'} ${price.toLocaleString('pt-BR')} cada.`
        });

        results.push({ key, name: bagItem.name, quantity: qty, price, currency, success: true });
      } catch (err) {
        results.push({ key, name: bagItem.name, quantity: qty, price, currency, success: false, error: err.message });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    // Invalida cache do mercado e atualiza a bag
    cachedItemsMarket = null;
    account.refreshBag();
    return { results };
  }

  async function cancelListing(account, listingId) {
    if (!listingId) throw httpError(400, 'ID do anúncio obrigatório.');
    const res = await account.withAuth(token => api.marketAction(token, { action: 'cancel', id: String(listingId) }));
    pushLog({
      at: Date.now(),
      account: account.id,
      accountName: account.name,
      text: `✕ Anúncio ${listingId} cancelado no mercado.`
    });
    cachedItemsMarket = null;
    account.refreshBag();
    return res;
  }

  let radarMatches = [];
  const radarSeenIds = new Set();

  async function checkRadar() {
    getCommodityTickers().catch(() => {});
    const list = [...accounts.values()].filter(a => a.tokens?.accessToken);
    if (!list.length) return;
    const account = list[0];
    const wishlist = store.getWishlist();
    if (!wishlist.length) return;

    let newCount = 0;
    for (const rule of wishlist) {
      try {
        const params = { browse: 'pokemon', sort: 'price-asc', page: '1' };
        if (rule.speciesId) params.speciesId = String(rule.speciesId);
        else if (rule.speciesName) params.q = String(rule.speciesName).trim();
        if (rule.shinyOnly) params.shiny = '1';
        if (rule.minIv) params.ivMin = String(rule.minIv);

        const res = await account.withAuth(token => api.marketSearch(token, params));
        const rawListings = Array.isArray(res?.listings) ? res.listings : (Array.isArray(res) ? res : []);
        for (const item of rawListings) {
          const price = Number(item.price ?? item.totalPrice) || 0;
          if (rule.maxPrice && price > rule.maxPrice) continue;
          if (item.offerOnly && rule.maxPrice) continue;
          if (rule.minQuality && (item.quality == null || Number(item.quality) < Number(rule.minQuality))) continue;
          if (rule.minIv && ((item.ivTotal ?? item.iv) < Number(rule.minIv))) continue;
          if (rule.currency && String(item.currency).toUpperCase() !== String(rule.currency).toUpperCase()) continue;
          const matchKey = `${rule.id}:${item.id}`;
          if (!radarSeenIds.has(matchKey)) {
            radarSeenIds.add(matchKey);
            newCount++;
            radarMatches.unshift({
              id: matchKey,
              ruleId: rule.id,
              ruleName: rule.name,
              listingId: item.id,
              name: item.name ?? item.pokemonName ?? 'Pokémon',
              speciesId: item.speciesId,
              level: item.level,
              ivTotal: item.ivTotal ?? item.iv,
              quality: item.quality,
              price,
              currency: String(item.currency ?? 'GOLD').toUpperCase(),
              shiny: Boolean(item.shiny),
              foundAt: Date.now()
            });
          }
        }
      } catch {
        // Ignora erro passageiro de rede
      }
    }

    if (radarMatches.length > 50) radarMatches = radarMatches.slice(0, 50);
    if (newCount > 0) {
      broadcast('radar', { matches: radarMatches, newCount });
    }
  }

  // Radar interval desativado a pedido do usuario
  // const radarInterval = setInterval(checkRadar, 5 * 60 * 1000);
  // setTimeout(checkRadar, 15000);

  function rememberCmid(cmid) {
    if (store.setCmid(cmid)) pushLog({ at: Date.now(), text: 'Impressão desta máquina (cmid) registrada; vale a partir da próxima conexão.' });
  }

  async function bridge(req, res, p) {
    if (req.method === 'POST' && p === '/api/bridge/register') {
      const body = await readBody(req);
      rememberCmid(body.cmid);
      return sendJson(res, 200, await registerAccount(body.tokens, { fromTab: true }));
    }
    const claim = p.match(/^\/api\/bridge\/claim\/([a-f0-9]{32})$/);
    if (req.method === 'GET' && claim) {
      const entry = handoffCodes.get(claim[1]);
      handoffCodes.delete(claim[1]);
      const account = entry && entry.expires >= Date.now() ? accounts.get(entry.accountId) : null;
      if (!account) throw httpError(404, 'Código expirado ou inválido. Clique em Abrir sessão de novo.');
      heartbeats.set(account.id, Date.now());
      return sendJson(res, 200, { accountId: account.id, name: account.name, tokens: account.tokens });
    }
    console.log('[BRIDGE]', req.method, p, 'from:', req.socket.remoteAddress);
    if (req.method === 'POST' && p === '/api/bridge/heartbeat') {
      const body = await readBody(req);
      rememberCmid(body.cmid);
      const account = getAccount(body.accountId);
      account.updateTokens(body.tokens);
      if (body.lastHunt) account.setHunt(body.lastHunt);
      if (account.state.status === 'replaced') account.handOff();
      if (account.state.status === 'handedOff') heartbeats.set(account.id, Date.now());
      if (body.telemetry && typeof account.applyTelemetry === 'function') {
        account.applyTelemetry(body.telemetry);
      }
      return sendJson(res, 200, { ok: true, status: account.state.status });
    }
    if (req.method === 'POST' && p === '/api/bridge/telemetry') {
      const body = await readBody(req);
      rememberCmid(body.cmid);
      const account = getAccount(body.accountId);
      if (body.tokens) account.updateTokens(body.tokens);
      if (account.state.status === 'replaced') account.handOff();
      if (account.state.status === 'handedOff') heartbeats.set(account.id, Date.now());
      if (typeof account.applyTelemetry === 'function') {
        account.applyTelemetry(body.telemetry);
      }
      return sendJson(res, 200, { ok: true, status: account.state.status });
    }
    if (req.method === 'POST' && p === '/api/bridge/release') {
      const body = await readBody(req);
      const account = getAccount(body.accountId);
      heartbeats.set(account.id, 0);
      if (body.lastHunt) account.setHunt(body.lastHunt);
      if (account.state.status === 'handedOff') {
        account.resume();
        pushLog({ at: Date.now(), account: account.id, accountName: account.name, text: 'Aba do jogo fechada; Cockpit reassumiu.' });
      }
      return sendJson(res, 200, { ok: true });
    }
    throw httpError(404, 'Rota da ponte não encontrada.');
  }

  async function route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-PIW-Bridge, Access-Control-Request-Private-Network',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/piw.user.js') {
      const host = req.headers.host || `localhost:${PORT}`;
      const scriptPath = path.join(__dirname, '../userscript/piw.user.js');
      let content = fs.readFileSync(scriptPath, 'utf8');
      content = content.replace(/http:\/\/localhost:8787/g, `http://${host}`);
      content = content.replace(/\/\/ @connect\s+localhost/, `// @connect      localhost\n// @connect      ${host.split(':')[0]}`);
      res.writeHead(200, {
        'Content-Type': 'text/x-userscript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(content);
    }

    if (p.startsWith('/api/bridge/')) {
      if (p !== '/api/bridge/release' && req.headers['x-piw-bridge'] !== '1') throw httpError(403, 'Pedido da ponte sem cabeçalho.');
      return bridge(req, res, p);
    }

    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) throw httpError(403, 'Origem não permitida.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !origin) throw httpError(403, 'Origem ausente.');

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        accounts: [...accounts.values()].map(summary),
        routes: [...accounts.values()].map(a => getRouteRunner(a).getStatus()),
        highlights, shinies: sessionShinies, logs,
        warnings: store.warnings, config: store.config
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      return sendJson(res, 200, await registerAccount(await readBody(req), { fromTab: false }));
    }
    if (req.method === 'GET' && p === '/api/routes/presets') {
      const accountId = url.searchParams.get('accountId');
      const account = accountId ? accounts.get(accountId) : [...accounts.values()][0];
      const ownedSpeciesSet = new Set();
      if (account?.pokes) {
        for (const poke of account.pokes) {
          if (poke?.speciesId) ownedSpeciesSet.add(Number(poke.speciesId));
        }
      }
      return sendJson(res, 200, {
        presets: buildPresetRoutes(species.all ? species.all() : [], ownedSpeciesSet)
      });
    }
    if (req.method === 'GET' && p === '/api/routes/custom') {
      return sendJson(res, 200, { presets: store.getCustomPresets() });
    }
    if (req.method === 'POST' && p === '/api/routes/custom') {
      const body = await readBody(req);
      const saved = store.saveCustomPreset(body);
      return sendJson(res, 200, { ok: true, preset: saved });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/routes/custom/')) {
      const presetId = p.slice('/api/routes/custom/'.length);
      store.deleteCustomPreset(presetId);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/species') {
      return sendJson(res, 200, {
        species: species.all ? species.all().map(c => ({ pokeId: c.pokeId, name: c.name, type1: c.type1, type2: c.type2 })) : []
      });
    }
    if (req.method === 'POST' && p === '/api/market/search') return sendJson(res, 200, await fastMarketSearch(await readBody(req)));
    if (req.method === 'GET' && p === '/api/market/estimate') return sendJson(res, 200, await handleEstimatePrice(url.searchParams));
    if (req.method === 'POST' && p === '/api/market/scan') return sendJson(res, 200, await startMarket(await readBody(req)));
    if (req.method === 'POST' && p === '/api/market/cancel') { market?.abort(); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/api/market/tickers') return sendJson(res, 200, await getCommodityTickers());
    if (req.method === 'GET' && p === '/api/items/catalog') return sendJson(res, 200, { items: itemsCatalog.list });
    if (req.method === 'GET' && p === '/api/market/items-summary') return sendJson(res, 200, await fetchItemsMarketData(url.searchParams.get('accountId')));
    if (req.method === 'POST' && p === '/api/market/sell-item') {
      const body = await readBody(req);
      const account = getAccount(body.accountId);
      return sendJson(res, 200, await quickSellItems(account, [body]));
    }
    if (req.method === 'POST' && p === '/api/market/quick-sell') {
      const body = await readBody(req);
      const account = getAccount(body.accountId);
      return sendJson(res, 200, await quickSellItems(account, body.items || []));
    }
    if (req.method === 'POST' && p === '/api/market/cancel-item') {
      const body = await readBody(req);
      const account = getAccount(body.accountId);
      return sendJson(res, 200, await cancelListing(account, body.listingId));
    }

    if (req.method === 'GET' && p === '/api/radar') return sendJson(res, 200, { wishlist: store.getWishlist(), matches: radarMatches });
    if (req.method === 'POST' && p === '/api/radar/wishlist') {
      const rule = store.addWishlistRule(await readBody(req));
      checkRadar().catch(() => {});
      return sendJson(res, 200, { ok: true, rule });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/radar/wishlist/')) {
      const id = decodeURIComponent(p.replace('/api/radar/wishlist/', ''));
      store.removeWishlistRule(id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/radar/check') {
      await checkRadar();
      return sendJson(res, 200, { ok: true, matches: radarMatches });
    }
    if (req.method === 'POST' && p === '/api/radar/clear') {
      radarMatches = [];
      broadcast('radar', { matches: [], newCount: 0 });
      return sendJson(res, 200, { ok: true });
    }

    const m = p.match(/^\/api\/accounts\/([^/]+)(?:\/([a-z0-9_-]+))?$/);
    if (!m) throw httpError(404, 'Rota não encontrada.');
    const account = getAccount(decodeURIComponent(m[1]));
    const action = m[2];
    if (req.method === 'DELETE' && !action) {
      account.stop();
      accounts.delete(account.id);
      store.remove(account.id);
      broadcast('removed', { id: account.id });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && action === 'pokes') return sendJson(res, 200, { pokes: collectionView(account) });
    if (req.method === 'GET' && action === 'breeder') {
      return sendJson(res, 200, calculateBreederMatchups({
        collection: account.pokes ?? [],
        species,
        minMatrizIv: Number(store.config.tags?.matrizIv) || 150,
        minGoodQuality: 1.60
      }));
    }
    if (req.method === 'GET' && action === 'bag') {
      const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('force') === '1';
      return sendJson(res, 200, await getAccountBag(account, fresh));
    }
    if (req.method === 'GET' && action === 'route') {
      const runner = getRouteRunner(account);
      return sendJson(res, 200, runner.getStatus());
    }
    if (req.method === 'POST' && action === 'route-start') {
      const body = await readBody(req);
      const runner = getRouteRunner(account);
      runner.start(body);
      return sendJson(res, 200, runner.getStatus());
    }
    if (req.method === 'POST' && action === 'route-pause') {
      const runner = getRouteRunner(account);
      runner.pause();
      return sendJson(res, 200, runner.getStatus());
    }
    if (req.method === 'POST' && action === 'route-resume') {
      const runner = getRouteRunner(account);
      runner.resume();
      return sendJson(res, 200, runner.getStatus());
    }
    if (req.method === 'POST' && action === 'route-skip') {
      const runner = getRouteRunner(account);
      runner.skipCurrent();
      return sendJson(res, 200, runner.getStatus());
    }
    if (req.method === 'POST' && action === 'route-stop') {
      const runner = getRouteRunner(account);
      runner.stop(true);
      return sendJson(res, 200, runner.getStatus());
    }
    if (req.method === 'POST' && action === 'sell') return sendJson(res, 200, await sell(account, (await readBody(req)).pokeIds));
    if (req.method === 'POST' && action === 'lock') {
      const body = await readBody(req);
      await account.lock(body.pokeId, Boolean(body.locked));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'open') return sendJson(res, 200, openSession(account));
    if (req.method === 'POST' && action === 'reconnect') {
      heartbeats.set(account.id, 0);
      account.resume();
      pushLog({ at: Date.now(), account: account.id, accountName: account.name, text: 'Reconectado pelo usuário no Cockpit.' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'hunt') {
      const body = await readBody(req);
      if (!body.slug) throw httpError(400, 'Slug da hunt obrigatório.');
      account.setHunt(body.slug, body.name);
      account.send({ type: 'enter-hunt', slug: body.slug });
      pushLog({ at: Date.now(), account: account.id, accountName: account.name, text: `Hunt alterada para ${body.name ?? body.slug}.` });
      return sendJson(res, 200, { ok: true, hunt: body.slug });
    }
    throw httpError(404, 'Rota não encontrada.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) return res.end();
      const status = error.status && error.name !== 'GameApiError' ? error.status : error.name === 'GameApiError' ? 502 : 500;
      sendJson(res, status, { error: error.message });
    });
  });

  // Quando a aba do jogo para de dar sinal, o cockpit reassume a conta.
  setInterval(() => {
    for (const [id, account] of accounts) {
      if (account.state.status === 'handedOff' && Date.now() - (heartbeats.get(id) ?? 0) > HEARTBEAT_TIMEOUT) {
        pushLog({ at: Date.now(), account: id, accountName: account.name, text: 'A aba do jogo fechou; o cockpit reassumiu.' });
        account.resume();
      }
    }
    for (const [code, entry] of handoffCodes) if (entry.expires < Date.now()) handoffCodes.delete(code);
    for (const account of accounts.values()) {
      const sum = summary(account);
      broadcast('account', sum);
      if (sum.alerts?.length) {
        for (const al of sum.alerts) discord.sendAlert(account.name, account.id, al.key, al.text, al.level);
      }
    }
  }, 15000);

  return {
    server,
    startAll() {
      for (const record of store.list()) addAccount(record).start();
    }
  };
}

async function main() {
  const api = createGameApi();
  const store = createStore(__dirname);
  const species = await loadSpecies(api);
  const itemsCatalog = await loadItems(api);
  const app = createApp({ store, api, species, itemsCatalog });
  app.server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`Cockpit em ${url} (${species.size} espécies, ${itemsCatalog.list.length} itens carregados).`);
    for (const warning of store.warnings) console.warn(warning);
    if (process.platform === 'win32' && !process.env.PIW_NO_OPEN) exec(`start "" ${url}`);
    app.startAll();
  });
}

if (require.main === module) main();

module.exports = { createApp };
