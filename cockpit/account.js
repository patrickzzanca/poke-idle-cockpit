'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { socketUrl } = require('./ws-url.js');

const SAMPLES_DIR = path.join(__dirname, '.cache', 'samples');
const FATAL_CODES = {
  4003: 'Jogo em manutenção.',
  4006: 'Limite de conexões por IP atingido.',
  4007: 'Limite de conexões por máquina atingido.',
  4008: 'Nome bloqueado: entre no jogo para resolver.',
  4009: 'O jogo pede troca de senha: entre no jogo.'
};
const SESSION_EXPIRED = 'Sessão expirou: faça login no jogo e envie a conta para o cockpit de novo.';

// Guarda a mensagem mais recente de cada tipo (no máximo 1 gravação a cada 10 s por tipo),
// para conferir formatos com dados reais.
const lastSampleAt = new Map();
function recordSample(message) {
  try {
    const type = String(message?.type ?? 'sem-tipo').replace(/[^a-z0-9_-]/gi, '_');
    if (Date.now() - (lastSampleAt.get(type) ?? 0) < 10000) return;
    lastSampleAt.set(type, Date.now());
    const file = path.join(SAMPLES_DIR, `${type}.json`);
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(message, null, 2));
  } catch { /* amostras são opcionais */ }
}

class Account extends EventEmitter {
  constructor({ record, api, onTokens, getCmid = () => null }) {
    super();
    this.getCmid = getCmid;
    this.id = record.id;
    this.name = record.name;
    this.tokens = record.tokens;
    this.lastHunt = record.lastHunt ?? null;
    this.api = api;
    this.onTokens = onTokens;
    this.socket = null;
    this.stopped = true;
    this.retries = 0;
    this.authFailures = 0;
    this.timers = { reconnect: null, ping: null, status: null, hunt: null, analyzer: null, huntFallback: null };
    this.activeShinies = new Set();
    this.lastMessageAt = 0;
    this.pingSentAt = 0;
    this.pokes = null;
    this.state = {
      status: 'offline', error: null, offlineSince: Date.now(),
      gold: null, diamonds: null, trainer: { name: record.name, level: null },
      leader: null, hunt: this.lastHunt, box: null, autohelper: null,
      leaderFainted: false, cooldownUntil: null, analyzer: null, lastKillAt: null, connectedAt: null
    };
  }

  sessionExpiresAt() {
    try {
      const { exp } = JSON.parse(Buffer.from(this.tokens.refreshToken.split('.')[1], 'base64url').toString('utf8'));
      return exp ? exp * 1000 : null;
    } catch { return null; }
  }

  snapshot() {
    return { id: this.id, name: this.name, ...this.state, pokeCount: this.pokes?.length ?? null, sessionExpiresAt: this.sessionExpiresAt() };
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.emit('state', this.snapshot());
  }

  log(text) {
    this.emit('log', { at: Date.now(), account: this.id, accountName: this.name, text });
  }

  start() {
    this.stopped = false;
    return this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
    this.setState({ status: 'offline', offlineSince: Date.now() });
  }

  handOff() {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
    this.setState({ status: 'handedOff', error: null });
  }

  resume() {
    if (!this.stopped) return;
    this.retries = 0;
    this.authFailures = 0;
    this.start();
  }

  updateTokens(tokens) {
    if (!tokens?.accessToken || !tokens?.refreshToken) return;
    if (tokens.accessToken === this.tokens.accessToken && tokens.refreshToken === this.tokens.refreshToken) return;
    this.tokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    this.onTokens?.(this.tokens);
  }

  // Renova uma vez por dia para estender a sessão (os tokens do jogo valem 7 dias).
  async refreshIfOld() {
    try {
      const { iat } = JSON.parse(Buffer.from(this.tokens.accessToken.split('.')[1], 'base64url').toString('utf8'));
      if (!iat || Date.now() - iat * 1000 < 24 * 3600000) return;
      await this.refreshTokens();
      this.log('Sessão renovada.');
    } catch (error) {
      if (error.status) this.log(`Não consegui renovar a sessão (${error.message}).`);
    }
  }

