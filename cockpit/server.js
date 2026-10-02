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
const { scanMarket } = require('./market.js');
const { buildSpeciesIndex } = require('../shared/species.js');
const { classifyCollection } = require('../shared/classifier.js');
const { DiscordNotifier } = require('./discord.js');

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
const HIGHLIGHT_TAGS = new Set(['raro', 'top', 'matriz']);
const HEARTBEAT_TIMEOUT = 90000;
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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

function createApp({ store, api, species }) {
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

    if (discord) {
      discord.sendAlert(
        account.name,
        account.id,
        'shiny',
        `✨ **SHINY ${encounter.type.toUpperCase()}!** Pokémon: ${speciesName} (${entry.hunt})`,
        'success'
      );
    }
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
    account.on('log', pushLog);
    account.on('hunt', slug => store.upsert({ id: record.id, lastHunt: slug }));
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
      if (!item.tags.some(t => HIGHLIGHT_TAGS.has(t))) return;
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
    return { url: `${HANDOFF_URL}#piw=${code}` };
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
    if (req.method === 'POST' && p === '/api/bridge/heartbeat') {
      const body = await readBody(req);
      rememberCmid(body.cmid);
      const account = getAccount(body.accountId);
      heartbeats.set(account.id, Date.now());
      account.updateTokens(body.tokens);
      if (body.lastHunt) account.setHunt(body.lastHunt);
      if (account.state.status === 'replaced') account.handOff();
      return sendJson(res, 200, { ok: true, status: account.state.status });
    }
    if (req.method === 'POST' && p === '/api/bridge/release') {
      const body = await readBody(req);
      const account = getAccount(body.accountId);
      heartbeats.set(account.id, 0);
      if (body.lastHunt) account.setHunt(body.lastHunt);
      setTimeout(() => { if (account.state.status === 'handedOff') account.resume(); }, 3000);
      return sendJson(res, 200, { ok: true });
    }
    throw httpError(404, 'Rota da ponte não encontrada.');
  }

  async function route(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }

    if (req.method === 'GET' && p === '/piw.user.js') {
      const host = req.headers.host || `localhost:${PORT}`;
      const scriptPath = path.join(__dirname, '../userscript/piw.user.js');
      let content = fs.readFileSync(scriptPath, 'utf8');
      content = content.replace(/http:\/\/localhost:8787/g, `http://${host}`);
      content = content.replace(/\/\/ @connect\s+localhost/, `// @connect      localhost\n// @connect      ${host.split(':')[0]}`);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(content);
    }

    if (p.startsWith('/api/bridge/')) {
      if (req.headers['x-piw-bridge'] !== '1') throw httpError(403, 'Pedido da ponte sem cabeçalho.');
      return bridge(req, res, p);
    }

    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) throw httpError(403, 'Origem não permitida.');
    if (req.method !== 'GET' && !origin) throw httpError(403, 'Origem ausente.');

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        accounts: [...accounts.values()].map(summary), highlights, shinies: sessionShinies, logs,
        warnings: store.warnings, config: store.config
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      return sendJson(res, 200, await registerAccount(await readBody(req), { fromTab: false }));
    }
    if (req.method === 'POST' && p === '/api/market/scan') return sendJson(res, 200, await startMarket(await readBody(req)));
    if (req.method === 'POST' && p === '/api/market/cancel') { market?.abort(); return sendJson(res, 200, { ok: true }); }

    const m = p.match(/^\/api\/accounts\/([^/]+)(?:\/([a-z]+))?$/);
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
    if (req.method === 'POST' && action === 'sell') return sendJson(res, 200, await sell(account, (await readBody(req)).pokeIds));
    if (req.method === 'POST' && action === 'lock') {
      const body = await readBody(req);
      await account.lock(body.pokeId, Boolean(body.locked));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'open') return sendJson(res, 200, openSession(account));
    if (req.method === 'POST' && action === 'reconnect') {
      account.resume();
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
  const app = createApp({ store, api, species });
  app.server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`Cockpit em ${url} (${species.size} espécies carregadas).`);
    for (const warning of store.warnings) console.warn(warning);
    if (process.platform === 'win32' && !process.env.PIW_NO_OPEN) exec(`start "" ${url}`);
    app.startAll();
  });
}

if (require.main === module) main();

module.exports = { createApp };