  async refreshTokens() {
    const fresh = await this.api.refresh(this.tokens.refreshToken);
    if (!fresh?.accessToken) throw Object.assign(new Error('Resposta de refresh sem accessToken.'), { status: 401 });
    this.updateTokens({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? this.tokens.refreshToken });
  }

  async withAuth(call) {
    try {
      return await call(this.tokens.accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      await this.refreshTokens();
      return call(this.tokens.accessToken);
    }
  }

  async loadCharacter() {
    const data = await this.withAuth(token => this.api.me(token));
    const c = data?.character ?? {};
    this.setState({
      gold: c.gold ?? this.state.gold,
      diamonds: c.diamonds ?? this.state.diamonds,
      trainer: { name: c.name ?? this.name, level: c.level ?? c.lvl ?? this.state.trainer.level }
    });
  }

  async connect() {
    if (this.stopped) return;
    this.clearTimers();
    this.setState({ status: 'connecting', offlineSince: this.state.offlineSince ?? Date.now() });
    try {
      await this.refreshIfOld();
      await this.loadCharacter();
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) return this.fail(SESSION_EXPIRED);
      return this.scheduleReconnect(error.message);
    }
    if (!this.stopped) this.openSocket();
  }

  openSocket() {
    const socket = new WebSocket(socketUrl(this.tokens.accessToken, { cmid: this.getCmid() }));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retries = 0;
      this.lastMessageAt = Date.now();
      this.pingSentAt = 0;
      this.setState({ status: 'online', error: null, offlineSince: null, connectedAt: Date.now() });
      this.log('Conectada.');
      for (const type of ['pokes-get', 'autohelper-get', 'balls-get', 'analyzer-get']) this.send({ type });
      // Aguarda hunt-resume do servidor para respeitar a hunt iniciada no navegador.
      // Se após 3s o servidor não enviar hunt-resume nem field-init, usa a última hunt conhecida.
      clearTimeout(this.timers.huntFallback);
      this.timers.huntFallback = setTimeout(() => {
        if (!this.state.lastKillAt && this.lastHunt) {
          this.send({ type: 'enter-hunt', slug: this.lastHunt });
          this.log(`Retomando hunt salva (${this.lastHunt}).`);
        }
      }, 3000);
      this.timers.ping = setInterval(() => this.checkAlive(), 10000);
      this.timers.analyzer = setInterval(() => this.send({ type: 'analyzer-get' }), 30000);
      this.timers.status = setInterval(() => {
        this.send({ type: 'autohelper-get' });
        this.loadCharacter().catch(() => {});
        this.refreshIfOld();
      }, 60000);
    };
    socket.onmessage = event => { if (this.socket === socket) this.handleRaw(event.data); };
    socket.onclose = event => { if (this.socket === socket) this.handleClose(event.code); };
    socket.onerror = () => { try { socket.close(); } catch { /* já fechado */ } };
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  // Mesma regra do cliente oficial: ping após 45 s de silêncio, fecha se não houver resposta em 15 s.
  checkAlive() {
    const now = Date.now();
    if (this.pingSentAt) {
      if (this.lastMessageAt >= this.pingSentAt) this.pingSentAt = 0;
      else if (now - this.pingSentAt > 15000) {
        this.pingSentAt = 0;
        try { this.socket?.close(); } catch { /* já fechado */ }
      }
      return;
    }
    if (now - this.lastMessageAt > 45000) {
      this.pingSentAt = now;
      this.send({ type: 'ping' });
    }
  }

  handleClose(code) {
    this.socket = null;
    this.clearTimers();
    if (this.stopped) return;
    if (code === 4005) {
      this.stopped = true;
      this.setState({ status: 'replaced', error: 'Conta aberta em outro lugar. Clique em Reconectar para retomar aqui.' });
      this.log('Sessão substituída (conta aberta em outro lugar).');
      return;
    }
    if (FATAL_CODES[code]) return this.fail(FATAL_CODES[code]);
    if (code === 4001) {
      if (++this.authFailures >= 2) return this.fail(SESSION_EXPIRED);
      this.refreshTokens().then(() => this.connect(), error => {
        if (error.status) this.fail(SESSION_EXPIRED);
        else this.scheduleReconnect(error.message);
      });
      return;
    }
    this.scheduleReconnect(`Conexão caiu (código ${code}).`);
  }

  fail(message) {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
    this.setState({ status: 'error', error: message });
    this.log(message);
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    this.retries++;
    const base = Math.min(24000, 1500 * 2 ** Math.min(this.retries - 1, 4));
    const delay = base + Math.floor(Math.random() * base);
    this.setState({ status: 'offline', error: reason, offlineSince: this.state.offlineSince ?? Date.now() });
    this.log(`${reason} Nova tentativa em ${Math.round(delay / 1000)} s.`);
    this.timers.reconnect = setTimeout(() => this.connect(), delay);
  }

  clearTimers() {
    clearTimeout(this.timers.reconnect);
    clearTimeout(this.timers.hunt);
    clearTimeout(this.timers.huntFallback);
    clearInterval(this.timers.ping);
    clearInterval(this.timers.status);
    clearInterval(this.timers.analyzer);
    this.timers = { reconnect: null, ping: null, status: null, hunt: null, analyzer: null, huntFallback: null };
    this.activeShinies.clear();
  }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* já fechado */ }
  }

  handleRaw(data) {
    this.lastMessageAt = Date.now();
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    recordSample(message);
    switch (message.type) {
      case 'pokes':
        this.authFailures = 0;
        this.applyPokes(Array.isArray(message.list) ? message.list : []);
        break;
      case 'poke-delta':
        this.applyDelta(message.poke);
        break;
      case 'poke-xp':
        this.applyXp(message);
        break;
      case 'autohelper':
        this.setState({
          autohelper: message,
          box: message.pokeCapacity ? { count: message.pokeCount ?? 0, capacity: message.pokeCapacity } : this.state.box
        });
        break;
      case 'hunt-resume':
        clearTimeout(this.timers.huntFallback);
        // O servidor informa onde a conta estava caçando; o cliente oficial viaja até lá e entra na hunt.
        if (message.slug) {
          this.setHunt(String(message.slug), message.name);
          this.send({ type: 'enter-hunt', slug: this.lastHunt });
          this.log(`Voltando para a hunt ${message.name ?? message.slug}.`);
        }
        break;
      case 'field-init':
        clearTimeout(this.timers.huntFallback);
        if (message.slug) this.setHunt(String(message.slug), message.name);
        this.setState({ leaderFainted: false });
        break;
      case 'hunt-cooldown':
      case 'fishing-cooldown': {
        const slug = this.lastHunt;
        if (!slug) break;
        const ms = Math.max(0, Number(message.ms) || 0);
        this.setState({ cooldownUntil: Date.now() + ms });
        clearTimeout(this.timers.hunt);
        this.timers.hunt = setTimeout(() => {
          this.setState({ cooldownUntil: null });
          this.send({ type: 'enter-hunt', slug });
        }, ms + 100);
        break;
      }
      case 'field':
        if (Array.isArray(message.mobs)) {
          const currentSlots = new Set();
          for (const mob of message.mobs) {
            if (mob && mob.shiny && !mob.dead && !mob.respawning) {
              const key = `${mob.slot}:${mob.speciesId}`;
              currentSlots.add(key);
              if (!this.activeShinies.has(key)) {
                this.activeShinies.add(key);
                this.emit('shiny-encounter', {
                  type: 'spawn',
                  at: Date.now(),
                  speciesId: mob.speciesId,
                  slot: mob.slot
                });
                this.log(`✨ SHINY SPAWNOU NA HUNT! (Espécie #${mob.speciesId})`);
              }
            }
          }
          for (const key of this.activeShinies) {
            if (!currentSlots.has(key)) this.activeShinies.delete(key);
          }
        }
        break;
      case 'field-kill':
        this.setState({ lastKillAt: Date.now(), leaderFainted: false });
        if (message.shiny) {
          this.emit('shiny-encounter', {
            type: 'kill',
            at: Date.now(),
            speciesId: message.speciesId,
            speciesName: message.speciesName,
            loot: message.loot
          });
          this.log(`⚔️✨ SHINY DERROTADO: ${message.speciesName ?? message.speciesId}!`);
        }
        break;
      case 'analyzer': {
        // Estatísticas da sessão calculadas pelo servidor (mesma janela "Analisador" do jogo).
        const seconds = Number(message.seconds) || 0;
        const photoValue = Number(message.photoNpcGold) || 0;
        const profit = (Number(message.balance) || 0) + (Number(message.photos) || 0) * photoValue;
        this.setState({
          analyzer: {
            seconds, kills: message.kills ?? 0, killsPerHour: message.killsPerHour ?? 0,
            xpGained: message.xpGained ?? 0, xpPerHour: message.xpPerHour ?? 0,
            captures: message.captures ?? 0, shinyCaptures: message.shinyCaptures ?? 0,
            lootGold: message.lootGold ?? 0, supplyGold: message.supplyGold ?? 0,
            ballsUsed: message.ballsUsed ?? 0, potionsUsed: message.potionsUsed ?? 0,
            profit, profitPerHour: seconds > 0 ? Math.round(profit / seconds * 3600) : 0
          }
        });
        break;
      }
      case 'trade-settled':
        this.send({ type: 'pokes-get' });
        break;
    }
  }

  setHunt(slug, name) {
    const changed = slug !== this.lastHunt;
    if (changed) this.emit('hunt', slug);
    this.lastHunt = slug;
    // field-init só traz o slug; mantém o nome bonito do hunt-resume quando a hunt é a mesma.
    if (name) this.setState({ hunt: String(name) });
    else if (changed || !this.state.hunt) this.setState({ hunt: slug });
  }

  applyPokes(list) {
    const previous = this.pokes;
    this.pokes = list;
    if (previous) {
      const known = new Set(previous.map(p => p?.id));
      for (const poke of list) if (poke && !known.has(poke.id)) this.emit('capture', { at: Date.now(), poke });
    }
    this.updateLeader();
    this.emit('pokes', this.pokes);
  }

  applyDelta(poke) {
    if (!poke?.id || !this.pokes) return;
    const i = this.pokes.findIndex(p => p?.id === poke.id);
    if (i >= 0) {
      this.pokes = this.pokes.slice();
      this.pokes[i] = poke;
    } else {
      const teamCount = this.pokes.filter(p => p?.team).length;
      this.pokes = [...this.pokes.slice(0, teamCount), poke, ...this.pokes.slice(teamCount)];
      this.emit('capture', { at: Date.now(), poke });
    }
    this.updateLeader();
    this.emit('pokes', this.pokes);
  }

  applyXp(message) {
    if (!message.id || !this.pokes) return;
    const i = this.pokes.findIndex(p => p?.id === message.id);
    if (i < 0) return;
    this.pokes = this.pokes.slice();
    this.pokes[i] = { ...this.pokes[i], xp: message.xp ?? this.pokes[i].xp, level: message.level ?? this.pokes[i].level };
    if (this.pokes[i].team) this.updateLeader();
  }

  updateLeader() {
    const leader = this.pokes?.find(p => p?.leader) ?? this.pokes?.find(p => p?.team) ?? null;
    this.setState({
      leader: leader ? {
        name: leader.name, level: leader.level, quality: leader.quality, ivTotal: leader.ivTotal,
        speciesId: leader.speciesId ?? leader.pokeId ?? null, shiny: Boolean(leader.shiny),
        hp: leader.hp ?? null, maxHp: leader.maxHp ?? null
      } : null
    });
  }

  async sell(pokeIds) {
    const result = await this.withAuth(token => this.api.sell(token, pokeIds));
    if (result?.gold != null) this.setState({ gold: result.gold });
    this.send({ type: 'pokes-get' });
    this.send({ type: 'autohelper-get' });
    return result;
  }

  async lock(id, locked) {
    await this.withAuth(token => this.api.lock(token, id, locked));
    if (this.pokes) {
      this.pokes = this.pokes.map(p => p?.id === id ? { ...p, locked } : p);
      this.emit('pokes', this.pokes);
    }
  }
}

module.exports = { Account };
